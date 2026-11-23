// 模型方案的认证方式（与主线版一致）与「测试连接」失败详情：地址、状态、原文、排查建议，且全部脱敏。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockBaseServer } from './helpers/mock-base.js';

// 配置在首次加载时读取环境变量：先起假基座、设好变量，再加载应用代码
const mock = await startMockBaseServer();
Object.assign(process.env, {
    LOCAL_DEV_MEMORY: '0', LOG_LEVEL: 'silent',
    BASE_QUERY_URL: `${mock.baseUrl}/query`, BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
    APP_SCHEMA: 'ai-test-conn', APP_UUID: 'ai-test-conn', APP_DATASOURCE_ID: '2', DH_ADMIN_USERS: 'admin01',
});
delete process.env.DH_OPEN_ADMIN;
const { authHeaders, resolveAuthMode, hasUsableCredentials, aiDispatcherFor } = await import('../src/services/ai-service.js');
const { sanitizeEndpointUrl } = await import('../src/services/ai-test-diagnostics.js');
test.after(() => mock.close());

test('auth modes map to the request headers gateways expect; legacy Anthropic API-key choice keeps working', () => {
    const key = 'sk-test-1234567890';
    assert.deepEqual(authHeaders({ apiKey: key }), { Authorization: `Bearer ${key}` });
    assert.deepEqual(authHeaders({ apiKey: key, authMode: 'api-key' }), { 'api-key': key });
    assert.deepEqual(authHeaders({ apiKey: key, authMode: 'custom', customAuthHeader: 'X-API-Key' }), { 'X-API-Key': key });
    assert.deepEqual(authHeaders({ apiKey: key, authMode: 'custom', customAuthHeader: 'bad header\n' }), { Authorization: `Bearer ${key}` }, 'invalid header names fall back to Bearer');
    assert.deepEqual(authHeaders({ apiKey: key, authMode: 'none' }), {});
    assert.equal(resolveAuthMode({ provider: 'anthropic', anthropicAuthType: 'ANTHROPIC_API_KEY' }), 'x-api-key');
    assert.equal(hasUsableCredentials({ authMode: 'none' }), true);
    assert.equal(hasUsableCredentials({ authMode: 'bearer' }), false);
    assert.equal(sanitizeEndpointUrl('https://u:p@gw.example/v1/chat/completions?key=abc'), 'https://gw.example/v1/chat/completions');
    // 证书校验：默认不校验，只有明确勾选才走严格校验
    assert.equal(aiDispatcherFor({}), aiDispatcherFor({ verifySsl: false }));
    assert.notEqual(aiDispatcherFor({ verifySsl: true }), aiDispatcherFor({}));
});

test('a failing connection test returns details and a hint, with the key never echoed back', async () => {
    const seen = [];
    const gateway = http.createServer((req, res) => {
        seen.push(req.headers);
        res.writeHead(401, { 'content-type': 'text/html' });
        res.end('<html><body>Login required for sk-test-1234567890</body></html>');
    });
    await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
    const { createServer } = await import('../src/server.js');
    const app = await createServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${app.server.address().port}`;
    try {
        const res = await fetch(`${url}/api/ai-settings/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', cookie: 'iLearningXUserName=admin01' },
            body: JSON.stringify({ name: 'gw', provider: 'openai', apiBaseUrl: `http://127.0.0.1:${gateway.address().port}/v1`, apiKey: 'sk-test-1234567890', model: 'm1', authMode: 'api-key' }),
        });
        const body = await res.json();
        const payload = body.data && body.data.details ? body.data : body;
        assert.equal(seen[0]['api-key'], 'sk-test-1234567890', 'the chosen auth header is sent');
        assert.equal(seen[0].authorization, undefined);
        assert.equal(payload.success, false);
        assert.equal(payload.details.upstreamStatus, 401);
        assert.match(payload.details.endpoint, /\/v1\/chat\/completions$/);
        assert.match(payload.details.hint, /HTML|鉴权/);
        assert.doesNotMatch(JSON.stringify(payload), /sk-test-1234567890/, 'the key is redacted from every field');
        // 保存下来的方案带上认证方式；证书校验默认关闭（兼容内网自签证书网关）
        const settings = await (await fetch(`${url}/api/ai-settings`, { headers: { cookie: 'iLearningXUserName=admin01' } })).json();
        const profiles = (settings.data || settings).profiles;
        const saved = profiles.find((p) => p.name === 'gw');
        assert.equal(saved.authMode, 'api-key');
        assert.equal(saved.verifySsl, false);
    } finally {
        await app.close();
        await new Promise((r) => gateway.close(r));
    }
});

