// Spec v1.2 规范对齐与基座 2.0 线上问题回归测试：
// 1. §7.2 baseRequest 注入 x-app-id
// 2. §12.5 平台身份（x-dh-user / x-dh-displayname、dh-runtime.js、/api/auth/me）
// 3. Nginx 静态直出页与自定义 HTML 工具 /api/custom-tools/:slug/{meta,raw,bridge}
// 4. §3 / §13 / §15 仓库与打包配置（mirrors.tools.huawei.com、>=22 <23）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { startMockBaseServer } from './helpers/mock-base.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('Spec §7.2 + §12.5: 基座请求注入 x-app-id，且 /api/auth/me 与权限优先采信 x-dh-user / x-dh-displayname', async () => {
    const appUuid = '5b5def8e-13a9-4542-b5e1-1522845ca141';
    const seenAppIds = [];
    const mock = await startMockBaseServer();
    // 包一层轻量代理记录实际到达基座的 x-app-id 头
    const proxy = http.createServer((req, res) => {
        seenAppIds.push({ path: req.url, xAppId: req.headers['x-app-id'] || '' });
        const target = new URL(req.url, mock.baseUrl);
        const fwd = http.request(target, { method: req.method, headers: req.headers }, (up) => {
            res.writeHead(up.statusCode || 200, up.headers);
            up.pipe(res);
        });
        req.pipe(fwd);
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const proxyBase = `http://127.0.0.1:${proxy.address().port}`;

    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${proxyBase}/query`,
        BASE_EXECUTE_URL: `${proxyBase}/execute`,
        BASE_DATASOURCES_URL: `${proxyBase}/datasources`,
        APP_UUID: appUuid,
        APP_SCHEMA: appUuid,
        APP_DATASOURCE_ID: '100',
        BUSINESS_DATASOURCE_NAME: 'netcare_test',
    });
    delete process.env.DH_OPEN_ADMIN;
    delete process.env.DH_ADMIN_USERS;
    const { createServer } = await import('../src/server.js');
    const app = await createServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${app.server.address().port}`;

    try {
        // 触发一次基座 /execute（首访自动初始化管理员并写 app_admins）与 /query
        const me = await (await fetch(`${url}/api/auth/me`, {
            headers: {
                'x-dh-user': encodeURIComponent('z00569258'),
                'x-dh-displayname': encodeURIComponent('zhouxiaoming 00569258'),
                cookie: 'iLearningXUserName=cookie_fallback',
            },
        })).json();
        assert.equal(me.username, 'z00569258');
        assert.equal(me.displayName, 'zhouxiaoming 00569258');
        assert.equal(me.source, 'platform:dh/user/current');
        assert.equal(me.identified, true);
        assert.equal(me.isAdmin, true);

        const slaRes = await fetch(`${url}/api/sla/snapshots`, {
            headers: { 'x-dh-user': 'z00569258' },
        });
        assert.equal(slaRes.status, 200);
        assert.ok(seenAppIds.length >= 1, '应有请求转发至基座');
        assert.ok(seenAppIds.every((r) => r.xAppId === appUuid), `所有基座请求都应携带 x-app-id=${appUuid}`);

        // 验证 /custom-tools 经过 /api/custom-tools/:slug/{meta,raw,bridge} 对非管理员本人工具可用
        const created = await (await fetch(`${url}/api/custom-tools`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-dh-user': 'z00569258' },
            body: JSON.stringify({ name: 'Nginx 直出看板', htmlContent: '<html><head><title>board</title></head><body>ok</body></html>' }),
        })).json();
        // 普通用户 bob 自己建的私有工具可通过 /api/custom-tools/:slug/{meta,raw,bridge} 访问
        const bobCreated = await (await fetch(`${url}/api/custom-tools`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-dh-user': 'bob', 'x-dh-displayname': encodeURIComponent('Bob 张') },
            body: JSON.stringify({ name: 'Bob 私有看板', htmlContent: '<html><head><title>bob</title></head><body>hi</body></html>' }),
        })).json();
        const meta = await fetch(`${url}/api/custom-tools/${bobCreated.slug}/meta`, { headers: { 'x-dh-user': 'bob' } });
        assert.equal(meta.status, 200);
        assert.equal((await meta.json()).name, 'Bob 私有看板');
        assert.equal((await fetch(`${url}/api/custom-tools/${bobCreated.slug}/meta`, { headers: { 'x-dh-user': 'carol' } })).status, 404);

        const raw = await fetch(`${url}/api/custom-tools/${bobCreated.slug}/raw`, { headers: { 'x-dh-user': 'bob' } });
        assert.equal(raw.status, 200);
        assert.match(raw.headers.get('content-security-policy'), /connect-src 'none'/);
        assert.match(await raw.text(), /window\.DH=/);

        const bridgeMe = await fetch(`${url}/api/custom-tools/${bobCreated.slug}/bridge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-dh-user': 'bob', 'x-dh-displayname': encodeURIComponent('Bob 张') },
            body: JSON.stringify({ method: 'me' }),
        });
        assert.equal(bridgeMe.status, 200);
        assert.deepEqual(await bridgeMe.json(), { username: 'bob', displayName: 'Bob 张', isAdmin: false });
        assert.equal(created.visibility, 'public');
    } finally {
        await app.close();
        proxy.close();
        await mock.close();
    }
});

test('Nginx 静态直出页面与 dh-runtime.js：路径映射、自定义工具外壳、平台用户拉取与头注入', async () => {
    const requiredHtml = [
        'index.html', 'uivf12.html', 'sla.html', 'report.html', 'expedite.html',
        'monthly.html', 'monthly-legacy.html', 'bigscreen.html', 'db-explorer.html',
        'topic-analysis.html', 'duty-roster.html', 'frt.html', 'praudit.html', 'custom-tool.html',
    ];
    for (const file of requiredHtml) {
        const full = path.join(ROOT, 'static', file);
        assert.ok(fs.existsSync(full), `static/${file} 应存在于 static 根目录以供基座 Nginx 直出`);
    }
    assert.equal(fs.existsSync(path.join(ROOT, 'static', 'pages')), false, 'static/pages 应已迁出至 static 根目录，避免相对路径偏移');

    // 在沙箱 VM 中验证 dh-runtime.js 的 URL 映射与 /api/dh/user/current 头注入行为
    const runtimeSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'shared', 'dh-runtime.js'), 'utf8');
    const storage = new Map([['csrfToken', 'csrf-test-123']]);
    const fetchCalls = [];
    const basePrefix = '/digital-human/dh/5b5def8e-13a9-4542-b5e1-1522845ca141';

    const fakeFetch = async (url, init = {}) => {
        fetchCalls.push({ url: String(url), headers: new Headers(init.headers || {}) });
        if (String(url) === '/digital-human/api/dh/user/current') {
            return new Response(JSON.stringify({ code: 0, data: { uid: 'z00569258', cn: 'zhouxiaoming 00569258', canAccessSystem: true } }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        return new Response(JSON.stringify({ code: 0, message: 'ok', data: { username: 'z00569258', displayName: 'zhouxiaoming 00569258' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'x-dh-envelope': '1' },
        });
    };

    const listeners = {};
    const makeStore = (map) => ({
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
    });
    const fakeDocument = {
        readyState: 'complete',
        cookie: '',
        currentScript: null,
        documentElement: { classList: { add() {} } },
        head: { appendChild() {} },
        body: { appendChild() {} },
        querySelector: () => null,
        createElement: () => ({}),
        addEventListener: () => {},
    };
    const sandbox = {
        URL,
        URLSearchParams,
        Headers,
        Response,
        Request,
        Element: { prototype: {} },
        MutationObserver: class { observe() {} },
        CustomEvent: class CustomEvent { constructor(t, opts = {}) { this.type = t; this.detail = opts.detail; } },
        document: fakeDocument,
        localStorage: makeStore(storage),
        sessionStorage: makeStore(new Map()),
        location: {
            href: `https://netcareclaw-beta.icta138.huawei.com${basePrefix}/`,
            origin: 'https://netcareclaw-beta.icta138.huawei.com',
            pathname: `${basePrefix}/`,
        },
        fetch: fakeFetch,
        addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
        dispatchEvent: () => {},
        setTimeout,
        clearTimeout,
    };
    sandbox.window = sandbox;
    vm.runInNewContext(runtimeSrc, sandbox);

    // 验证所有常见路径都正确重写为带网关前缀和 .html 后缀的真实文件
    assert.equal(sandbox.dhResolveUrl('/sla'), `${basePrefix}/sla.html`);
    assert.equal(sandbox.dhResolveUrl('/monthly/legacy'), `${basePrefix}/monthly-legacy.html`);
    assert.equal(sandbox.dhResolveUrl('/ai-report?month=2026-10'), `${basePrefix}/monthly.html?month=2026-10`);
    assert.equal(sandbox.dhResolveUrl('/custom-tools/my-report/'), `${basePrefix}/custom-tool.html?slug=my-report`);
    assert.equal(sandbox.dhResolveUrl('/custom-tools/my-report/?tab=1'), `${basePrefix}/custom-tool.html?tab=1&slug=my-report`);

    // 紧接着发起 /api/auth/me，应等待 /digital-human/api/dh/user/current 返回后自动注入身份头
    const meResp = await sandbox.fetch('/api/auth/me');
    const meJson = await meResp.json();
    assert.equal(meJson.displayName, 'zhouxiaoming 00569258');

    const userCall = fetchCalls.find((c) => c.url === '/digital-human/api/dh/user/current');
    assert.ok(userCall, '应调用平台 /digital-human/api/dh/user/current');
    assert.equal(userCall.headers.get('x-csrf-token'), 'csrf-test-123');

    const authCall = fetchCalls.find((c) => c.url === `${basePrefix}/api/auth/me`);
    assert.ok(authCall, '应改写 /api/auth/me 到网关前缀下');
    assert.equal(decodeURIComponent(authCall.headers.get('x-dh-user')), 'z00569258');
    assert.equal(decodeURIComponent(authCall.headers.get('x-dh-displayname')), 'zhouxiaoming 00569258');
    assert.ok(JSON.parse(storage.get('dh_platform_user')).displayName === 'zhouxiaoming 00569258');
});

test('Spec v1.2 打包与依赖配置检查：mirrors.tools.huawei.com 与 engines.node >=22 <23', () => {
    const npmrc = fs.readFileSync(path.join(ROOT, '.npmrc'), 'utf8');
    assert.match(npmrc, /^registry=http:\/\/mirrors\.tools\.huawei\.com\/npm\/$/m);
    assert.match(npmrc, /^strict-ssl=false$/m);
    assert.match(npmrc, /^engine-strict=false$/m);

    const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
    assert.equal(appJson.runtimeVersion, '22.21.1');
    assert.equal(
        appJson.install.command,
        'rm -rf node_modules && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --engine-strict=false',
    );
    assert.equal(appJson.install.registry, undefined);

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const litePkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'profiles/lite/package.json'), 'utf8'));
    assert.equal(pkg.engines.node, '>=22 <23');
    assert.equal(litePkg.engines.node, '>=22 <23');
});
