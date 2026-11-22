// 身份加固：开发者免登录（/dev-login）与服务端核验前端身份头 x-dh-user
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockBaseServer } from './helpers/mock-base.js';

test('开发者免登录与 x-dh-user 服务端核验', async () => {
    const mock = await startMockBaseServer();
    // 模拟底座 /api/dh/user/current：按 Cookie 里的 sso 值认人；sso=down 时模拟接口不可用
    const platform = http.createServer((req, res) => {
        const sso = (/(?:^|;\s*)sso=([^;]+)/.exec(req.headers.cookie || '') || [])[1] || '';
        if (sso === 'down') { res.writeHead(502); res.end('bad gateway'); return; }
        res.writeHead(sso ? 200 : 401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sso ? { code: 0, data: { uid: sso, cn: `name-${sso}` } } : { code: 401, message: '未登录', data: null }));
    });
    await new Promise((r) => platform.listen(0, '127.0.0.1', r));
    const verifyUrl = `http://127.0.0.1:${platform.address().port}/digital-human/api/dh/user/current`;

    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        BASE_DATASOURCES_URL: `${mock.baseUrl}/datasources`,
        APP_UUID: '6a2ad1f0-0000-4000-8000-000000000001',
        APP_SCHEMA: '6a2ad1f0-0000-4000-8000-000000000001',
        APP_DATASOURCE_ID: '100',
        DH_ADMIN_USERS: 'boss01',
        DH_DEV_TOKEN: 'fixed-dev-token-for-tests',
    });
    delete process.env.DH_OPEN_ADMIN;
    delete process.env.DH_USER_VERIFY_URL;
    const { createServer } = await import('../src/server.js');
    const app = await createServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const me = async (headers) => (await fetch(`${url}/api/auth/me`, { headers })).json();

    try {
        // ── 开发者免登录 ──
        const bad = await fetch(`${url}/dev-login?token=wrong`, { redirect: 'manual' });
        assert.equal(bad.status, 403);
        const ok = await fetch(`${url}/dev-login?token=fixed-dev-token-for-tests`, { redirect: 'manual' });
        assert.equal(ok.status, 302);
        assert.equal(ok.headers.get('location'), './');
        const setCookie = ok.headers.get('set-cookie') || '';
        assert.match(setCookie, /dh_dev_admin=[^;]+;.*HttpOnly/);
        const devCookie = setCookie.split(';')[0];
        const dev = await me({ cookie: devCookie });
        assert.equal(dev.username, 'dev-admin');
        assert.equal(dev.identified, true);
        assert.equal(dev.isAdmin, true);
        assert.equal(dev.devAdmin, true);
        // 篡改签名无效
        const forged = await me({ cookie: devCookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) });
        assert.notEqual(forged.username, 'dev-admin');

        // 管理员生成令牌：明文只返回一次，可换会话；吊销后旧会话失效
        const gen = await (await fetch(`${url}/api/debug/dev-login/token`, {
            method: 'POST', headers: { cookie: devCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 1 }),
        })).json();
        assert.match(gen.token, /^dhdev_/);
        assert.equal(gen.loginPath, `dev-login?token=${encodeURIComponent(gen.token)}`);
        const genLogin = await fetch(`${url}/${gen.loginPath}`, { redirect: 'manual' });
        assert.equal(genLogin.status, 302);
        const genCookie = (genLogin.headers.get('set-cookie') || '').split(';')[0];
        assert.equal((await me({ cookie: genCookie })).devAdmin, true);
        assert.equal((await fetch(`${url}/api/debug/dev-login/token`, { method: 'DELETE', headers: { cookie: devCookie } })).status, 200);
        assert.notEqual((await me({ cookie: genCookie })).username, 'dev-admin');
        // 普通用户不能生成令牌
        assert.equal((await fetch(`${url}/api/debug/dev-login/token`, {
            method: 'POST', headers: { 'x-dh-user': 'someone', 'Content-Type': 'application/json' }, body: '{}',
        })).status, 403);

        // ── 未配置核验地址：保持原行为，x-dh-user 照常采信 ──
        assert.equal((await me({ 'x-dh-user': 'boss01' })).isAdmin, true);

        // ── 配置核验地址 ──
        const put = await fetch(`${url}/api/debug/identity-verify`, {
            method: 'PUT', headers: { cookie: devCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: verifyUrl }),
        });
        assert.equal(put.status, 200);
        assert.equal((await put.json()).verify.url, verifyUrl);

        // 伪造：真实会话是 alice，却自称管理员 boss01 → 按 alice 处理，没有管理员权限
        const spoof = await me({ 'x-dh-user': 'boss01', cookie: 'sso=alice' });
        assert.equal(spoof.username, 'alice');
        assert.equal(spoof.isAdmin, false);
        // 一致：照常识别，并标记已核验
        const real = await me({ 'x-dh-user': 'boss01', cookie: 'sso=boss01' });
        assert.equal(real.username, 'boss01');
        assert.equal(real.isAdmin, true);
        assert.equal(real.identityVerified, true);
        // 没有底座会话：按未登录处理
        assert.equal((await me({ 'x-dh-user': 'boss01', cookie: 'sso=' })).identified, false);
        assert.equal((await fetch(`${url}/api/ai/sessions`, { headers: { 'x-dh-user': 'boss01' } })).status, 401);
        // 核验接口不通：照常识别，但不给管理员权限
        const down = await me({ 'x-dh-user': 'boss01', cookie: 'sso=down' });
        assert.equal(down.username, 'boss01');
        assert.equal(down.identified, true);
        assert.equal(down.isAdmin, false);
    } finally {
        await app.close();
        platform.close();
        await mock.close();
    }
});