test('self-signed HTTPS gateways work by default; ticking certificate verification rejects them', async (t) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const https = await import('node:https');
    const { execFileSync } = await import('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-tls-'));
    const keyPath = path.join(dir, 'k.pem');
    const certPath = path.join(dir, 'c.pem');
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
    } catch {
        t.skip('openssl not available');
        return;
    }
    const server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, (req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '通了' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { streamModel } = await import('../src/agent/provider.js');
    const settings = { provider: 'openai', apiBaseUrl: `https://127.0.0.1:${server.address().port}/v1`, apiKey: 'test-key-1234567890', model: 'm', maxOutputTokens: 256 };
    const run = (extra) => streamModel({ settings: { ...settings, ...extra }, system: '', messages: [{ role: 'user', content: 'hi' }] });
    try {
        assert.equal((await run({})).text, '通了', '默认不校验证书');
        await assert.rejects(run({ verifySsl: true }), '勾选校验后拒绝自签证书');
    } finally {
        await new Promise((r) => server.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('dryRun test does not persist probe profile, and image category activates independently + tests /images/generations', async () => {
    const requests = [];
    const upstream = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            requests.push({ url: req.url, body: JSON.parse(raw || '{}') });
            res.writeHead(200, { 'content-type': 'application/json' });
            if (req.url === '/v1/images/generations') {
                res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('PNG_OK').toString('base64') }] }));
                return;
            }
            res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
        });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const { createServer } = await import('../src/server.js');
    const app = await createServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const apiBaseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
    const headers = { 'Content-Type': 'application/json', cookie: 'iLearningXUserName=admin01' };
    try {
        const before = await (await fetch(`${url}/api/ai-settings`, { headers: { cookie: headers.cookie } })).json();
        const beforeCount = (before.data || before).profiles.length;

        const dryRes = await fetch(`${url}/api/ai-settings/test`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                dryRun: true,
                name: '01平台临时测试',
                category: 'chat',
                provider: 'openai-compatible',
                apiBaseUrl,
                apiKey: 'sk-01-probe-key-123456',
                model: 'qwen3.8-27b',
                authMode: 'bearer',
            }),
        });
        assert.equal(dryRes.status, 200);
        const afterDry = await (await fetch(`${url}/api/ai-settings`, { headers: { cookie: headers.cookie } })).json();
        assert.equal((afterDry.data || afterDry).profiles.length, beforeCount, 'dryRun must not persist temporary test profile');

        // Save + activate chat (qwen3.8-27b) and image (qwen-image-2.1) independently
        const chatCreate = await (await fetch(`${url}/api/ai-settings/profiles`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                name: '01 平台 · qwen3.8-27b',
                category: 'chat',
                provider: 'openai-compatible',
                authMode: 'bearer',
                apiBaseUrl,
                apiKey: 'sk-01-live-key-123456',
                model: 'qwen3.8-27b',
                models: ['qwen3.8-27b'],
                activate: true,
            }),
        })).json();
        const chatId = (chatCreate.data || chatCreate).createdProfileId;

        const imgCreate = await (await fetch(`${url}/api/ai-settings/profiles`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                name: '01 平台 · qwen-image-2.1',
                category: 'image',
                provider: 'openai-compatible',
                authMode: 'bearer',
                apiBaseUrl,
                apiKey: 'sk-01-live-key-123456',
                model: 'qwen-image-2.1',
                models: ['qwen-image-2.1'],
                activate: true,
            }),
        })).json();
        const imgId = (imgCreate.data || imgCreate).createdProfileId;

        const latest = await (await fetch(`${url}/api/ai-settings`, { headers: { cookie: headers.cookie } })).json();
        const latestData = latest.data || latest;
        assert.equal(latestData.activeProfileId, chatId);
        assert.equal(latestData.activeImageProfileId, imgId);
        assert.equal(latestData.profiles.find((p) => p.id === chatId)?.isActive, true);
        assert.equal(latestData.profiles.find((p) => p.id === imgId)?.isActive, true);

        const imgTestRes = await fetch(`${url}/api/ai-settings/profiles/${encodeURIComponent(imgId)}/test`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: 'qwen-image-2.1' }),
        });
        assert.equal(imgTestRes.status, 200);
        const imgTestBody = await imgTestRes.json();
        assert.equal((imgTestBody.data || imgTestBody).success, true);
        assert.equal(requests.some((r) => r.url === '/v1/images/generations' && r.body.model === 'qwen-image-2.1'), true);
    } finally {
        await app.close();
        await new Promise((r) => upstream.close(r));
    }
});

