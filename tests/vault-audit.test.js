// 保险箱密钥（每人只能看自己的、密文落库、查看明文记审计）与审计日志（仅管理员、分页、按客户端筛选）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockBaseServer } from './helpers/mock-base.js';

const UA_PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1';
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';

test('保险箱密钥与审计日志', async () => {
    const mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        APP_SCHEMA: 'vault-test',
        APP_UUID: 'vault-test',
        APP_DATASOURCE_ID: '2',
    });
    delete process.env.DH_OPEN_ADMIN;
    delete process.env.DH_ADMIN_USERS;
    const { createServer } = await import('../src/server.js');
    const app = await createServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const call = async (user, method, path, body, extra = {}) => {
        const headers = { 'user-agent': UA_MAC, ...(user ? { cookie: `iLearningXUserName=${user}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra };
        const res = await fetch(`${url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { data = text; }
        return { status: res.status, data, headers: res.headers };
    };

    try {
        // alice 第一个进来 → 管理员；bob 普通用户，用手机
        assert.equal((await call('alice', 'GET', '/api/auth/me')).data.isAdmin, true);
        assert.equal((await call('bob', 'GET', '/api/auth/me', undefined, { 'user-agent': UA_PHONE, 'X-Client-Platform': 'mobile_web' })).data.isAdmin, false);
        await call('alice', 'GET', '/api/auth/me'); // 8 小时内重复进入不再记

        // ── 保险箱：只有密钥页，不需要登录密码复核 ──
        const home = await call('bob', 'GET', '/api/vault/');
        assert.equal(home.status, 200);
        assert.deepEqual(home.data.entries, []);
        assert.equal(home.data.features.logins, false);
        assert.equal(home.data.features.reauth, false);
        assert.equal(home.headers.get('cache-control'), 'no-store');

        // 普通用户能存自己的密钥；名称校验与主线版一致
        assert.equal((await call('bob', 'POST', '/api/vault/secrets', { name: 'bad name', value: 'x' })).status, 400);
        assert.equal((await call('bob', 'POST', '/api/vault/secrets', { name: 'WISE_API_KEY', value: '' })).status, 400);
        const created = await call('bob', 'POST', '/api/vault/secrets', { name: 'WISE_API_KEY', value: 'sk-bob-secret-123', category: 'api_key', label: '记账' });
        assert.equal(created.status, 200);
        assert.equal(created.data.created, true);
        assert.equal(created.data.secret.name, 'WISE_API_KEY');
        assert.equal(created.data.secret.value, undefined);
        const id = created.data.secret.id;
        // 同名再存 = 覆盖
        assert.equal((await call('bob', 'POST', '/api/vault/secrets', { name: 'WISE_API_KEY', value: 'sk-bob-secret-456' })).data.created, false);

        // 列表不含明文；落库的也不是明文
        const list = (await call('bob', 'GET', '/api/vault/secrets')).data.secrets;
        assert.equal(list.length, 1);
        assert.ok(!JSON.stringify(list).includes('sk-bob'));
        const { getRecord } = await import('../src/services/record-store.js');
        const stored = await getRecord('vault_secret', id);
        assert.match(stored.payload.cipher, /^enc:s1:/);
        assert.ok(!JSON.stringify(stored).includes('sk-bob'));

        // alice（管理员）看不到 bob 的，也不能查看、改、删
        assert.deepEqual((await call('alice', 'GET', '/api/vault/secrets')).data.secrets, []);
        assert.equal((await call('alice', 'POST', `/api/vault/secrets/${id}/reveal`, {})).status, 404);
        assert.equal((await call('alice', 'PUT', `/api/vault/secrets/${id}`, { label: 'x' })).status, 404);
        assert.equal((await call('alice', 'DELETE', `/api/vault/secrets/${id}`)).status, 404);

        // 本人查看明文；改名后仍能解开；留空 value 表示不改
        assert.equal((await call('bob', 'POST', `/api/vault/secrets/${id}/reveal`, {})).data.value, 'sk-bob-secret-456');
        const renamed = await call('bob', 'PUT', `/api/vault/secrets/${id}`, { name: 'WISE_KEY', value: '', category: 'token', label: '新备注' });
        assert.equal(renamed.status, 200);
        assert.equal(renamed.data.secret.name, 'WISE_KEY');
        assert.equal(renamed.data.secret.category, 'token');
        assert.equal((await call('bob', 'POST', `/api/vault/secrets/${id}/reveal`, {})).data.value, 'sk-bob-secret-456');
        // 服务端按名称取用，记使用次数
        const { getSecret } = await import('../src/services/vault-service.js');
        assert.equal((await getSecret('bob', 'WISE_KEY')).value, 'sk-bob-secret-456');
        assert.equal(await getSecret('alice', 'WISE_KEY'), null);
        assert.equal((await call('bob', 'GET', '/api/vault/secrets')).data.secrets[0].useCount, 1);

        // ── 审计日志：仅管理员 ──
        assert.equal((await call('bob', 'GET', '/api/auth/audit')).status, 403);
        await call('alice', 'PUT', '/api/auth/admins', { users: ['alice', 'carol'] });
        await call('bob', 'POST', '/api/auth/logout', {});
        // 未登录访问业务接口被拒，记一次登录失败（同一来源 10 分钟内只记一次）
        assert.equal((await call('', 'GET', '/api/agent-skills')).status, 401);
        assert.equal((await call('', 'GET', '/api/custom-tools')).status, 401);
        await new Promise((r) => setTimeout(r, 150)); // 登录 / 拒绝类审计是不等待的后台写入

        const all = (await call('alice', 'GET', '/api/auth/audit?limit=50')).data;
        const count = (action) => all.items.filter((i) => i.action === action).length;
        assert.equal(count('login'), 2, 'alice、bob 各一次登录');
        assert.equal(count('vault_reveal'), 2);
        assert.equal(count('admins_update'), 1);
        assert.equal(count('logout'), 1);
        assert.equal(count('login_failed'), 1);
        assert.equal(all.total, all.items.length);
        assert.equal(all.page, 1);
        assert.equal(all.totalPages, 1);
        const reveal = all.items.find((i) => i.action === 'vault_reveal');
        assert.equal(reveal.actor, 'bob');
        assert.match(reveal.target, /^WISE_/);
        assert.ok(!JSON.stringify(all).includes('sk-bob'), '审计里不出现明文');
        const aliceLogin = all.items.find((i) => i.action === 'login' && i.actor === 'alice');
        assert.equal(aliceLogin.platform, 'web');
        assert.match(aliceLogin.device, /^Mac/);
        assert.match(aliceLogin.clientVersion, /^Chrome 126/);
        assert.ok(aliceLogin.ip);

        // 按客户端筛选 + 分页
        const mobile = (await call('alice', 'GET', '/api/auth/audit?platform=mobile_web')).data;
        assert.equal(mobile.total, 1);
        assert.equal(mobile.items[0].actor, 'bob');
        assert.match(mobile.items[0].device, /^iPhone \(iOS 17\.4\)/);
        const page2 = (await call('alice', 'GET', '/api/auth/audit?limit=2&page=2')).data;
        assert.equal(page2.items.length, 2);
        assert.equal(page2.pageSize, 2);
        assert.equal(page2.totalPages, Math.ceil(all.total / 2));
        assert.deepEqual(page2.items.map((i) => i.id), all.items.slice(2, 4).map((i) => i.id), '新的在前，翻页连续');
        assert.equal((await call('alice', 'GET', '/api/auth/audit?actor=bob&action=logout')).data.total, 1);

        // 删除
        assert.equal((await call('bob', 'DELETE', `/api/vault/secrets/${id}`)).status, 200);
        assert.deepEqual((await call('bob', 'GET', '/api/vault/secrets')).data.secrets, []);
    } finally {
        await app.close();
        await mock.close();
    }
});
