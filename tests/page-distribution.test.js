// 平台页面全员开放（与主线版 page-distribution 一致）：业务页面默认开放、数据库浏览器锁定仅超管；
// 收回后普通用户打不开页面、也调不了页面背后的接口；超管照常。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockBaseServer } from './helpers/mock-base.js';

const mock = await startMockBaseServer();
Object.assign(process.env, {
    LOCAL_DEV_MEMORY: '0', LOG_LEVEL: 'silent',
    BASE_QUERY_URL: `${mock.baseUrl}/query`, BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
    APP_SCHEMA: 'page-dist', APP_UUID: 'page-dist', APP_DATASOURCE_ID: '2', DH_ADMIN_USERS: 'admin01',
});
delete process.env.DH_OPEN_ADMIN;
const { createServer } = await import('../src/server.js');
test.after(() => mock.close());

test('pages are shared by default, can be withdrawn, and withdrawing blocks both the page and its APIs', async () => {
    const app = await createServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const as = (user) => ({ cookie: `iLearningXUserName=${user}` });
    const pages = async (user) => {
        const body = await (await fetch(`${url}/api/distribution/pages`, { headers: as(user) })).json();
        return (body.data || body).pages;
    };
    const patch = (user, id, sharedAccess) => fetch(`${url}/api/distribution`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', ...as(user) }, body: JSON.stringify({ kind: 'page', id, sharedAccess }),
    });
    try {
        const listed = await pages('admin01');
        const byId = Object.fromEntries(listed.map((p) => [p.id, p]));
        assert.equal(byId.expedite.sharedAccess, true, '业务页面默认开放');
        assert.equal(byId['db-explorer'].locked, true);
        assert.equal(byId['db-explorer'].sharedAccess, false);

        assert.notEqual((await fetch(`${url}/expedite`, { headers: as('bob') })).status, 403);
        assert.equal((await patch('bob', 'expedite', false)).status, 403, '普通用户不能改');
        assert.equal((await patch('admin01', 'expedite', false)).status, 200);
        assert.equal((await fetch(`${url}/expedite`, { headers: as('bob') })).status, 403);
        const api = await fetch(`${url}/api/expedite/list`, { headers: as('bob') });
        assert.equal(api.status, 403);
        assert.equal((await api.json()).code, 'PAGE_NOT_SHARED');
        assert.notEqual((await fetch(`${url}/expedite`, { headers: as('admin01') })).status, 403, '超管照常');
        assert.equal((await pages('admin01')).find((p) => p.id === 'expedite').sharedAccess, false);

        // 锁定页面不能开放给全员；开放回来后普通用户恢复访问，且不会被默认值重新覆盖
        assert.notEqual((await patch('admin01', 'db-explorer', true)).status, 200);
        assert.equal((await patch('admin01', 'expedite', true)).status, 200);
        assert.notEqual((await fetch(`${url}/expedite`, { headers: as('bob') })).status, 403);
        assert.equal((await patch('admin01', 'monthly', false)).status, 200);
        assert.equal((await pages('admin01')).find((p) => p.id === 'monthly').sharedAccess, false, '默认值只种一次');
    } finally {
        await app.close();
    }
});
