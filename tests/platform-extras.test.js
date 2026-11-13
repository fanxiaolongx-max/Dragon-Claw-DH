// 1.6.0 补齐的平台能力：消息中心、用量统计、工具清单开关、技能版本历史、压缩包工具、平台标识、会话偏好。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockBaseServer } from './helpers/mock-base.js';

const as = (user) => ({ cookie: `iLearningXUserName=${user}` });
const json = (headers = {}) => ({ 'Content-Type': 'application/json', ...headers });
// 1×1 透明 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('消息中心、用量、工具开关、技能历史、压缩包工具、平台标识、会话偏好', async () => {
    const mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        APP_SCHEMA: 'extras-test',
        APP_UUID: 'extras-test',
        APP_DATASOURCE_ID: '2',
    });
    delete process.env.DH_OPEN_ADMIN;
    delete process.env.DH_ADMIN_USERS;
    const { createServer } = await import('../src/server.js');
    const app = await createServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const call = async (user, method, path, body) => {
        const res = await fetch(`${url}${path}`, { method, headers: body === undefined ? as(user) : json(as(user)), body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { data = text; }
        return { status: res.status, data, headers: res.headers };
    };
    const chat = async (user, body) => {
        const res = await fetch(`${url}/api/ai/chat`, { method: 'POST', headers: json(as(user)), body: JSON.stringify({ stream: true, ...body }) });
        assert.equal(res.status, 200);
        return (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    };

    try {
        // alice 第一个进来 → 管理员；bob 普通用户
        assert.equal((await call('alice', 'GET', '/api/auth/me')).data.isAdmin, true);
        assert.equal((await call('bob', 'GET', '/api/auth/me')).data.isAdmin, false);
        assert.equal((await call('alice', 'POST', '/api/ai-settings/profiles', { name: 'MockLLM', baseUrl: `${mock.baseUrl}/v1`, apiKey: 'test-key-000', model: 'test-model', activate: true })).status, 201);

        // ── 1. 消息中心：管理员名单变更 → 每位管理员收到一条安全类消息 ──
        assert.equal((await call('alice', 'GET', '/api/alert-center/summary')).data.unread, 0);
        assert.equal((await call('alice', 'PUT', '/api/auth/admins', { users: ['alice', 'carol'] })).status, 200);
        const summary = (await call('alice', 'GET', '/api/alert-center/summary')).data;
        assert.equal(summary.unread, 1);
        assert.equal(summary.byType.security, 1);
        assert.equal(summary.warnOrAbove, 1);
        const carolEvents = (await call('carol', 'GET', '/api/alert-center/events?status=unread')).data.events;
        assert.equal(carolEvents.length, 1);
        assert.match(carolEvents[0].title, /管理员名单已更新/);
        assert.equal(carolEvents[0].status, 'unread');
        // bob 不是管理员：收不到，也看不到别人的
        assert.equal((await call('bob', 'GET', '/api/alert-center/events')).data.events.length, 0);
        // 类型筛选、已读、清空都只作用于本人
        assert.equal((await call('alice', 'GET', '/api/alert-center/events?type=config')).data.events.length, 0);
        assert.equal((await call('carol', 'PUT', '/api/alert-center/events/read', { ids: [carolEvents[0].id] })).data.changed, 1);
        assert.equal((await call('carol', 'GET', '/api/alert-center/summary')).data.unread, 0);
        assert.equal((await call('alice', 'GET', '/api/alert-center/summary')).data.unread, 1);
        assert.equal((await call('alice', 'PUT', '/api/alert-center/events/read-all', {})).data.changed, 1);
        const aliceEvent = (await call('alice', 'GET', '/api/alert-center/events')).data.events[0];
        assert.equal((await call('alice', 'DELETE', `/api/alert-center/events/${aliceEvent.id}`)).data.removed, 1);
        assert.equal((await call('alice', 'GET', '/api/alert-center/events')).data.events.length, 0);
        assert.equal((await call('carol', 'POST', '/api/alert-center/events/clear-all', {})).data.removed, 1);

        // ── 2. 用量统计：按模型、按天累计；可以只清某个模型 ──
        mock.aiScript.push({ text: '你好。' });
        const done = (await chat('bob', { messages: [{ role: 'user', content: '你好' }] })).find((e) => e.type === 'done');
        assert.ok(done.usage.inputTokens > 0);
        const usage = (await call('alice', 'GET', '/api/ai-settings/usage?dimension=day')).data;
        assert.equal(usage.models.length, 1);
        assert.equal(usage.models[0].model, 'test-model');
        assert.equal(usage.models[0].profileName, 'MockLLM');
        assert.equal(usage.totals.requests, 1);
        assert.equal(usage.totals.tokens, done.usage.inputTokens + done.usage.outputTokens);
        assert.equal(usage.series.length, 1);
        assert.equal(usage.series[0].tokens, usage.totals.tokens);
        assert.equal(usage.models[0].series[0].tokens, usage.totals.tokens);
        for (const dimension of ['week', 'month', 'year']) {
            assert.equal((await call('alice', 'GET', `/api/ai-settings/usage?dimension=${dimension}`)).data.totals.tokens, usage.totals.tokens);
        }
        assert.equal((await call('bob', 'DELETE', `/api/ai-settings/usage?key=${encodeURIComponent(usage.models[0].key)}`)).status, 403);
        const cleared = (await call('alice', 'DELETE', `/api/ai-settings/usage?key=${encodeURIComponent(usage.models[0].key)}`)).data;
        assert.equal(cleared.models.length, 0);
        assert.equal(cleared.totals.tokens, 0);

        // ── 3. 工具清单：统计调用次数；停用后的工具不再发给模型，模型硬调也会被拒绝 ──
        mock.aiScript.push({ text: '', toolCalls: [{ name: 'calculate', args: { expression: '1+2' } }] }, { text: '等于 3。' });
        await chat('bob', { messages: [{ role: 'user', content: '1+2 等于几' }] });
        await new Promise((r) => setTimeout(r, 50));
        const catalog = (await call('alice', 'GET', '/api/agent-mcp/catalog')).data;
        assert.equal(catalog.manage, true);
        const allTools = catalog.groups.flatMap((g) => g.tools);
        assert.equal(allTools.length, 34); // 含 NetCare 数据探查 4 个、跟进任务 4 个、工具使用说明 1 个
        assert.equal(allTools.find((t) => t.name === 'calculate').calls, 1);
        assert.equal((await call('bob', 'GET', '/api/agent-mcp/catalog')).data.manage, false);
        assert.equal((await call('bob', 'PATCH', '/api/agent-mcp/catalog/access', { scope: 'tool', id: 'calculate', enabled: false })).status, 403);
        assert.equal((await call('alice', 'PATCH', '/api/agent-mcp/catalog/access', { scope: 'tool', id: 'no_such_tool', enabled: false })).status, 404);
        assert.equal((await call('alice', 'PATCH', '/api/agent-mcp/catalog/access', { scope: 'tool', id: 'calculate', enabled: false })).status, 200);
        assert.equal((await call('alice', 'PATCH', '/api/agent-mcp/catalog/access', { scope: 'group', id: 'write', enabled: false })).status, 200);
        mock.aiRequests.length = 0;
        mock.aiScript.push({ text: '', toolCalls: [{ name: 'calculate', args: { expression: '1+2' } }] }, { text: '算不了。' });
        const events = await chat('bob', { messages: [{ role: 'user', content: '再算一次' }] });
        const sent = mock.aiRequests.filter((r) => r.stream)[0].tools.map((t) => t.function.name);
        assert.equal(sent.includes('calculate'), false);
        assert.equal(sent.includes('update_database_rows'), false, '整组停用后组内工具都不发给模型');
        assert.equal(sent.includes('query_database'), true);
        assert.equal(events.find((e) => e.type === 'tool_result').ok, false);
        const after = (await call('alice', 'GET', '/api/agent-mcp/catalog')).data;
        assert.equal(after.groups.find((g) => g.id === 'write').enabled, false);
        assert.equal(after.groups.flatMap((g) => g.tools).find((t) => t.name === 'calculate').enabled, false);
        await call('alice', 'PATCH', '/api/agent-mcp/catalog/access', { scope: 'tool', id: 'calculate', enabled: true });
        await call('alice', 'PATCH', '/api/agent-mcp/catalog/access', { scope: 'group', id: 'write', enabled: true });
        // 设置页同页的其他区块：返回空结果，不报错
        assert.deepEqual((await call('alice', 'GET', '/api/agent-mcp/servers')).data.servers, []);

        // ── 4. 技能版本历史：覆盖前自动留一份，可以查看并回退 ──
        const skillMd = (body) => `---\nid: weekly-brief\nname: 周报\ndescription: 写周报\n---\n${body}`;
        assert.equal((await call('alice', 'POST', '/api/agent-skills', { skillMd: skillMd('第一版步骤') })).status, 200);
        assert.equal((await call('alice', 'GET', '/api/agent-skills/weekly-brief/backups')).data.backups.length, 0);
        assert.equal((await call('alice', 'POST', '/api/agent-skills', { skillMd: skillMd('第二版步骤'), overwrite: true })).status, 200);
        const backups = (await call('bob', 'GET', '/api/agent-skills/weekly-brief/backups')).data.backups;
        assert.equal(backups.length, 1);
        assert.equal(backups[0].name, '周报');
        assert.equal(backups[0].createdBy, 'alice');
        assert.match((await call('bob', 'GET', `/api/agent-skills/weekly-brief/backups/${backups[0].id}`)).data.backup.markdown, /第一版步骤/);
        assert.equal((await call('bob', 'POST', `/api/agent-skills/weekly-brief/rollback/${backups[0].id}`)).status, 403);
        assert.equal((await call('alice', 'POST', `/api/agent-skills/weekly-brief/rollback/${backups[0].id}`)).status, 200);
        assert.match((await call('alice', 'GET', '/api/agent-skills/weekly-brief')).data.skill.body, /第一版步骤/);
        // 回退前的版本也留了一份，还能再回来
        const afterRollback = (await call('alice', 'GET', '/api/agent-skills/weekly-brief/backups')).data.backups;
        assert.equal(afterRollback.length, 2);
        assert.match((await call('alice', 'GET', `/api/agent-skills/weekly-brief/backups/${afterRollback[0].id}`)).data.backup.markdown, /第二版步骤/);
        assert.equal((await call('alice', 'POST', '/api/agent-skills/weekly-brief/rollback/nope')).status, 404);

        // ── 5. 压缩包形式的多文件工具：样式、脚本、图片内联成一个自包含页面 ──
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();
        zip.file('demo/index.html', '<!doctype html><html><head><title>多文件工具</title><link rel="stylesheet" href="css/app.css"></head><body><img src="img/dot.png"><script src="js/app.js"></script></body></html>');
        zip.file('demo/css/app.css', 'body{background:url("../img/dot.png")}');
        zip.file('demo/js/app.js', 'document.title = "ready";');
        zip.file('demo/img/dot.png', PNG);
        const archiveBase64 = (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');
        const published = await call('alice', 'POST', '/api/custom-tools', { name: '多文件工具', archiveBase64 });
        assert.equal(published.status, 201);
        const raw = await (await fetch(`${url}/custom-tools/${published.data.slug}/raw`, { headers: as('bob') })).text();
        assert.match(raw, /<style>\s*body\{background:url\("data:image\/png;base64,/);
        assert.match(raw, /<script>\s*document\.title = "ready";/);
        assert.match(raw, /<img src="data:image\/png;base64,/);
        assert.doesNotMatch(raw, /href="css\/app\.css"|src="js\/app\.js"|src="img\/dot\.png"/);
        const noHtml = new JSZip();
        noHtml.file('readme.txt', 'x');
        const bad = await call('alice', 'POST', '/api/custom-tools', { name: '坏包', archiveBase64: (await noHtml.generateAsync({ type: 'nodebuffer' })).toString('base64') });
        assert.equal(bad.status, 400);
        assert.match(bad.data.error, /没有找到 HTML/);
        assert.equal((await call('alice', 'POST', '/api/custom-tools', { name: '坏包', archiveBase64: Buffer.from('not a zip').toString('base64') })).status, 400);

        // ── 6. 平台标识：管理员上传后全站生效，可恢复默认 ──
        const before = await fetch(`${url}/assets/logo.png`);
        assert.equal(before.status, 200);
        const bundled = Buffer.from(await before.arrayBuffer());
        const upload = async (user, buffer) => {
            const form = new FormData();
            form.append('logo', new Blob([buffer], { type: 'image/png' }), 'logo.png');
            const res = await fetch(`${url}/api/platform-logo/upload`, { method: 'POST', headers: as(user), body: form });
            return { status: res.status, data: await res.json() };
        };
        assert.equal((await upload('bob', PNG)).status, 403);
        assert.equal((await upload('alice', Buffer.from('this is definitely not a png image, just some long enough text to pass the size check'))).status, 400);
        const uploaded = await upload('alice', PNG);
        assert.equal(uploaded.status, 200);
        assert.equal(uploaded.data.ok, true);
        assert.equal(uploaded.data.custom, true);
        for (const path of ['/assets/logo.png', '/pages/assets/logo.png', '/api/platform-logo/image']) {
            assert.equal(Buffer.from(await (await fetch(`${url}${path}`)).arrayBuffer()).equals(PNG), true, `${path} 应返回自定义图标`);
        }
        assert.equal((await call('bob', 'GET', '/api/platform-logo/status')).data.storageMode, 'runtime');
        assert.equal((await call('alice', 'DELETE', '/api/platform-logo')).data.custom, false);
        assert.equal(Buffer.from(await (await fetch(`${url}/assets/logo.png`)).arrayBuffer()).equals(bundled), true);

        // ── 7. 会话偏好：置顶、改名分次提交，按「来源 + 会话」合并，互不覆盖 ──
        assert.equal((await call('bob', 'PUT', '/api/ai/conversation-list', { source: 'mine', id: 's1', pinned: true })).data.item.pinned, true);
        const renamed = (await call('bob', 'PUT', '/api/ai/conversation-list', { source: 'mine', id: 's1', title: '十月复盘' })).data.item;
        assert.equal(renamed.pinned, true, '改名不能丢掉置顶');
        assert.equal(renamed.title, '十月复盘');
        await call('bob', 'PUT', '/api/ai/conversation-list', { source: 'agents', id: 's1', archived: true });
        const prefs = (await call('bob', 'GET', '/api/ai/conversation-list')).data.items;
        assert.equal(prefs.length, 2, '不同来源的同名会话各存各的');
        assert.equal((await call('bob', 'PUT', '/api/ai/conversation-list', { source: 'mine', id: 's1', pinned: false, title: '' })).data.item.pinned, false);
        assert.equal((await call('bob', 'GET', '/api/ai/conversation-list')).data.items.length, 1, '没有任何偏好的条目不保留');
        assert.equal((await call('alice', 'GET', '/api/ai/conversation-list')).data.items.length, 0);
        assert.equal((await call('bob', 'PUT', '/api/ai/conversation-list', { pinned: true })).status, 400);

        // ── 8. /btw 旁路提问（persist:false）：不建会话、不落库 ──
        const sessionsBefore = (await call('bob', 'GET', '/api/ai/sessions')).data.items.length;
        mock.aiScript.push({ text: '顺便回答。' });
        const btw = await chat('bob', { persist: false, messages: [{ role: 'user', content: '顺便问一下' }] });
        assert.equal(btw.find((e) => e.type === 'done').sessionId, '');
        assert.equal(btw.some((e) => e.type === 'start'), false);
        assert.equal((await call('bob', 'GET', '/api/ai/sessions')).data.items.length, sessionsBefore);

        // ── 9. 数据探索：仅管理员；只读查询业务表；写语句、系统表一律拒绝 ──
        assert.equal((await call('bob', 'GET', '/api/db-explorer/tables')).status, 403, '普通用户看不到数据探索');
        assert.equal((await call('bob', 'POST', '/api/db-explorer/query', { sql: 'SELECT name FROM sla_categories' })).status, 403);
        const tables = (await call('alice', 'GET', '/api/db-explorer/tables')).data.tables;
        assert.ok(tables.some((t) => t.name === 'report_metric_data'));
        assert.equal(tables.some((t) => t.name === 'ai_settings_profiles'), false, '密钥表不在目录里');
        assert.equal(tables.find((t) => t.name === 'sla_snapshots').columns.find((c) => c.name === 'payload_json').heavy, true);
        const queried = await call('alice', 'POST', '/api/db-explorer/query', { sql: 'SELECT name, sort_order FROM sla_categories' });
        assert.equal(queried.status, 200);
        assert.ok(Array.isArray(queried.data.rows));
        for (const sql of ['DELETE FROM sla_categories', 'SELECT * FROM ai_settings_profiles', 'SELECT 1; DROP TABLE sla_categories']) {
            const denied = await call('alice', 'POST', '/api/db-explorer/query', { sql });
            assert.equal(denied.status, 400, sql);
        }

        // ── 10. 请求体不是合法 JSON：返回 422（规范 §8.4），不是 500 ──
        const broken = await fetch(`${url}/api/ai/conversation-list`, { method: 'PUT', headers: json(as('bob')), body: '{"source":' });
        assert.equal(broken.status, 422);

        // ── 11. 模型配置测试与前端字段：POST /profiles/:id/test、maskedApiKey、apiKeySource、clone & clearApiKey ──
        const aiList = (await call('alice', 'GET', '/api/ai-settings')).data;
        const pId = aiList.activeProfileId;
        assert.equal(aiList.apiKeySource, 'stored');
        assert.equal(aiList.maskedApiKey, 'test***-000');
        mock.aiScript.push({ text: 'OK' });
        const testRes = await call('alice', 'POST', `/api/ai-settings/profiles/${pId}/test`, {
            profileId: pId,
            provider: 'openai',
            apiBaseUrl: `${mock.baseUrl}/v1`,
            model: 'sub-model',
            models: ['test-model', 'sub-model'],
        });
        assert.equal(testRes.status, 200);
        assert.equal(testRes.data.success, true);
        assert.equal(testRes.data.model, 'sub-model');
        assert.equal((await call('alice', 'GET', '/api/ai-settings')).data.model, 'test-model', '测非主模型不篡改主模型');
        assert.equal((await call('alice', 'POST', '/api/ai-settings/profiles/no-such-profile/test', {})).status, 404);
        const cloned = await call('alice', 'POST', '/api/ai-settings/profiles', { sourceProfileId: pId, name: 'MockLLM Copy' });
        assert.equal(cloned.status, 201);
        assert.ok(cloned.data.createdProfileId);
        const copiedProfile = cloned.data.profiles.find((p) => p.id === cloned.data.createdProfileId);
        assert.equal(copiedProfile.hasApiKey, true);
        assert.equal(copiedProfile.apiKeySource, 'stored');
        const clearedKey = await call('alice', 'PUT', `/api/ai-settings/profiles/${copiedProfile.id}`, { clearApiKey: true });
        assert.equal(clearedKey.data.profiles.find((p) => p.id === copiedProfile.id).hasApiKey, false);

        // ── 12. 服务状态中心运行日志：logs / total / page / totalPages 字段、levels 过滤、仅管理员 ──
        assert.equal((await call('bob', 'GET', '/api/platform-metrics/service-status/logs?page=1&pageSize=20')).status, 403);
        const logRes = await call('alice', 'GET', '/api/platform-metrics/service-status/logs?levels=DEBUG,INFO,LOG,WARN,ERROR&page=1&pageSize=20');
        assert.equal(logRes.status, 200);
        assert.ok(Array.isArray(logRes.data.logs) && logRes.data.logs.length > 0);
        assert.ok(logRes.data.total >= logRes.data.logs.length);
        assert.equal(logRes.data.page, 1);
        assert.ok(logRes.data.totalPages >= 1);
        assert.ok(logRes.data.logs[0].timestamp && logRes.data.logs[0].source && logRes.data.logs[0].detail);
        assert.equal((await call('alice', 'GET', '/api/platform-metrics/service-status/logs?levels=__none__')).data.logs.length, 0);

        // ── 13. 开箱即用默认规则自动初始化 + SLA flat targets/prefs + snapshots/:id ──
        assert.equal((await call('bob', 'POST', '/api/onboarding/defaults/apply', {})).status, 403);
        const onStatus = await call('alice', 'GET', '/api/onboarding/defaults/status');
        assert.equal(onStatus.status, 200);
        assert.equal(onStatus.data.required, false);
        assert.equal(onStatus.data.decided, true);
        assert.equal(onStatus.data.state?.result?.targetsAdded, 58);
        assert.equal(onStatus.data.state?.result?.preferencesAdded, 77);
        assert.equal(onStatus.data.state?.result?.scriptsAdded, 43);
        const applyAgain = await call('alice', 'POST', '/api/onboarding/defaults/apply', { importScripts: true, importMetricRules: true });
        assert.equal(applyAgain.status, 200);
        assert.equal(applyAgain.data.state.result.targetsAdded, 0, 'preserve-existing 不重复导入已有规则');

        const targetsRes = await fetch(`${url}/api/sla/targets`, { headers: as('bob') });
        assert.equal(targetsRes.status, 200);
        assert.equal(targetsRes.headers.get('x-data-source'), 'mysql');
        const targetsData = await targetsRes.json();
        assert.equal(targetsData.items, undefined, 'targets 接口返回扁平字典，不套 items 壳');
        assert.equal(targetsData.manual_target_1778881260277?.label, 'IBMS');

        const prefHit = await call('bob', 'GET', '/api/sla/prefs/sla_prefs_other_16amqd');
        assert.equal(prefHit.status, 200);
        assert.equal(prefHit.data.prefs, undefined, 'prefs 接口直接返回对象本身');
        assert.ok(Array.isArray(prefHit.data.customMetrics) && prefHit.data.customMetrics.length > 0);
        const prefMiss = await call('bob', 'GET', '/api/sla/prefs/no_such_schema_hash');
        assert.equal(prefMiss.status, 200);
        assert.equal(prefMiss.data, null);

        const groupsRes = await call('bob', 'GET', '/api/sla/groups');
        assert.equal(groupsRes.status, 200);
        assert.ok(groupsRes.data.length >= 9);
        assert.ok(Array.isArray(groupsRes.data[0].metrics));

        const snapSave = await call('alice', 'POST', '/api/sla/snapshot', {
            category: 'TE',
            name: 'test-snap',
            topMetrics: [{ label: '任职率', value: '98%' }],
        });
        assert.equal(snapSave.status, 200);
        const snapGet = await call('bob', 'GET', `/api/sla/snapshots/${snapSave.data.id}`);
        assert.equal(snapGet.status, 200);
        assert.equal(snapGet.data.id, snapSave.data.id);
        assert.equal((await call('bob', 'GET', '/api/sla/snapshots/no-such-id')).status, 404);

        // ── 14. UIV 分类删除：除 默认分类 外都可删且刷新不再复活 ──
        assert.equal((await call('alice', 'POST', '/api/uiv/categories', { name: 'NetCare' })).status, 201);
        assert.ok((await call('bob', 'GET', '/api/uiv/categories')).data.includes('NetCare'));
        const delNetCare = await call('alice', 'DELETE', '/api/uiv/categories/NetCare');
        assert.equal(delNetCare.status, 200);
        assert.equal(delNetCare.data.categories.includes('NetCare'), false);
        assert.equal((await call('bob', 'GET', '/api/uiv/categories')).data.includes('NetCare'), false, '刷新后仍保持已删除');
        assert.equal((await call('bob', 'GET', '/api/uiv/scripts')).data.categories.includes('NetCare'), false);
        assert.equal((await call('alice', 'DELETE', `/api/uiv/categories/${encodeURIComponent('默认分类')}`)).status, 400);
    } finally {
        await app.close();
        await mock.close();
    }
});
