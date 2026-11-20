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

        // read_database_table 支持 order_by 倒序与 offset 分页，未读完时明确给出 hasMore / nextOffset
        const readTable = TOOLS.find((t) => t.name === 'read_database_table');
        const page1 = JSON.parse((await readTable.run({ table: 'report_metric_data', order_by: 'id DESC', limit: 1, offset: 0 }, ctx)).content);
        assert.equal(page1.rows.length, 1);
        assert.equal(page1.rows[0].metric_label, '按期完成率');
        assert.equal(page1.hasMore, true);
        assert.equal(page1.nextOffset, 1);
        assert.match(page1.note || '', /nextOffset=1/);
        const page2 = JSON.parse((await readTable.run({ table: 'report_metric_data', order_by: 'id DESC', limit: 1, offset: 1 }, ctx)).content);
        assert.equal(page2.rows.length, 1);
        assert.equal(page2.rows[0].metric_label, '整改闭环率');
        assert.equal(page2.hasMore, false);
        assert.equal(page2.nextOffset, null);

        // ── 3. 技能：未全员开放前仅超级管理员可见/可用；开放后全员可在列表和 @技能 中使用 ──
        const aliceSkills = await (await fetch(`${url}/api/agent-skills`, { headers: as('alice') })).json();
        assert.ok(aliceSkills.items.some((s) => s.id === 'data-check' && s.builtIn));
        const bobSkills0 = await (await fetch(`${url}/api/agent-skills`, { headers: as('bob') })).json();
        assert.equal(bobSkills0.items.some((s) => s.id === 'data-check'), false, '未开放的内置技能普通用户不可见');
        const md = '---\nid: weekly-brief\nname: 周报摘要\ndescription: 把本周指标变化整理成三句话\nicon: 🗒\n---\n先调用 get_report_overview，再输出三句话摘要，口令：蓝莓松饼。';
        assert.equal((await fetch(`${url}/api/agent-skills`, { method: 'POST', headers: json(as('bob')), body: JSON.stringify({ skillMd: md }) })).status, 403);
        const savedSkill = await fetch(`${url}/api/agent-skills`, { method: 'POST', headers: json(as('alice')), body: JSON.stringify({ skillMd: md }) });
        assert.equal(savedSkill.status, 200);
        assert.equal((await fetch(`${url}/api/agent-skills`, { method: 'POST', headers: json(as('alice')), body: JSON.stringify({ skillMd: md }) })).status, 409, '重名不带 overwrite 要提示');
        assert.equal((await fetch(`${url}/api/agent-skills`, { method: 'POST', headers: json(as('alice')), body: JSON.stringify({ skillMd: md.replace('weekly-brief', 'data-check') }) })).status, 409, '不能占用内置技能标识');
        // 未开放前：bob 在 /api/ai/skills、GET /:id、export 以及对话 @weekly-brief 中全部被拦
        assert.equal((await (await fetch(`${url}/api/ai/skills`, { headers: as('bob') })).json()).items.some((s) => s.id === 'weekly-brief'), false);
        assert.equal((await fetch(`${url}/api/agent-skills/weekly-brief`, { headers: as('bob') })).status, 403);
        assert.equal((await fetch(`${url}/api/agent-skills/weekly-brief/export`, { headers: as('bob') })).status, 403);
        mock.aiRequests.length = 0;
        mock.aiScript.push({ text: '好的。' });
        const blockedSkillEv = await chat('bob', { messages: [{ role: 'user', content: '@weekly-brief 给我本周摘要' }] });
        assert.equal(blockedSkillEv.some((e) => e.type === 'skills'), false, '未开放技能不能通过 @ 注入对话');
        assert.doesNotMatch(streamReqs()[0].messages[0].content, /蓝莓松饼/);

        // alice 将 weekly-brief 与 data-check 设为全员开放后，bob 才能使用
        assert.equal((await fetch(`${url}/api/distribution`, { method: 'PATCH', headers: json(as('alice')), body: JSON.stringify({ kind: 'skill', id: 'weekly-brief', sharedAccess: true }) })).status, 200);
        assert.equal((await fetch(`${url}/api/distribution`, { method: 'PATCH', headers: json(as('alice')), body: JSON.stringify({ kind: 'skill', id: 'data-check', sharedAccess: true }) })).status, 200);
        assert.ok((await (await fetch(`${url}/api/ai/skills`, { headers: as('bob') })).json()).items.some((s) => s.id === 'weekly-brief'));

        mock.aiRequests.length = 0;
        mock.aiScript.push({ text: '好的。' });
        const skillEvents = await chat('bob', { messages: [{ role: 'user', content: '@weekly-brief 给我本周摘要' }] });
        assert.deepEqual(skillEvents.find((e) => e.type === 'skills').skills, ['weekly-brief']);
        assert.match(streamReqs()[0].messages[0].content, /蓝莓松饼/);
        assert.match(streamReqs()[0].messages[0].content, /"id":"data-check"/);

        // ── 3b. 技能包：整包导入（脚本、参考、二进制都在），模型按需读文件，导出原样，覆盖 / 回退 / 删除时文件跟着走 ──
        const PkgZip = (await import('jszip')).default;
        const pkgPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
        const pack = async (files) => { const zip = new PkgZip(); Object.entries(files).forEach(([name, content]) => zip.file(name, content)); return (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64'); };
        const v1 = await pack({ 'pdf-tools/SKILL.md': '---\nname: pdf-tools\ndescription: 处理 PDF\n---\n# PDF\n见 references/guide.md', 'pdf-tools/references/guide.md': '# Guide\n口令：海盐焦糖', 'pdf-tools/scripts/run.py': 'print("ok")\n', 'pdf-tools/assets/logo.png': pkgPng, '__MACOSX/._x': 'junk' });
        const skillPost = (path, body, user = 'alice') => fetch(`${url}/api/agent-skills${path}`, { method: 'POST', headers: json(as(user)), body: JSON.stringify(body) });
        const pkgPreview = (await (await skillPost('/preview', { archiveBase64: v1 })).json()).skill;
        assert.deepEqual([pkgPreview.id, pkgPreview.fileCount, pkgPreview.skippedFiles], ['pdf-tools', 3, 0]);
        const pkgImported = (await (await skillPost('/import', { archiveBase64: v1 })).json()).skill;
        assert.deepEqual(pkgImported.files.map((f) => [f.path, !!f.binary, f.size]).sort(), [['assets/logo.png', true, 8], ['references/guide.md', false, 29], ['scripts/run.py', false, 12]]);
        assert.equal(pkgImported.files.find((f) => f.binary).content, '', '二进制内容不发给界面');
        const readSkill = TOOLS.find((t) => t.name === 'read_skill');
        assert.equal((await readSkill.run({ id: 'pdf-tools' }, { identity: { username: 'bob', isAdmin: false } })).ok, false, '未开放前普通用户不能让 AI read_skill 读取');
        assert.equal((await readSkill.run({ id: 'pdf-tools', file: 'references/guide.md' }, { identity: { username: 'bob', isAdmin: false } })).ok, false, '未开放前不能读技能包附件');
        assert.equal((await readSkill.run({ id: 'pdf-tools' }, { identity: { username: 'alice', isAdmin: true } })).ok, true, '超级管理员可直接 read_skill');
        assert.equal((await fetch(`${url}/api/agent-skills/pdf-tools/export`, { headers: as('bob') })).status, 403);
        // 开放 pdf-tools 后 bob 才能查看、导出与 read_skill
        assert.equal((await fetch(`${url}/api/distribution`, { method: 'PATCH', headers: json(as('alice')), body: JSON.stringify({ kind: 'skill', id: 'pdf-tools', sharedAccess: true }) })).status, 200);
        assert.equal((await (await fetch(`${url}/api/agent-skills`, { headers: as('bob') })).json()).items.find((s) => s.id === 'pdf-tools').fileCount, 3);
        assert.match((await readSkill.run({ id: 'pdf-tools' }, { identity: { username: 'bob', isAdmin: false } })).content, /#### 技能包文件\n[\s\S]*- assets\/logo\.png（二进制，8 B）[\s\S]*当前环境不能执行脚本/);
        assert.match((await readSkill.run({ id: '@pdf-tools', file: 'references/guide.md' }, { identity: { username: 'bob', isAdmin: false } })).content, /海盐焦糖/);
        assert.match((await readSkill.run({ id: 'pdf-tools', file: 'assets/logo.png' }, { identity: { username: 'bob', isAdmin: false } })).content, /二进制文件/);
        assert.equal((await readSkill.run({ id: 'pdf-tools', file: '../../etc/passwd' }, { identity: { username: 'bob', isAdmin: false } })).ok, false);
        mock.aiRequests.length = 0;
        mock.aiScript.push({ text: '好的。' });
        await chat('bob', { messages: [{ role: 'user', content: '@pdf-tools 提取文字' }] });
        assert.match(streamReqs()[0].messages[0].content, /#### 技能包文件\n[\s\S]*- scripts\/run\.py/);
        const pkgExported = await PkgZip.loadAsync(Buffer.from(await (await fetch(`${url}/api/agent-skills/pdf-tools/export`, { headers: as('bob') })).arrayBuffer()));
        assert.deepEqual(Object.keys(pkgExported.files).filter((n) => !n.endsWith('/')).sort(), ['pdf-tools/SKILL.md', 'pdf-tools/assets/logo.png', 'pdf-tools/references/guide.md', 'pdf-tools/scripts/run.py']);
        assert.ok((await pkgExported.file('pdf-tools/assets/logo.png').async('nodebuffer')).equals(pkgPng));
        // 只改 SKILL.md（对话里完善技能）不动附带文件；重新导入整包则替换
        await skillPost('', { skillMd: '---\nid: pdf-tools\nname: pdf-tools\ndescription: 处理 PDF\n---\n# PDF 改过', overwrite: true });
        assert.equal((await (await fetch(`${url}/api/agent-skills/pdf-tools`, { headers: as('bob') })).json()).skill.files.length, 3);
        const v2 = await pack({ 'pdf-tools/SKILL.md': '---\nname: pdf-tools\ndescription: v2\n---\n# PDF v2', 'pdf-tools/scripts/new.sh': '#!/bin/sh\necho 2\n' });
        assert.deepEqual((await (await skillPost('/import', { archiveBase64: v2, overwrite: true })).json()).skill.files.map((f) => f.path), ['scripts/new.sh']);
        // 回退到带三个文件的版本，文件一起回来；删除后文件和计数都清掉
        const pkgBackups = (await (await fetch(`${url}/api/agent-skills/pdf-tools/backups`, { headers: as('alice') })).json()).backups;
        const withFiles = pkgBackups.find((b) => b.fileCount === 3);
        assert.ok(withFiles, '覆盖前的版本连同文件留了备份');
        assert.equal((await (await skillPost(`/pdf-tools/rollback/${withFiles.id}`, {})).json()).skill.files.length, 3);
        assert.equal((await fetch(`${url}/api/agent-skills/pdf-tools`, { method: 'DELETE', headers: as('alice') })).status, 200);
        assert.deepEqual(await dao.kvGet('skill_files:pdf-tools', null), null);
        assert.equal((await dao.kvGet('skill_file_counts', {}))['pdf-tools'], undefined);

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

        // ── 5. HTML 工具：对话里发布（需用户确认）；普通用户的只有自己可见；页面在沙箱里 ──
        mock.aiScript.push(
            { toolCalls: [{ name: 'publish_html_tool', args: { name: '百分比计算器', description: '算占比', icon: '🧮', html: '<!doctype html><html><head><title>t</title></head><body><h1>calc</h1><script>document.title="ok"</script></body></html>' } }] },
            { text: '已发布。' },
        );
        const pubEvents = await chatLive('bob', { messages: [{ role: 'user', content: '发布吧' }] }, async (ev) => {
            if (ev.type === 'approval') await fetch(`${url}/api/agent-workspace/approvals/${ev.id}`, { method: 'POST', headers: json(as('bob')), body: JSON.stringify({ decision: 'allow' }) });
        });
        const pub = pubEvents.find((e) => e.type === 'tool_result');
        assert.equal(pub.ok, true);
        assert.doesNotMatch(JSON.stringify(pubEvents.find((e) => e.type === 'tool_start').args), /<script>/, '工具行里不回显整段 HTML');
        // 工具清单里还有随包发布的内置工具，这里只看用户发布的
        const published = async (user) => (await (await fetch(`${url}/api/custom-tools`, { headers: as(user) })).json()).filter((t) => !t.builtIn);
        const mine = await published('bob');
        assert.equal(mine.length, 1);
        assert.equal(mine[0].name, '百分比计算器');
        assert.equal(mine[0].visibility, 'private');
        assert.equal((await published('carol')).length, 0);
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
                { name: 'memory', args: { action: 'add', content: '回答里的百分比保留两位小数', topic: '*' } },
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
        // 数据抓取页面默认全员开放，开放时脚本对全员可见（与主线版一致）；这里先收回页面，单看插件分发
        assert.equal((await fetch(`${url}/api/distribution`, { method: 'PATCH', headers: json(as('alice')), body: JSON.stringify({ kind: 'page', id: 'uivf12', sharedAccess: false }) })).status, 200);
        // 插件/抓取脚本未开放前：bob 在对话与接口里均看不到；开放 cap:float:https://example.invalid 后才可见
        const listScriptsTool = TOOLS.find((t) => t.name === 'list_uiv_scripts');
        const readScriptTool = TOOLS.find((t) => t.name === 'read_uiv_script');
        const aliceListed = JSON.parse((await listScriptsTool.run({}, { identity: { username: 'alice', isAdmin: true } })).content);
        const scriptId = aliceListed.scripts[0].id;
        assert.equal(JSON.parse((await listScriptsTool.run({}, { identity: { username: 'bob', isAdmin: false } })).content).scripts.length, 0);
        assert.equal((await readScriptTool.run({ id: scriptId }, { identity: { username: 'bob', isAdmin: false } })).ok, false);
        assert.equal((await fetch(`${url}/api/distribution`, { method: 'PATCH', headers: json(as('alice')), body: JSON.stringify({ kind: 'cap', id: 'float:https://example.invalid', sharedAccess: true }) })).status, 200);
        assert.equal(JSON.parse((await listScriptsTool.run({}, { identity: { username: 'bob', isAdmin: false } })).content).scripts.length, 1);
        assert.equal((await readScriptTool.run({ id: scriptId }, { identity: { username: 'bob', isAdmin: false } })).ok, true);
        assert.equal((await fetch(`${url}/api/uiv/backup`, { headers: as('bob') })).status, 403);

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
        // 「本次会话不再询问」：同一对话里同一工具后面直接执行；换个对话、换个工具仍要确认
        const writeCall = (value) => ({ toolCalls: [{ name: 'update_database_rows', args: { table: 'report_metric_data', values: { target_val: value }, where: "metric_label = '整改闭环率'" } }] });
        mock.aiScript.push(writeCall('94%'), { text: '已修改。' });
        let alwaysCard = null;
        const alwaysEvents = await chatLive('alice', { messages: [{ role: 'user', content: '改成 94%' }] }, async (ev) => {
            if (ev.type !== 'approval') return;
            alwaysCard = ev;
            await fetch(`${url}/api/agent-workspace/approvals/${ev.id}`, { method: 'POST', headers: json(as('alice')), body: JSON.stringify({ decision: 'always' }) });
        });
        assert.equal(alwaysCard.noAlways, undefined, '保存的对话里提供「不再询问」');
        assert.equal(alwaysEvents.find((e) => e.type === 'approval_result').decision, 'always');
        assert.equal(alwaysEvents.find((e) => e.type === 'tool_result').ok, true);
        const sessionId = alwaysEvents.find((e) => e.type === 'start').sessionId;
        mock.aiScript.push(writeCall('95%'), { text: '已修改。' });
        const silentEvents = await chat('alice', { sessionId, messages: [{ role: 'user', content: '再改成 95%' }] });
        assert.ok(!silentEvents.some((e) => e.type === 'approval'), '同一对话不再弹卡');
        assert.equal(silentEvents.find((e) => e.type === 'approval_result').auto, true);
        assert.equal((await dao.selectTable('report_metric_data', { whereSql: "`metric_label` = '整改闭环率'", limit: 1, memFilter: () => true }))[0].target_val, '95%');
        mock.aiScript.push(writeCall('96%'), { text: '取消。' });
        const otherSession = await chatLive('alice', { messages: [{ role: 'user', content: '改成 96%' }] }, async (ev) => {
            if (ev.type === 'approval') await fetch(`${url}/api/agent-workspace/approvals/${ev.id}`, { method: 'POST', headers: json(as('alice')), body: JSON.stringify({ decision: 'deny' }) });
        });
        assert.ok(otherSession.some((e) => e.type === 'approval'), '换个对话仍要确认');
        assert.equal((await dao.selectTable('report_metric_data', { whereSql: "`metric_label` = '整改闭环率'", limit: 1, memFilter: () => true }))[0].target_val, '95%');
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
        // 新手引导的示例提问：只给只读查询工具、提示词里说明是演示（与主线版 tourReportExample 一致）
        mock.aiRequests.length = 0;
        await chat('erin', { tourReportExample: true, messages: [{ role: 'user', content: '列出临期催办' }] });
        const demoReq = streamReqs().at(-1);
        const demoTools = demoReq.tools.map((t) => t.function.name);
        assert.ok(demoTools.includes('get_expiring_followups') && demoTools.includes('get_report_overview'));
        assert.equal(demoTools.some((n) => /send_notification|insert_database_row|update_database_rows|delete_database_rows|followup_create|save_skill|publish_html_tool/.test(n)), false, '演示不带写操作工具');
        assert.match(demoReq.messages[0].content, /新手引导的只读演示/);
        // 开场只是打招呼：先不起标题；第一句正经问题再起，且只换一次（与主线版一致）
        const hello = await chat('dave', { messages: [{ role: 'user', content: '你好' }] });
        const helloSid = hello.find((e) => e.type === 'done').sessionId;
        assert.equal(hello.find((e) => e.type === 'title'), undefined);
        const realAsk = await chat('dave', { sessionId: helloSid, messages: [{ role: 'user', content: '查一下本月指标' }] });
        assert.equal(realAsk.find((e) => e.type === 'title')?.title, 'OK');
        const laterAsk = await chat('dave', { sessionId: helloSid, messages: [{ role: 'user', content: '再查上月' }] });
        assert.equal(laterAsk.find((e) => e.type === 'title'), undefined, '标题只换一次');
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

        // ── 13.5 历史对话继续聊天后刷新会话 updated_at，侧栏排序稳居最上方不回落 ──
        mock.aiScript.push({ text: '等于 2。' }, { text: '好的。' }, { text: '继续算等于 3。' });
        const histFirst = (await chat('bob', { messages: [{ role: 'user', content: '1+1 等于多少' }] })).find((e) => e.type === 'done');
        await new Promise((r) => setTimeout(r, 15));
        const newerChat = (await chat('bob', { messages: [{ role: 'user', content: '新建的后续对话' }] })).find((e) => e.type === 'done');
        const listBeforeResume = (await (await fetch(`${url}/api/ai/sessions`, { headers: as('bob') })).json()).items;
        const s1Before = listBeforeResume.find((s) => s.id === histFirst.sessionId);
        const s2Before = listBeforeResume.find((s) => s.id === newerChat.sessionId);
        assert.ok(s1Before && s2Before);
        assert.ok(s2Before.updatedAt > s1Before.updatedAt);

        await new Promise((r) => setTimeout(r, 15));
        await chat('bob', { sessionId: histFirst.sessionId, messages: [{ role: 'user', content: '1+1 等于多少' }, { role: 'model', content: '等于 2。' }, { role: 'user', content: '再加 1 呢' }] });
        const listAfterResume = (await (await fetch(`${url}/api/ai/sessions`, { headers: as('bob') })).json()).items;
        const s1After = listAfterResume.find((s) => s.id === histFirst.sessionId);
        const s2After = listAfterResume.find((s) => s.id === newerChat.sessionId);
        assert.ok(s1After.updatedAt > s1Before.updatedAt, '继续历史对话应更新 ai_chat_sessions.updated_at');
        assert.ok(s1After.updatedAt > s2After.updatedAt, '继续历史对话后 updatedAt 应大于此前更新的会话');

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
