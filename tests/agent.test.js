// 智能体：工具调用循环、只读查库守卫、技能、对话附件、自定义 HTML 工具。
// 设了 DH_REAL_BASE 时，查库工具的 SQL 会在真实 MySQL 8 上执行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockBaseServer } from './helpers/mock-base.js';

const as = (user) => ({ cookie: `iLearningXUserName=${user}` });
const json = (headers = {}) => ({ 'Content-Type': 'application/json', ...headers });

test('智能体：查库回答问题、越权 SQL 被拦、技能、附件与 HTML 工具', async () => {
    const mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        APP_SCHEMA: 'agent-test',
        APP_UUID: 'agent-test',
        APP_DATASOURCE_ID: '2',
    });
    delete process.env.DH_OPEN_ADMIN;
    delete process.env.DH_ADMIN_USERS;
    const dao = await import('../src/dao/scoped.js');
    const { TOOLS } = await import('../src/agent/tools.js');
    const { createServer } = await import('../src/server.js');
    const app = await createServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const chat = async (user, body) => {
        const res = await fetch(`${url}/api/ai/chat`, { method: 'POST', headers: json(as(user)), body: JSON.stringify({ stream: true, ...body }) });
        assert.equal(res.status, 200);
        return (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    };

    try {
        // alice 第一个进来 → 管理员；bob 是普通用户
        assert.equal((await (await fetch(`${url}/api/auth/me`, { headers: as('alice') })).json()).isAdmin, true);
        assert.equal((await (await fetch(`${url}/api/auth/me`, { headers: as('bob') })).json()).isAdmin, false);

        // 入库一期报表数据
        await dao.insertRow('report_snapshots', { snapshot_id: 'snap-oct', month: 10, created_at: '2026-10-31 18:00:00', stored_at: Date.now(), standard_total_score: 86.5 });
        await dao.insertRow('report_category_scores', { snapshot_id: 'snap-oct', month: 10, cat_name: '整改', base_score: 40, manual_score: 0, final_score: 40 });
        await dao.insertRow('report_metric_data', { snapshot_id: 'snap-oct', month: 10, cat_name: '整改', metric_label: '整改闭环率', target_val: '95%', raw_val: '91.2%', num_val: 91.2, is_failing: 1, gap: '-3.8%', earned_score: 18, weight: 20 });
        await dao.insertRow('report_metric_data', { snapshot_id: 'snap-oct', month: 10, cat_name: '整改', metric_label: '按期完成率', target_val: '90%', raw_val: '96%', num_val: 96, is_failing: 0, gap: '+6%', earned_score: 20, weight: 20 });

        const cfg = await fetch(`${url}/api/ai-settings/profiles`, {
            method: 'POST', headers: json(as('alice')),
            body: JSON.stringify({ name: 'MockLLM', baseUrl: `${mock.baseUrl}/v1`, apiKey: 'test-key-000', model: 'test-model', activate: true }),
        });
        assert.equal(cfg.status, 201);

        // ── 1. 一轮并行调用三个工具（其中一个越权），第二轮给出回答 ──
        mock.aiRequests.length = 0;
        mock.aiScript.push(
            { text: '我先查一下数据。', toolCalls: [
                { name: 'get_report_overview', args: {} },
                { name: 'query_database', args: { sql: "SELECT metric_label, num_val FROM report_metric_data WHERE snapshot_id = 'snap-oct' AND is_failing = 1" } },
                { name: 'query_database', args: { sql: 'SELECT * FROM ai_settings_profiles' } },
            ] },
            { text: '本期有 1 项未达标：整改闭环率 91.2%（目标 95%）。' },
        );
        const events = await chat('bob', { messages: [{ role: 'user', content: '这个月哪些指标没达标？' }] });
        const starts = events.filter((e) => e.type === 'tool_start');
        const results = events.filter((e) => e.type === 'tool_result');
        assert.deepEqual(starts.map((e) => e.tool), ['get_report_overview', 'query_database', 'query_database']);
        assert.equal(results.length, 3);
        const byCall = Object.fromEntries(results.map((r) => [r.callId, r]));
        assert.equal(byCall[starts[0].callId].ok, true);
        assert.match(byCall[starts[0].callId].summary, /2 项指标，1 项未达标/);
        assert.equal(byCall[starts[1].callId].ok, true);
        assert.equal(byCall[starts[2].callId].ok, false, '查密钥表必须被拒绝');
        const done = events.find((e) => e.type === 'done');
        assert.match(done.reply, /整改闭环率 91\.2%/);
        assert.equal(done.usage.inputTokens, 200);
        assert.ok(events.some((e) => e.type === 'start' && e.sessionId === done.sessionId));

        // 第二轮请求里，模型拿到了三个工具结果；越权那个是拒绝说明而不是数据
        const second = mock.aiRequests[1];
        const toolMsgs = second.messages.filter((m) => m.role === 'tool');
        assert.equal(toolMsgs.length, 3);
        assert.match(toolMsgs[0].content, /整改闭环率/);
        assert.match(toolMsgs[2].content, /不在可查询范围内|不允许查询/);
        assert.doesNotMatch(JSON.stringify(second.messages), /test-key-000/);
        assert.equal(second.tools.some((t) => t.function.name === 'query_database'), true);
        // 系统提示里带着表目录，模型不必先花一轮查结构
        assert.match(second.messages[0].content, /report_metric_data\(/);

        // 回放：消息连同工具事件一起落库，且只有本人能看
        const saved = await (await fetch(`${url}/api/ai/sessions/${done.sessionId}/messages`, { headers: as('bob') })).json();
        const modelMsg = saved.items.find((m) => m.role === 'model');
        if (!modelMsg?.events) console.log('DEBUG saved', JSON.stringify(saved).slice(0, 1500));
        assert.equal(modelMsg.events.filter((e) => e.type === 'tool_result').length, 3);
        assert.equal((await fetch(`${url}/api/ai/sessions/${done.sessionId}/messages`, { headers: as('alice') })).status, 404);

        // ── 2. 只读守卫：各种绕过写法都要拦住，正常查询放行 ──
        const query = TOOLS.find((t) => t.name === 'query_database');
        const ctx = { identity: { username: 'bob', isAdmin: false, identified: true }, emit() {} };
        const blocked = [
            'SELECT * FROM report_snapshots; DROP TABLE report_snapshots',
            'DELETE FROM report_snapshots',
            'UPDATE report_snapshots SET month = 1',
            'SELECT * FROM sys_kv_store',
            'SELECT * FROM `sys_kv_store`',
            'SELECT * FROM report_snapshots, ai_chat_messages',
            'SELECT * FROM report_snapshots r JOIN (SELECT * FROM ai_settings_profiles) x ON 1 = 1',
            'SELECT 1 /*!50000 UNION SELECT kv_value FROM sys_kv_store */',
            'SELECT * FROM report_snapshots -- x',
            'SELECT * FROM information_schema.tables',
            "SELECT * FROM report_snapshots INTO OUTFILE '/tmp/x'",
            'SELECT SLEEP(5) FROM report_snapshots',
            'SELECT * FROM report_snapshots FOR UPDATE',
            'SELECT (SELECT kv_value FROM sys_kv_store LIMIT 1) FROM report_snapshots',
            'SHOW TABLES',
            'SELECT * FROM dh_chunks',
            'SELECT * FROM mysql.user',
        ];
        for (const sql of blocked) {
            const out = await query.run({ sql }, ctx);
            assert.equal(out.ok, false, `应被拦截：${sql}`);
        }
        const allowed = [
            "SELECT cat_name, COUNT(*) AS n FROM report_metric_data WHERE metric_label <> 'delete; drop' GROUP BY cat_name",
            'WITH f AS (SELECT snapshot_id, COUNT(*) AS n FROM report_metric_data WHERE is_failing = 1 GROUP BY snapshot_id) SELECT s.snapshot_id, f.n FROM report_snapshots s JOIN f ON f.snapshot_id = s.snapshot_id',
            'SELECT s.snapshot_id, c.cat_name FROM report_snapshots AS s LEFT JOIN report_category_scores c ON c.snapshot_id = s.snapshot_id ORDER BY s.id DESC LIMIT 5',
        ];
        for (const sql of allowed) {
            const out = await query.run({ sql }, ctx);
            assert.equal(out.ok, true, `应放行：${sql} → ${out.content}`);
        }

        // ── 3. 技能：内置技能可见；保存需要管理员；@技能 把步骤带进系统提示 ──
        const skills = await (await fetch(`${url}/api/agent-skills`, { headers: as('bob') })).json();
        assert.ok(skills.items.some((s) => s.id === 'data-check' && s.builtIn));
        const md = '---\nid: weekly-brief\nname: 周报摘要\ndescription: 把本周指标变化整理成三句话\nicon: 🗒\n---\n先调用 get_report_overview，再输出三句话摘要，口令：蓝莓松饼。';
        assert.equal((await fetch(`${url}/api/agent-skills`, { method: 'POST', headers: json(as('bob')), body: JSON.stringify({ skillMd: md }) })).status, 403);
        const savedSkill = await fetch(`${url}/api/agent-skills`, { method: 'POST', headers: json(as('alice')), body: JSON.stringify({ skillMd: md }) });
        assert.equal(savedSkill.status, 200);
        assert.equal((await fetch(`${url}/api/agent-skills`, { method: 'POST', headers: json(as('alice')), body: JSON.stringify({ skillMd: md }) })).status, 409, '重名不带 overwrite 要提示');
        assert.equal((await fetch(`${url}/api/agent-skills`, { method: 'POST', headers: json(as('alice')), body: JSON.stringify({ skillMd: md.replace('weekly-brief', 'data-check') }) })).status, 409, '不能占用内置技能标识');
        assert.ok((await (await fetch(`${url}/api/ai/skills`, { headers: as('bob') })).json()).items.some((s) => s.id === 'weekly-brief'));

        mock.aiRequests.length = 0;
        mock.aiScript.push({ text: '好的。' });
        const skillEvents = await chat('bob', { messages: [{ role: 'user', content: '@weekly-brief 给我本周摘要' }] });
        assert.deepEqual(skillEvents.find((e) => e.type === 'skills').skills, ['weekly-brief']);
        assert.match(mock.aiRequests[0].messages[0].content, /蓝莓松饼/);
        assert.match(mock.aiRequests[0].messages[0].content, /"id":"data-check"/);

        // ── 4. 附件：上传 → read_file 读到内容；别人读不到、下不了 ──
        const form = new FormData();
        form.append('files', new Blob(['工单号,状态\nRT-1,进行中\nRT-2,已关闭\n'], { type: 'text/csv' }), '工单.csv');
        const up = await (await fetch(`${url}/api/ai/uploads`, { method: 'POST', headers: as('bob'), body: form })).json();
        assert.equal(up.files[0].name, '工单.csv');
        assert.match(up.files[0].path, /^uploads\/[a-z0-9]+\/工单\.csv$/);
        const read = TOOLS.find((t) => t.name === 'read_file');
        assert.match((await read.run({ path: up.files[0].path }, ctx)).content, /RT-2,已关闭/);
        assert.equal((await read.run({ path: up.files[0].path }, { ...ctx, identity: { username: 'alice', isAdmin: true } })).ok, false);
        const raw = `${url}/api/agent-files/raw?path=${encodeURIComponent(up.files[0].path)}`;
        assert.equal((await fetch(raw, { headers: as('bob') })).status, 200);
        assert.equal((await fetch(raw, { headers: as('alice') })).status, 404);

        // ── 5. HTML 工具：对话里发布；普通用户的只有自己可见；页面在沙箱里 ──
        mock.aiScript.push(
            { toolCalls: [{ name: 'publish_html_tool', args: { name: '百分比计算器', description: '算占比', icon: '🧮', html: '<!doctype html><html><head><title>t</title></head><body><h1>calc</h1><script>document.title="ok"</script></body></html>' } }] },
            { text: '已发布。' },
        );
        const pubEvents = await chat('bob', { messages: [{ role: 'user', content: '发布吧' }] });
        const pub = pubEvents.find((e) => e.type === 'tool_result');
        assert.equal(pub.ok, true);
        assert.doesNotMatch(JSON.stringify(pubEvents.find((e) => e.type === 'tool_start').args), /<script>/, '工具行里不回显整段 HTML');
        const mine = await (await fetch(`${url}/api/custom-tools`, { headers: as('bob') })).json();
        assert.equal(mine.length, 1);
        assert.equal(mine[0].name, '百分比计算器');
        assert.equal(mine[0].visibility, 'private');
        assert.equal((await (await fetch(`${url}/api/custom-tools`, { headers: as('carol') })).json()).length, 0);
        const page = await fetch(`${url}${mine[0].href}`, { headers: as('bob') });
        assert.equal(page.status, 200);
        assert.match(await page.text(), /<iframe src="raw" sandbox="allow-scripts/);
        const rawPage = await fetch(`${url}${mine[0].href}raw`, { headers: as('bob') });
        assert.match(rawPage.headers.get('content-security-policy'), /^sandbox allow-scripts/);
        assert.doesNotMatch(rawPage.headers.get('content-security-policy'), /allow-same-origin/);
        assert.equal((await fetch(`${url}${mine[0].href}raw`, { headers: as('carol') })).status, 404);
        assert.equal((await fetch(`${url}/api/custom-tools/${mine[0].slug}`, { method: 'DELETE', headers: as('carol') })).status, 404);
        // 管理员发布的所有人可见
        const pubAdmin = await fetch(`${url}/api/custom-tools`, { method: 'POST', headers: json(as('alice')), body: JSON.stringify({ name: '公共工具', htmlContent: '<html><body>hi</body></html>' }) });
        assert.equal(pubAdmin.status, 201);
        assert.ok((await (await fetch(`${url}/api/custom-tools`, { headers: as('carol') })).json()).some((t) => t.name === '公共工具'));
        assert.equal((await fetch(`${url}/api/custom-tools/${mine[0].slug}`, { method: 'DELETE', headers: as('bob') })).status, 200);

        // ── 6. 模型服务报错时，把原因告诉用户而不是“内部错误” ──
        mock.aiScript.length = 0;
        await fetch(`${url}/api/ai-settings/profiles`, {
            method: 'POST', headers: json(as('alice')),
            body: JSON.stringify({ name: 'Broken', baseUrl: `${mock.baseUrl}/no-such-path`, apiKey: 'k', model: 'm', activate: true }),
        });
        const errEvents = await chat('bob', { messages: [{ role: 'user', content: '你好' }] });
        assert.match(errEvents.find((e) => e.type === 'error').error, /模型服务 HTTP 404/);

        assert.deepEqual(mock.sqlErrors, []);
    } finally {
        await app.close();
        await mock.close();
    }
});
