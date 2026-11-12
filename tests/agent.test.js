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
    // 边读流边处理事件（审批卡需要在流还没结束时点按钮）
    const chatLive = async (user, body, onEvent) => {
        const res = await fetch(`${url}/api/ai/chat`, { method: 'POST', headers: json(as(user)), body: JSON.stringify({ stream: true, ...body }) });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const events = [];
        let buf = '';
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                let i;
                while ((i = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, i).trim();
                    buf = buf.slice(i + 1);
                    if (!line) continue;
                    const ev = JSON.parse(line);
                    events.push(ev);
                    await onEvent?.(ev);
                }
            }
        } finally {
            // 断言失败时也要断开连接，服务端才会取消等待中的确认
            await reader.cancel().catch(() => {});
        }
        return events;
    };
    // 只看对话请求（新对话还会并行发一次起标题的非流式请求）
    const streamReqs = () => mock.aiRequests.filter((r) => r.stream);
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
        const second = streamReqs()[1];
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
        assert.match(streamReqs()[0].messages[0].content, /蓝莓松饼/);
        assert.match(streamReqs()[0].messages[0].content, /"id":"data-check"/);

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

        // ── 5b. 任务清单、提问、精确计算、长期记忆、抓取脚本 ──
        mock.aiRequests.length = 0;
        mock.aiScript.push(
            { toolCalls: [
                { name: 'update_plan', args: { items: [{ content: '取数', status: 'in_progress' }, { content: '计算', status: 'pending' }, { content: '汇报', status: 'pending' }] } },
                { name: 'calculate', args: { expressions: ['change_percent(80,92)', 'workdays_between("2026-10-01","2026-10-31")', 'constructor(1)'] } },
                { name: 'memory', args: { action: 'add', content: '回答里的百分比保留两位小数' } },
                { name: 'memory', args: { action: 'add', content: '我的密码是 hunter2abc' } },
                { name: 'save_uiv_script', args: { name: '工单列表', url: 'https://example.invalid/api/list', method: 'post', code: 'fetch("https://example.invalid/api/list")' } },
            ] },
            { toolCalls: [{ name: 'ask_user', args: { question: '按哪个口径统计？', options: ['按网络', '按责任人'] } }] },
        );
        const ev5 = await chat('bob', { messages: [{ role: 'user', content: '帮我算一下增幅' }] });
        assert.equal(ev5.find((e) => e.type === 'plan').items.length, 3);
        assert.ok(!ev5.some((e) => e.type === 'tool_start' && ['update_plan', 'ask_user'].includes(e.tool)), '清单和提问不占工具行');
        const calcMsg = streamReqs()[1].messages.filter((m) => m.role === 'tool')[1].content;
        assert.deepEqual(JSON.parse(calcMsg).map((r) => r.result ?? 'ERR'), [15, 22, 'ERR']);
        const res5 = Object.fromEntries(ev5.filter((e) => e.type === 'tool_result').map((e) => [e.tool + ':' + e.summary, e.ok]));
        assert.equal(res5['memory:已记住 #1'], true);
        assert.equal(res5['memory:未保存'], false, '凭据不能进记忆');
        assert.equal(res5['save_uiv_script:需要管理员权限'], false);
        const q = ev5.find((e) => e.type === 'question');
        assert.deepEqual(q.options, ['按网络', '按责任人']);
        assert.equal(ev5.find((e) => e.type === 'done').reply, '按哪个口径统计？');
        assert.equal(streamReqs().length, 2, '提问后本轮结束，不再调用模型');

        // 记忆跨对话生效，且只属于本人
        mock.aiRequests.length = 0;
        mock.aiScript.push({ text: '好。' }, { text: '好。' });
        await chat('bob', { messages: [{ role: 'user', content: '你好' }] });
        assert.match(streamReqs()[0].messages[0].content, /百分比保留两位小数/);
        await chat('alice', { messages: [{ role: 'user', content: '你好' }] });
        assert.doesNotMatch(streamReqs()[1].messages[0].content, /百分比保留两位小数/);

        // 管理员能通过对话保存抓取脚本，随后能列出来；请求头里的凭据不给模型
        mock.aiRequests.length = 0;
        mock.aiScript.push(
            { toolCalls: [{ name: 'save_uiv_script', args: { name: '工单列表', url: 'https://example.invalid/api/list', method: 'post', code: 'fetch("https://example.invalid/api/list")' } }] },
            { toolCalls: [{ name: 'list_uiv_scripts', args: { keyword: '工单' } }] },
            { text: '已保存。' },
        );
        const ev6 = await chat('alice', { messages: [{ role: 'user', content: '保存这个脚本' }] });
        assert.deepEqual(ev6.filter((e) => e.type === 'tool_result').map((e) => e.ok), [true, true]);
        assert.match(streamReqs()[2].messages.filter((m) => m.role === 'tool').at(-1).content, /"name":"工单列表"/);

        // 输出被长度上限截断时自动续写
        mock.aiRequests.length = 0;
        mock.aiScript.push({ text: '第一段，', finish: 'length' }, { text: '第二段。' });
        const ev7 = await chat('bob', { messages: [{ role: 'user', content: '写长一点' }] });
        assert.equal(ev7.find((e) => e.type === 'done').reply, '第一段，第二段。');

        // 增强提示词
        mock.aiScript.length = 0;
        const enh = await (await fetch(`${url}/api/ai/enhance-prompt`, { method: 'POST', headers: json(as('bob')), body: JSON.stringify({ prompt: '指标咋样' }) })).json();
        assert.equal(enh.enhanced, 'OK');

        // ── 7. 表格分析：上传 CSV，服务端分组聚合 ──
        const csvForm = new FormData();
        csvForm.append('files', new Blob(['工单号,网络,状态,时长\nRT-1,A,进行中,"1,200"\nRT-2,B,已关闭,30\nRT-3,A,已关闭,45.5\nRT-4,A,进行中,\n'], { type: 'text/csv' }), '工单统计.csv');
        const csvUp = (await (await fetch(`${url}/api/ai/uploads`, { method: 'POST', headers: as('bob'), body: csvForm })).json()).files[0];
        mock.aiRequests.length = 0;
        mock.aiScript.push(
            { toolCalls: [{ name: 'query_data', args: { path: csvUp.path } }, { name: 'query_data', args: { path: csvUp.path, group_by: ['网络'], aggregates: [{ fn: 'count' }, { fn: 'sum', column: '时长' }], order_by: [{ column: 'count', desc: true }] } }] },
            { text: 'A 网络 3 单。' },
        );
        await chat('bob', { messages: [{ role: 'user', content: '按网络统计工单' }] });
        const qd = streamReqs()[1].messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
        assert.equal(qd[0].mode, 'describe');
        assert.equal(qd[0].rowCount, 4);
        assert.deepEqual(qd[1].rows, [{ 网络: 'A', count: 3, 'sum(时长)': 1245.5 }, { 网络: 'B', count: 1, 'sum(时长)': 30 }]);

        // ── 8. 看图：消息里的图片直接附给模型；模型不支持看图时去掉图片继续回答 ──
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
        const imgForm = new FormData();
        imgForm.append('files', new Blob([png], { type: 'image/png' }), '截图.png');
        const imgUp = (await (await fetch(`${url}/api/ai/uploads`, { method: 'POST', headers: as('bob'), body: imgForm })).json()).files[0];
        const withImage = `这张图里是什么？\n\n📎 附件：\n- [截图.png](<${imgUp.path}>)`;
        mock.aiRequests.length = 0;
        mock.aiScript.push({ text: '是一个像素。' });
        await chat('bob', { messages: [{ role: 'user', content: withImage }] });
        const parts = streamReqs()[0].messages.at(-1).content;
        assert.ok(Array.isArray(parts) && parts.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')));
        mock.options.rejectImages = true;
        mock.aiRequests.length = 0;
        mock.aiScript.push({ text: '看不到图，但可以描述你的问题。' });
        const noVision = await chat('bob', { messages: [{ role: 'user', content: withImage }] });
        mock.options.rejectImages = false;
        assert.ok(noVision.some((e) => e.type === 'status' && /不支持看图/.test(e.status)));
        assert.equal(noVision.find((e) => e.type === 'done').reply, '看不到图，但可以描述你的问题。');
        assert.match(streamReqs().at(-1).messages.at(-1).content, /当前模型不支持看图/);

        // ── 9. 脱敏：工具结果里的口令、密钥不进模型 ──
        const secretForm = new FormData();
        secretForm.append('files', new Blob(['服务器配置\npassword=Abc12345!\napi_key: sk-proj-abcdefghijklmnopqrst\n']), '配置.txt');
        const secretUp = (await (await fetch(`${url}/api/ai/uploads`, { method: 'POST', headers: as('bob'), body: secretForm })).json()).files[0];
        mock.aiRequests.length = 0;
        mock.aiScript.push({ toolCalls: [{ name: 'read_file', args: { path: secretUp.path } }] }, { text: '好。' });
        await chat('bob', { messages: [{ role: 'user', content: '看下配置' }] });
        const readBack = streamReqs()[1].messages.find((m) => m.role === 'tool').content;
        assert.match(readBack, /服务器配置/);
        assert.doesNotMatch(readBack, /Abc12345|abcdefghijklmnopqrst/);

        // ── 10. 写操作审批：普通用户直接被拒；管理员看到确认卡，允许才执行，拒绝不执行，别人批不了 ──
        mock.aiScript.push({ toolCalls: [{ name: 'update_database_rows', args: { table: 'report_metric_data', values: { target_val: '93%' }, where: "metric_label = '整改闭环率'" } }] }, { text: '不行。' });
        const bobWrite = await chat('bob', { messages: [{ role: 'user', content: '把目标改成 93%' }] });
        assert.ok(!bobWrite.some((e) => e.type === 'approval'));
        assert.equal(bobWrite.find((e) => e.type === 'tool_result')?.ok ?? false, false);

        mock.aiScript.push({ toolCalls: [{ name: 'update_database_rows', args: { table: 'report_metric_data', values: { target_val: '93%' }, where: "metric_label = '整改闭环率'" } }] }, { text: '已修改。' });
        let intruder = 0;
        let previewTitle = '';
        const allowEvents = await chatLive('alice', { messages: [{ role: 'user', content: '把目标改成 93%' }] }, async (ev) => {
            if (ev.type !== 'approval') return;
            previewTitle = ev.preview.title;
            intruder = (await fetch(`${url}/api/agent-workspace/approvals/${ev.id}`, { method: 'POST', headers: json(as('bob')), body: JSON.stringify({ decision: 'allow' }) })).status;
            assert.equal((await fetch(`${url}/api/agent-workspace/approvals/${ev.id}`, { method: 'POST', headers: json(as('alice')), body: JSON.stringify({ decision: 'allow' }) })).status, 200);
        });
        assert.equal(previewTitle, '修改 report_metric_data 中 1 行');
        assert.equal(intruder, 404, '别人不能替你确认');
        assert.equal(allowEvents.find((e) => e.type === 'approval_result').decision, 'allow');
        assert.equal(allowEvents.find((e) => e.type === 'tool_result').ok, true);
        assert.equal((await dao.selectTable('report_metric_data', { whereSql: "`metric_label` = '整改闭环率'", limit: 1, memFilter: () => true }))[0].target_val, '93%');

        mock.aiScript.push({ toolCalls: [{ name: 'delete_database_rows', args: { table: 'report_metric_data', where: "snapshot_id = 'snap-oct'" } }] }, { text: '已取消。' });
        const denyEvents = await chatLive('alice', { messages: [{ role: 'user', content: '删掉这期数据' }] }, async (ev) => {
            if (ev.type === 'approval') await fetch(`${url}/api/agent-workspace/approvals/${ev.id}`, { method: 'POST', headers: json(as('alice')), body: JSON.stringify({ decision: 'deny' }) });
        });
        assert.equal(denyEvents.find((e) => e.type === 'approval_result').decision, 'deny');
        assert.equal((await dao.selectTable('report_metric_data', { whereSql: "`snapshot_id` = 'snap-oct'", limit: 10, memFilter: () => true })).length, 2, '拒绝后数据不变');
        // 越界：不在可写范围的表、整表条件
        mock.aiScript.push({ toolCalls: [{ name: 'delete_database_rows', args: { table: 'sys_kv_store', where: "kv_key = 'dh_admins'" } }, { name: 'delete_database_rows', args: { table: 'report_metric_data', where: '1=1' } }] }, { text: '不行。' });
        const guardEvents = await chat('alice', { messages: [{ role: 'user', content: '清空' }] });
        assert.ok(!guardEvents.some((e) => e.type === 'approval'));
        assert.deepEqual(guardEvents.filter((e) => e.type === 'tool_result').map((e) => e.ok), [false, false]);

        // ── 11. 长对话：窗口外的旧消息攒够就压缩成摘要，新对话由模型起标题 ──
        mock.aiScript.length = 0;
        const first = await chat('carol', { messages: [{ role: 'user', content: '第 1 问' }] });
        const sid = first.find((e) => e.type === 'done').sessionId;
        assert.equal(first.find((e) => e.type === 'title')?.title, 'OK');
        mock.aiRequests.length = 0;
        await chat('carol', { sessionId: sid, messages: [{ role: 'user', content: '第 2 问' }] });
        await chat('carol', { sessionId: sid, messages: [{ role: 'user', content: '第 3 问' }] });
        // 前端只带了 1 条，服务端补上了窗口外还没压缩的 4 条
        assert.equal(streamReqs().at(-1).messages.filter((m) => m.role !== 'system').length, 5);
        const fourth = await chat('carol', { sessionId: sid, messages: [{ role: 'user', content: '第 4 问' }] });
        const comp = fourth.filter((e) => e.type === 'compaction');
        assert.deepEqual(comp.map((e) => e.phase), ['start', 'done']);
        assert.equal(comp[1].summarized, 6);
        const lastStream = streamReqs().at(-1);
        assert.match(lastStream.messages[0].content, /之前的对话摘要/);
        assert.equal(lastStream.messages.filter((m) => m.role !== 'system').length, 1);
        const compact = async () => (await fetch(`${url}/api/ai/compact`, { method: 'POST', headers: json(as('carol')), body: JSON.stringify({ sessionId: sid }) })).json();
        assert.equal((await compact()).performed, false, '刚压缩过，没有新内容可压');
        await chat('carol', { sessionId: sid, messages: [{ role: 'user', content: '第 5 问' }] });
        const manual = await compact();
        assert.equal(manual.performed, true);
        assert.equal(manual.summarized, 2);
        assert.equal((await fetch(`${url}/api/ai/compact`, { method: 'POST', headers: json(as('bob')), body: JSON.stringify({ sessionId: sid }) })).status, 404);

        // ── 12. 定时任务：创建、到点执行写进对话、取消；看不懂的时间给出提示 ──
        const { runDueSchedules } = await import('../src/services/schedule-service.js');
        const created = await fetch(`${url}/api/ai/schedules`, { method: 'POST', headers: json(as('bob')), body: JSON.stringify({ text: '10分钟后 汇总一下未达标指标', timezone: 'Asia/Shanghai' }) });
        assert.equal(created.status, 201);
        const sched = (await created.json()).item;
        assert.equal(sched.kind, 'once');
        assert.equal(sched.instruction, '汇总一下未达标指标');
        assert.equal((await (await fetch(`${url}/api/ai/schedules`, { headers: as('alice') })).json()).items.length, 0, '只看得到自己的');
        mock.aiScript.push({ toolCalls: [{ name: 'delete_database_rows', args: { table: 'report_metric_data', where: "snapshot_id = 'snap-oct'" } }] }, { text: '整改闭环率未达标。' });
        const ran = await runDueSchedules(new Date(Date.now() + 11 * 60_000));
        assert.deepEqual(ran, [{ ran: true }]);
        const after = (await (await fetch(`${url}/api/ai/schedules`, { headers: as('bob') })).json()).items.find((x) => x.id === sched.id);
        assert.equal(after.status, 'done');
        assert.equal(after.lastStatus, 'ok');
        assert.equal(after.lastReply, '整改闭环率未达标。');
        assert.match(mock.aiRequests.filter((r) => r.messages?.some((m) => m.role === 'tool')).at(-1).messages.find((m) => m.role === 'tool').content, /无人值守/);
        const schedMsgs = (await (await fetch(`${url}/api/ai/sessions/${after.sessionId}/messages`, { headers: as('bob') })).json()).items;
        assert.deepEqual(schedMsgs.map((m) => m.role), ['user', 'model']);
        assert.equal((await runDueSchedules(new Date(Date.now() + 11 * 60_000))).length, 0, '执行过的不会再跑');
        const daily = (await (await fetch(`${url}/api/ai/schedules`, { method: 'POST', headers: json(as('bob')), body: JSON.stringify({ text: '每天 9:00 看一下待办' }) })).json()).item;
        assert.equal(daily.kind, 'recurring');
        assert.equal((await fetch(`${url}/api/ai/schedules/${daily.id}`, { method: 'DELETE', headers: as('alice') })).status, 404);
        assert.equal((await (await fetch(`${url}/api/ai/schedules/${daily.id}`, { method: 'DELETE', headers: as('bob') })).json()).item.status, 'cancelled');
        const bad = await fetch(`${url}/api/ai/schedules`, { method: 'POST', headers: json(as('bob')), body: JSON.stringify({ text: '有空的时候 看看' }) });
        assert.equal(bad.status, 400);
        assert.match((await bad.json()).error, /没认出时间/);

        // ── 13. HTML 工具数据桥：只读、权限同查看者、页面禁止联网 ──
        const bridgeTool = await (await fetch(`${url}/api/custom-tools`, { method: 'POST', headers: json(as('alice')), body: JSON.stringify({ name: '指标看板', htmlContent: '<html><head><title>x</title></head><body>hi</body></html>' }) })).json();
        const rawTool = await fetch(`${url}${bridgeTool.href}raw`, { headers: as('bob') });
        assert.match(rawTool.headers.get('content-security-policy'), /connect-src 'none'/);
        assert.doesNotMatch(rawTool.headers.get('content-security-policy'), /allow-popups|allow-same-origin/);
        assert.match(await rawTool.text(), /<head><script>[\s\S]*window\.DH=/);
        const bridge = (body) => fetch(`${url}${bridgeTool.href}bridge`, { method: 'POST', headers: json(as('bob')), body: JSON.stringify(body) });
        const bq = await (await bridge({ method: 'query', params: { sql: 'SELECT COUNT(*) AS n FROM report_metric_data' } })).json();
        assert.equal(Number(bq.rows[0].n), 2);
        assert.equal((await bridge({ method: 'query', params: { sql: 'SELECT * FROM ai_settings_profiles' } })).status, 400);
        assert.equal((await bridge({ method: 'query', params: { sql: 'DELETE FROM report_metric_data' } })).status, 400);
        assert.equal((await (await bridge({ method: 'me' })).json()).username, 'bob');
        assert.equal((await (await bridge({ method: 'report' })).json()).failingCount, 1);

        // ── 6. 模型服务报错时，把原因告诉用户而不是“内部错误” ──
        mock.aiScript.length = 0;
        await fetch(`${url}/api/ai-settings/profiles`, {
            method: 'POST', headers: json(as('alice')),
            body: JSON.stringify({ name: 'Broken', baseUrl: `${mock.baseUrl}/no-such-path`, apiKey: 'k', model: 'm', activate: true }),
        });
        const errEvents = await chat('bob', { messages: [{ role: 'user', content: '你好' }] });
        assert.match(errEvents.find((e) => e.type === 'error').error, /模型服务 HTTP 404/);

        // ── 14. 打开「主模型异常时自动切换」后，换到其他可用方案继续回答 ──
        const sw = await (await fetch(`${url}/api/ai-settings/`, { method: 'PUT', headers: json(as('alice')), body: JSON.stringify({ autoSwitchEnabled: true }) })).json();
        assert.equal(sw.autoSwitchEnabled, true);
        mock.aiScript.push({ text: '备用模型回答。' });
        const swEvents = await chat('bob', { messages: [{ role: 'user', content: '你好' }] });
        assert.ok(swEvents.some((e) => e.type === 'status' && /已切换到「MockLLM」/.test(e.status)));
        const swDone = swEvents.find((e) => e.type === 'done');
        assert.equal(swDone.reply, '备用模型回答。');
        assert.equal(swDone.model.name, 'test-model');

        assert.deepEqual(mock.sqlErrors, []);
    } finally {
        await app.close();
        await mock.close();
    }
});
