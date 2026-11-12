// 权限、统一响应体、会话归属、密钥加密、启动降级——这些是基座上最容易出事故的地方。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startMockBaseServer, getFreePort, waitForServer } from './helpers/mock-base.js';

const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function startApp(extraEnv) {
    const port = await getFreePort();
    const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'silent', ...extraEnv };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    const child = spawn(process.execPath, ['run.js'], { cwd: APP_ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
    const url = `http://127.0.0.1:${port}`;
    await waitForServer(`${url}/api/healthz`);
    return { url, stop: () => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); }) };
}

const as = (user) => (user ? { cookie: `iLearningXUserName=${user}` } : {});
const json = (headers = {}) => ({ 'Content-Type': 'application/json', ...headers });

test('首位已识别用户成为管理员，其余用户按桌面版规则只能做个人级写操作', async () => {
    const mock = await startMockBaseServer();
    const app = await startApp({
        LOCAL_DEV_MEMORY: '0',
        DH_OPEN_ADMIN: undefined,
        DH_ADMIN_USERS: undefined,
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        BASE_DATASOURCES_URL: `${mock.baseUrl}/query/datasources`,
        APP_SCHEMA: 'app_schema_under_test',
        APP_UUID: 'app-under-test',
        APP_DATASOURCE_ID: '2',
    });
    try {
        // 匿名访问者永远不是管理员，也不会触发“首位管理员”；且业务 API 与直接页面访问返回 401
        const guest = await (await fetch(`${app.url}/api/auth/me`)).json();
        assert.equal(guest.isAdmin, false);
        assert.equal(guest.identified, false);
        assert.equal(guest.authRequired, true);
        assert.equal((await fetch(`${app.url}/api/debug/summary`)).status, 403);
        for (const [m, p] of [['GET', '/api/sla/snapshots'], ['GET', '/api/ai/sessions'], ['POST', '/api/ai/chat'], ['GET', '/api/monthly-snapshots']]) {
            const unauth = await fetch(`${app.url}${p}`, { method: m, headers: m === 'POST' ? json() : {}, body: m === 'POST' ? '{}' : undefined });
            assert.equal(unauth.status, 401, `${m} ${p} 未登录应返回 401`);
            assert.equal((await unauth.json()).code, 'AUTH_REQUIRED');
        }
        const directPage = await fetch(`${app.url}/`);
        assert.equal(directPage.status, 401, '未登录直接访问首页应返回 401');
        const directHtml = await directPage.text();
        assert.match(directHtml, /assets\/logo\.png/);
        assert.match(directHtml, /401/);
        const monthlyPage = await fetch(`${app.url}/monthly`);
        assert.equal(monthlyPage.status, 401, '未登录直接访问子页面应返回 401');
        const subpathPage = await fetch(`${app.url}/digital-human/dh/00000000-0000-4000-8000-000000000001/`);
        assert.equal(subpathPage.status, 200, '网关子路径首页放行以供 dh-runtime.js 校验 /api/dh/user/current');
        assert.equal((await fetch(`${app.url}/`, { headers: as('alice') })).status, 200);

        const alice = await (await fetch(`${app.url}/api/auth/me`, { headers: as('alice') })).json();
        assert.deepEqual([alice.username, alice.isAdmin, alice.role], ['alice', true, 'admin']);
        const bob = await (await fetch(`${app.url}/api/auth/me`, { headers: as('bob') })).json();
        assert.deepEqual([bob.username, bob.isAdmin, bob.role], ['bob', false, 'user']);

        // 普通用户：读可以，改全局配置、调试接口、管理员名单都不行
        assert.equal((await fetch(`${app.url}/api/sla/config`, { headers: as('bob') })).status, 200);
        for (const [method, url] of [['POST', '/api/sla/config'], ['PUT', '/api/ai-settings/'], ['POST', '/api/debug/test/write-self'], ['PUT', '/api/auth/admins'], ['DELETE', '/api/sla/snapshots/1']]) {
            const res = await fetch(`${app.url}${url}`, { method, headers: json(as('bob')), body: method === 'DELETE' ? undefined : '{}' });
            assert.equal(res.status, 403, `${method} ${url}`);
            assert.equal((await res.json()).code, 'ADMIN_REQUIRED');
        }
        assert.equal((await fetch(`${app.url}/api/debug/summary`, { headers: as('bob') })).status, 403);
        assert.equal((await fetch(`${app.url}/api/auth/admins`, { headers: as('bob') })).status, 403);

        // 管理员可以维护名单，但不能把自己移出去
        const admins = await (await fetch(`${app.url}/api/auth/admins`, { headers: as('alice') })).json();
        assert.deepEqual(admins.stored, ['alice']);
        assert.equal((await fetch(`${app.url}/api/auth/admins`, { method: 'PUT', headers: json(as('alice')), body: JSON.stringify({ users: ['bob'] }) })).status, 400);
        assert.equal((await fetch(`${app.url}/api/auth/admins`, { method: 'PUT', headers: json(as('alice')), body: JSON.stringify({ users: ['alice', 'Bob'] }) })).status, 200);
        assert.equal((await (await fetch(`${app.url}/api/auth/me`, { headers: as('bob') })).json()).isAdmin, true);

        // 管理员工号兼容大小写及省略首字母（如 z00569258 / 00569258、dwx1545337 / WX1545337）
        assert.equal((await fetch(`${app.url}/api/auth/admins`, {
            method: 'PUT',
            headers: json(as('alice')),
            body: JSON.stringify({ users: ['alice', 'z00569258', 'dwx1545337', 'z00548379'] }),
        })).status, 200);
        for (const emp of ['Z00569258', '00569258', 'WX1545337', 'wx1545337', 'DWX1545337', 'Z00548379']) {
            assert.equal((await (await fetch(`${app.url}/api/auth/me`, { headers: as(emp) })).json()).isAdmin, true, `${emp} 应判定为管理员`);
        }
        assert.equal((await (await fetch(`${app.url}/api/auth/me`, { headers: as('cwx1545337') })).json()).isAdmin, false, '不同首字母工号不应误判');
        assert.equal((await (await fetch(`${app.url}/api/auth/me`, { headers: as('lice') })).json()).isAdmin, false, '普通英文名不应去掉首字母匹配');
        assert.equal((await fetch(`${app.url}/api/auth/admins`, {
            method: 'PUT',
            headers: json(as('WX1545337')),
            body: JSON.stringify({ users: ['alice', 'z00569258', 'dwx1545337', 'z00548379'] }),
        })).status, 200, '缺首字母登录态提交含完整工号名单时不应报移出自己');

        // 会话只属于创建者（carol 是普通用户，可以对话）
        const chat = await fetch(`${app.url}/api/ai/chat`, { method: 'POST', headers: json(as('carol')), body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }) });
        assert.equal(chat.status, 200);
        const { sessionId } = await chat.json();
        assert.ok(sessionId);
        assert.equal((await fetch(`${app.url}/api/ai/sessions/${sessionId}/messages`, { headers: as('carol') })).status, 200);
        assert.equal((await fetch(`${app.url}/api/ai/sessions/${sessionId}/messages`, { headers: as('dave') })).status, 404);
        assert.equal((await fetch(`${app.url}/api/ai/sessions/${sessionId}`, { method: 'DELETE', headers: as('dave') })).status, 404);
        assert.equal((await fetch(`${app.url}/api/ai/chat`, { method: 'POST', headers: json(as('dave')), body: JSON.stringify({ sessionId, messages: [{ role: 'user', content: 'x' }] }) })).status, 404);
        assert.equal((await (await fetch(`${app.url}/api/ai/sessions`, { headers: as('dave') })).json()).items.length, 0);
        assert.equal((await fetch(`${app.url}/api/ai/sessions/${sessionId}`, { method: 'DELETE', headers: as('carol') })).status, 200);

        // 模型密钥：接口不回显，落库的是密文
        const key = 'sk-test-PLAINTEXT-123456';
        const saved = await fetch(`${app.url}/api/ai-settings/profiles`, { method: 'POST', headers: json(as('alice')), body: JSON.stringify({ name: 'm', provider: 'openai-compatible', model: 'm1', apiKey: key, apiBaseUrl: 'http://model.invalid/v1' }) });
        assert.equal(saved.status, 201);
        assert.equal(JSON.stringify(await saved.json()).includes(key), false);
        const sqlSeen = JSON.stringify(mock.auditRequests);
        assert.equal(sqlSeen.includes(key), false, '明文密钥不应出现在发给基座的 SQL 里');
        assert.match(sqlSeen, /enc:v1:/);
        const settings = await (await fetch(`${app.url}/api/ai-settings/`, { headers: as('alice') })).json();
        assert.equal(settings.profiles.some((p) => p.hasApiKey), true);

        // 统一响应体：垫片声明后业务失败也是 HTTP 200 + 非零 code；未声明时保持原协议
        const wrappedOk = await fetch(`${app.url}/api/auth/me`, { headers: { ...as('bob'), 'x-dh-envelope': '1' } });
        const okBody = await wrappedOk.json();
        assert.deepEqual(Object.keys(okBody).sort(), ['cache_hit', 'code', 'data', 'elapsed_ms', 'message', 'total']);
        assert.deepEqual([okBody.code, okBody.data.username], [0, 'bob']);
        const wrappedFail = await fetch(`${app.url}/api/debug/summary`, { headers: { ...as('carol'), 'x-dh-envelope': '1' } });
        assert.equal(wrappedFail.status, 200);
        assert.equal(wrappedFail.headers.get('x-dh-status'), '403');
        const failBody = await wrappedFail.json();
        assert.deepEqual([failBody.code, failBody.message, failBody.data.code], [403, '该功能仅管理员可用', 'ADMIN_REQUIRED']);
    } finally {
        await app.stop();
        await mock.close();
    }
});

test('未注入基座地址时不静默降级为内存模式：探活照常通过，数据接口明确报错', async () => {
    const app = await startApp({ LOCAL_DEV_MEMORY: undefined, BASE_QUERY_URL: undefined, BASE_EXECUTE_URL: undefined, BASE_DATASOURCES_URL: undefined });
    try {
        const health = await (await fetch(`${app.url}/api/healthz`)).json();
        assert.deepEqual([health.code, health.data.status, health.data.data_mode, health.data.base_api], [0, 'ok', 'degraded', 'fail']);
        const res = await fetch(`${app.url}/api/sla/snapshots`);
        assert.equal(res.status, 500);
        assert.match((await res.json()).error, /未注入基座 API 地址/);
        assert.equal((await (await fetch(`${app.url}/api/auth/me`, { headers: as('alice') })).json()).isAdmin, false, '应用库不可用时不放大权限');
    } finally {
        await app.stop();
    }
});