test('base platform-settings.js renders 01 onboarding card, preserves fields on provider change, and auto-retries verifySsl', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const vm = await import('node:vm');
    const src = fs.readFileSync(path.join(process.cwd(), 'static/js/shared/platform-settings.js'), 'utf8');
    const elements = new Map();
    const content = {
        id: 'navSettingsContent',
        _html: '',
        set innerHTML(val) {
            this._html = String(val || '');
            elements.clear();
            const tagRe = /<(input|select|textarea|button|div|span|section)\b([^>]*)>/gi;
            const attrRe = /([a-zA-Z0-9:-]+)(?:="([^"]*)")?/g;
            let m;
            while ((m = tagRe.exec(this._html))) {
                const attrs = {};
                let a;
                attrRe.lastIndex = 0;
                while ((a = attrRe.exec(m[2]))) attrs[a[1]] = a[2] !== undefined ? a[2] : '';
                if (!attrs.id) continue;
                elements.set(attrs.id, {
                    id: attrs.id,
                    type: attrs.type || 'text',
                    value: attrs.value || '',
                    checked: 'checked' in attrs,
                    hidden: 'hidden' in attrs,
                    innerHTML: '',
                    textContent: '',
                    dataset: {},
                    style: {},
                    classList: { toggle() {}, add() {}, remove() {} },
                    focus() {},
                    scrollIntoView() {},
                    setAttribute() {},
                });
            }
        },
        get innerHTML() { return this._html; },
    };
    const calls = [];
    const store = {
        activeProfileId: 'default-profile',
        activeImageProfileId: '',
        profiles: [{
            id: 'default-profile', name: '默认模型', category: 'chat', provider: 'openai',
            authMode: 'bearer', apiBaseUrl: '', model: 'gpt-4o-mini', models: ['gpt-4o-mini'],
            hasApiKey: false, maskedApiKey: '', apiKeySource: 'none', keyLooksValid: false, isActive: true, verifySsl: false,
        }],
    };
    const fetchMock = async (reqUrl, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ reqUrl, method: init.method || 'GET', body });
        if (reqUrl === '/api/ai-settings') return new Response(JSON.stringify(store), { status: 200 });
        if (reqUrl === '/api/ai-settings/test') return new Response(JSON.stringify({ success: true, model: body.model, reply: 'OK' }), { status: 200 });
        if (reqUrl === '/api/ai-settings/profiles' && init.method === 'POST') {
            const id = body.category === 'image' ? 'base-img' : 'base-chat';
            store.profiles.push({ ...body, id, hasApiKey: true, keyLooksValid: true, isActive: false });
            return new Response(JSON.stringify({ ...store, createdProfileId: id }), { status: 201 });
        }
        const act = reqUrl.match(/^\/api\/ai-settings\/profiles\/([^/]+)\/activate$/);
        if (act) {
            const id = decodeURIComponent(act[1]);
            const target = store.profiles.find((p) => p.id === id);
            store.profiles.forEach((p) => { if ((p.category || 'chat') === (target.category || 'chat')) p.isActive = p.id === id; });
            if (target.category === 'image') store.activeImageProfileId = id;
            else store.activeProfileId = id;
            return new Response(JSON.stringify(store), { status: 200 });
        }
        const put = reqUrl.match(/^\/api\/ai-settings\/profiles\/([^/]+)$/);
        if (put && init.method === 'PUT') {
            Object.assign(store.profiles.find((p) => p.id === decodeURIComponent(put[1])) || {}, body);
            return new Response(JSON.stringify(store), { status: 200 });
        }
        if (reqUrl.endsWith('/test')) {
            if (body.verifySsl === false) return new Response(JSON.stringify({ success: false, error: 'Timeout', details: { httpStatus: 504, errorCode: '20', cause: 'This operation was aborted' } }), { status: 504 });
            return new Response(JSON.stringify({ success: true, model: body.model, reply: 'OK' }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };
    const windowObj = { dispatchEvent() {}, addEventListener() {} };
    const ctx = {
        window: windowObj,
        document: {
            getElementById: (id) => (id === 'navSettingsContent' ? content : (elements.get(id) || (id === 'navAiModelsList' ? { innerHTML: '' } : null))),
            querySelector: () => null,
            querySelectorAll: () => [],
            createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove() {} }),
            body: { appendChild() {} },
        },
        Event: class Event { constructor(t) { this.type = t; } },
        fetch: fetchMock,
        URL,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        setTimeout: (fn, ms) => globalThis.setTimeout(fn, Math.min(ms, 5)),
        clearTimeout: (id) => globalThis.clearTimeout(id),
        navState: { lang: 'zh-CN', aiCategory: 'chat', aiQuickDraftBaseUrl: 'http://models.ascend.huawei.com', aiQuickDraftToken: '' },
        navEscape: (s) => String(s ?? ''),
        navT: (k) => k,
        navLocaleText: (zh, en) => zh || en,
        getAuthHeaderForNav: () => ({}),
        isNavSuperAdmin: () => ctx.__super !== false,
        resolveAiAuthModeForUi: (s) => s?.authMode || 'bearer',
        renderAiUsagePanel: () => '',
        loadAiUsageData: () => {},
        showPlatformConfirm: async () => true,
        console,
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    for (const k of Object.keys(windowObj)) if (!(k in ctx)) ctx[k] = windowObj[k];

    ctx.__super = false;
    await ctx.renderAiSettings(content);
    assert.doesNotMatch(content.innerHTML, /01平台接入/, '模型由超级管理员统一配置：其他人看不到 01 平台接入');
    ctx.__super = true;
    await ctx.renderAiSettings(content);
    assert.match(content.innerHTML, /01平台接入/);
    assert.match(content.innerHTML, /http:\/\/models\.ascend\.huawei\.com\/sign-up\?aff=KizX/);

    elements.get('navAiQuickToken').value = 'sk-base-zeroone-token-1234';
    await windowObj.saveZeroOneQuickConfig();
    assert.equal(store.activeProfileId, 'base-chat');
    assert.equal(store.activeImageProfileId, 'base-img');

    ctx.navState.currentEditingModels = ['deepseek-v4.1-flash', 'qwen3.8-27b'];
    elements.get('navAiModel').value = 'deepseek-v4.1-flash';
    elements.get('navAiApiBaseUrl').value = 'http://models.ascend.huawei.com';
    elements.get('navAiVerifySsl').checked = false;
    windowObj.handleAiProviderChange();
    windowObj.handleAiApiBaseUrlInput();
    assert.equal(elements.get('navAiModel').value, 'deepseek-v4.1-flash');
    assert.equal(elements.get('navAiVerifySsl').checked, true);

    elements.get('navAiVerifySsl').checked = false;
    await windowObj.testAiSettingsNow('deepseek-v4.1-flash');
    const retries = calls.filter((c) => c.reqUrl.endsWith('/test') && c.reqUrl.includes('/profiles/'));
    assert.equal(retries.length, 2);
    assert.equal(elements.get('navAiVerifySsl').checked, true);
});

