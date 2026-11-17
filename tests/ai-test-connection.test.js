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
const { authHeaders, resolveAuthMode, hasUsableCredentials } = await import('../src/services/ai-service.js');
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
        // 保存下来的方案带上认证方式，不保存证书校验开关
        const settings = await (await fetch(`${url}/api/ai-settings`, { headers: { cookie: 'iLearningXUserName=admin01' } })).json();
        const profiles = (settings.data || settings).profiles;
        const saved = profiles.find((p) => p.name === 'gw');
        assert.equal(saved.authMode, 'api-key');
        assert.equal(saved.verifySsl, undefined);
    } finally {
        await app.close();
        await new Promise((r) => gateway.close(r));
    }
});
