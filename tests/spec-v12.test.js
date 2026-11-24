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

        // 下载/导出带 x-dh-envelope: 1 时，无权限返回信封 403，有权限返回原始文件且不包信封
        const exportDenied = await fetch(`${url}/api/db-explorer/governance/dictionary/export`, {
            headers: { 'x-dh-user': 'bob', 'x-dh-envelope': '1' },
        });
        assert.equal(exportDenied.headers.get('x-dh-status'), '403');
        const exportOk = await fetch(`${url}/api/db-explorer/governance/dictionary/export`, {
            headers: { 'x-dh-user': 'z00569258', 'x-dh-envelope': '1' },
        });
        assert.equal(exportOk.status, 200);
        assert.notEqual(exportOk.headers.get('x-dh-envelope'), '1');
        assert.match(exportOk.headers.get('content-disposition') || '', /attachment; filename="table-dictionary-/);
        assert.equal(Buffer.from(await exportOk.arrayBuffer()).subarray(0, 2).toString(), 'PK', '默认导出 Excel');

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

    // 验证所有常见路径都正确重写为带网关前缀和 .html 后缀的真实文件，dhStripBase 能还原
    assert.equal(sandbox.dhResolveUrl('/sla'), `${basePrefix}/sla.html`);
    assert.equal(sandbox.dhResolveUrl('/monthly/legacy'), `${basePrefix}/monthly-legacy.html`);
    assert.equal(sandbox.dhResolveUrl('/ai-report?month=2026-10'), `${basePrefix}/monthly.html?month=2026-10`);
    assert.equal(sandbox.dhResolveUrl('/custom-tools/my-report/'), `${basePrefix}/custom-tool.html?slug=my-report`);
    assert.equal(sandbox.dhResolveUrl('/custom-tools/my-report/?tab=1'), `${basePrefix}/custom-tool.html?tab=1&slug=my-report`);
    assert.equal(sandbox.dhStripBase(`${basePrefix}/`), '/');
    assert.equal(sandbox.dhStripBase(`${basePrefix}/sla.html`), '/sla.html');

    // 验证「更多 → 快捷工具」在网关子路径重写下仍能排除首页(/)与系统工具
    const navSrc = fs.readFileSync(path.join(ROOT, 'static/js/shared/platform-settings-controller.js'), 'utf8');
    const fnMatch = navSrc.match(/function isNavSidebarShortcut\(href\)\s*\{[\s\S]*?\n\}/);
    assert.ok(fnMatch, '应存在 isNavSidebarShortcut 函数');
    vm.runInNewContext(fnMatch[0], sandbox);
    assert.equal(sandbox.isNavSidebarShortcut('/'), false);
    assert.equal(sandbox.isNavSidebarShortcut(`${basePrefix}/`), false);
    assert.equal(sandbox.isNavSidebarShortcut(`${basePrefix}/index.html`), false);
    assert.equal(sandbox.isNavSidebarShortcut(`${basePrefix}/topic-analysis.html`), true);

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

test('dh-runtime.js 全局鉴权下载与服务端 attachment 响应放行', async () => {
    const runtimeSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'shared', 'dh-runtime.js'), 'utf8');
    const basePrefix = '/digital-human/dh/5b5def8e-13a9-4542-b5e1-1522845ca141';
    const savedLinks = [];
    const blobUrls = new Map();
    let blobSeq = 0;

    const fakeFetch = async (url, init = {}) => {
        const headers = new Headers(init.headers || {});
        const target = String(url);
        if (target === '/digital-human/api/dh/user/current') {
            return new Response(JSON.stringify({ code: 0, data: { uid: 'd00000001', cn: '管理员' } }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (target.endsWith('/dictionary/export')) {
            assert.equal(decodeURIComponent(headers.get('x-dh-user') || ''), 'd00000001');
            assert.equal(headers.get('x-dh-envelope'), '1');
            return new Response('table_name,name_cn\nusers,用户表\n', {
                status: 200,
                headers: {
                    'Content-Type': 'text/csv; charset=utf-8',
                    'Content-Disposition': 'attachment; filename="table-dictionary-2026-11-23.csv"',
                    'Content-Length': '34',
                },
            });
        }
        return new Response(JSON.stringify({ code: 403, message: '仅超级管理员可用', data: { error: '仅超级管理员可用' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'x-dh-envelope': '1', 'x-dh-status': '403' },
        });
    };

    const makeAnchor = () => ({
        href: '',
        download: '',
        style: {},
        dataset: {},
        click() { savedLinks.push({ href: this.href, download: this.download }); },
        remove() {},
    });
    const makeFakeEl = () => ({
        setAttribute() {},
        appendChild() {},
        remove() {},
        querySelector: () => makeFakeEl(),
        addEventListener() {},
        classList: { add() {}, remove() {}, contains: () => false },
        style: {},
        children: [],
    });
    const fakeDocument = {
        readyState: 'complete',
        cookie: '',
        currentScript: null,
        documentElement: { classList: { add() {} }, appendChild() {} },
        head: { appendChild() {} },
        body: { appendChild() {} },
        getElementById: () => null,
        querySelector: () => null,
        createElement: (tag) => (tag === 'a' ? makeAnchor() : makeFakeEl()),
        addEventListener: () => {},
    };
    class FakeURL extends URL {
        static createObjectURL(blob) {
            const id = `blob:test/${++blobSeq}`;
            blobUrls.set(id, blob);
            return id;
        }
        static revokeObjectURL(id) { blobUrls.delete(id); }
    }
    const sandbox = {
        URL: FakeURL,
        URLSearchParams,
        Headers,
        Response,
        Request,
        Blob,
        AbortController,
        Element: { prototype: {} },
        MutationObserver: class { observe() {} },
        CustomEvent: class CustomEvent { constructor(t, opts = {}) { this.type = t; this.detail = opts.detail; } },
        document: fakeDocument,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        location: {
            href: `https://netcareclaw.gde.huawei.com${basePrefix}/db-explorer.html`,
            origin: 'https://netcareclaw.gde.huawei.com',
            pathname: `${basePrefix}/db-explorer.html`,
        },
        fetch: fakeFetch,
        addEventListener: () => {},
        dispatchEvent: () => {},
        setTimeout: () => 0,
        clearTimeout: () => {},
    };
    sandbox.window = sandbox;
    vm.runInNewContext(runtimeSrc, sandbox);

    const okRes = await sandbox.dhDownload('/api/db-explorer/governance/dictionary/export');
    assert.equal(okRes.filename, 'table-dictionary-2026-11-23.csv');
    assert.equal(savedLinks.length, 1);
    assert.equal(savedLinks[0].download, 'table-dictionary-2026-11-23.csv');
    assert.match(await okRes.blob.text(), /table_name,name_cn/);

    await assert.rejects(() => sandbox.dhDownload('/api/db-explorer/governance/forbidden/export'), /仅超级管理员可用/);

    sandbox.dhDownload.saveBlob(new Blob(['hello'], { type: 'text/plain' }), 'hello.txt');
    assert.equal(savedLinks.length, 2);
    assert.equal(savedLinks[1].download, 'hello.txt');
});

test('dh-runtime.js 全局鉴权图片加载与 Blob 缓存（需求图片/对话附件图不再 401）', async () => {
    const runtimeSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'shared', 'dh-runtime.js'), 'utf8');
    const basePrefix = '/digital-human/dh/7746a1d1-27c7-4139-90aa-b772336c940f';
    const fetchCalls = [];
    const blobUrls = new Map();
    let blobSeq = 0;

    const fakeFetch = async (url, init = {}) => {
        const u = String(url);
        const headers = new Headers(init.headers || {});
        fetchCalls.push({ url: u, headers });
        if (u === '/digital-human/api/dh/user/current') {
            return new Response(JSON.stringify({ code: 0, data: { uid: 'dWX1545337', cn: 'dragon WX1545337', canAccessSystem: true } }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (u === `${basePrefix}/api/requirements/12/images/0`) {
            assert.equal(headers.get('x-dh-user'), 'dWX1545337', '图片请求必须携带基座身份头 x-dh-user');
            return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
                status: 200,
                headers: { 'Content-Type': 'image/webp' },
            });
        }
        return new Response(JSON.stringify({ code: 0, message: 'ok', data: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'x-dh-envelope': '1' },
        });
    };

    class FakeHTMLImageElement {
        constructor() {
            this.tagName = 'IMG';
            this.nodeType = 1;
            this.dataset = {};
            this._src = '';
            this.rawSrcHistory = [];
        }
        get src() { return this._src; }
        set src(val) {
            this._src = String(val ?? '');
            this.rawSrcHistory.push(this._src);
        }
        getAttribute(k) { return k === 'src' ? this._src : (k === 'data-dh-api-src' ? (this.dataset.dhApiSrc || null) : null); }
        setAttribute(k, v) { if (k === 'src') this.src = v; }
    }
    class FakeURL extends URL {
        static createObjectURL(blob) {
            const id = `blob:img/${++blobSeq}`;
            blobUrls.set(id, blob);
            return id;
        }
        static revokeObjectURL(id) { blobUrls.delete(id); }
    }
    const fakeDocument = {
        readyState: 'complete',
        cookie: '',
        currentScript: null,
        documentElement: { nodeType: 1, classList: { add() {} }, appendChild() {}, querySelectorAll: () => [] },
        head: { appendChild() {} },
        body: { appendChild() {} },
        getElementById: () => null,
        querySelector: () => null,
        createElement: () => ({ style: {}, classList: { add() {} }, setAttribute() {}, appendChild() {} }),
        addEventListener: () => {},
    };
    const sandbox = {
        URL: FakeURL,
        URLSearchParams,
        Headers,
        Response,
        Request,
        Blob,
        Event: class Event { constructor(t) { this.type = t; } },
        HTMLImageElement: FakeHTMLImageElement,
        Element: { prototype: {} },
        MutationObserver: class { observe() {} },
        CustomEvent: class CustomEvent { constructor(t, opts = {}) { this.type = t; this.detail = opts.detail; } },
        document: fakeDocument,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        location: {
            href: `https://netcareclaw.gde.huawei.com${basePrefix}/requirements.html`,
            origin: 'https://netcareclaw.gde.huawei.com',
            pathname: `${basePrefix}/requirements.html`,
        },
        fetch: fakeFetch,
        addEventListener: () => {},
        dispatchEvent: () => {},
        setTimeout: () => 0,
        clearTimeout: () => {},
    };
    sandbox.window = sandbox;
    vm.runInNewContext(runtimeSrc, sandbox);

    // 1. 需求缩略图 img.src = '/api/requirements/12/images/0'：拦截直连 401，带鉴权拉取并赋 blob URL
    const thumbImg = new FakeHTMLImageElement();
    thumbImg.src = '/api/requirements/12/images/0';
    assert.ok(thumbImg.rawSrcHistory.every((s) => !s.includes('/api/requirements/')), '绝不把未鉴权的 /api/ 路径直接交由浏览器 <img> 直连');
    assert.equal(thumbImg.src, `${basePrefix}/api/requirements/12/images/0`, '加载中读取 .src 返回逻辑 API 地址');
    await sandbox.dhLoadImage('/api/requirements/12/images/0');
    await new Promise((r) => setImmediate(r));
    assert.equal(thumbImg.src, 'blob:img/1');
    const imgFetches = fetchCalls.filter((c) => c.url === `${basePrefix}/api/requirements/12/images/0`);
    assert.equal(imgFetches.length, 1);

    // 2. 点击缩略图打开大图预览：同步命中 Blob 缓存，零额外请求
    const modalImg = new FakeHTMLImageElement();
    modalImg.src = '/api/requirements/12/images/0';
    assert.equal(modalImg.src, 'blob:img/1');
    assert.equal(fetchCalls.filter((c) => c.url === `${basePrefix}/api/requirements/12/images/0`).length, 1);

    // 3. innerHTML 里的 /api/* 图片改写成 data-dh-api-src + 透明占位，静态资源图保持原样
    const rewritten = sandbox.dhRewriteHtml('<img src="/api/agent-files/raw?path=uploads/1/a.png" alt="shot"><img src="/assets/logo.png">');
    assert.match(rewritten, new RegExp(`data-dh-api-src="${basePrefix}/api/agent-files/raw\\?path=uploads/1/a\\.png"`));
    assert.match(rewritten, /src="data:image\/gif;base64,/);
    assert.match(rewritten, new RegExp(`<img src="${basePrefix}/assets/logo\\.png">`));
});
