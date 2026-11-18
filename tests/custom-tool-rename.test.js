// 自定义工具改名（与主线版 PATCH /api/custom-tools/:slug/name 一致）：英文界面带 nameEn 只改英文名；
// 只能改自己发布的工具，管理员都能改；内置工具不能改。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockBaseServer } from './helpers/mock-base.js';

const mock = await startMockBaseServer();
Object.assign(process.env, {
    LOCAL_DEV_MEMORY: '0', LOG_LEVEL: 'silent',
    BASE_QUERY_URL: `${mock.baseUrl}/query`, BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
    APP_SCHEMA: 'tool-rename', APP_UUID: 'tool-rename', APP_DATASOURCE_ID: '2', DH_ADMIN_USERS: 'admin01',
});
delete process.env.DH_OPEN_ADMIN;
const { createServer } = await import('../src/server.js');
test.after(() => mock.close());

test('tool owners rename the Chinese or English name; others cannot', async () => {
    const app = await createServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const as = (user) => ({ 'Content-Type': 'application/json', cookie: `iLearningXUserName=${user}` });
    const call = async (user, method, path, body) => {
        const res = await fetch(`${url}${path}`, { method, headers: as(user), body: body && JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
    };
    try {
        const created = await call('bob', 'POST', '/api/custom-tools', { name: '计数器', nameEn: 'Counter', htmlContent: '<html><body>1</body></html>' });
        const slug = (created.body.data || created.body).slug;
        const en = await call('bob', 'PATCH', `/api/custom-tools/${slug}/name`, { name: '计数器', nameEn: 'Tally' });
        assert.equal(en.status, 200);
        const tool = (en.body.data || en.body).tool;
        assert.deepEqual([tool.name, tool.nameEn], ['计数器', 'Tally']);
        const zh = (await call('bob', 'PATCH', `/api/custom-tools/${slug}/name`, { name: '人数计数' })).body;
        assert.deepEqual([(zh.data || zh).tool.name, (zh.data || zh).tool.nameEn], ['人数计数', 'Tally'], '只改中文名时英文名不变');
        assert.equal((await call('carol', 'PATCH', `/api/custom-tools/${slug}/name`, { name: '别人的' })).status, 404, '别人的私有工具看不到');
        assert.equal((await call('bob', 'PATCH', `/api/custom-tools/${slug}/name`, { name: '' })).status, 400);
        assert.equal((await call('admin01', 'PATCH', `/api/custom-tools/${slug}/name`, { name: '管理员改名' })).status, 200);
    } finally {
        await app.close();
    }
});

test('browser bookmarks are per user, sanitized, and only super admins can change them', async () => {
    const app = await createServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${app.server.address().port}/api/agent-workspace/browser/bookmarks`;
    const as = (user) => ({ 'Content-Type': 'application/json', cookie: `iLearningXUserName=${user}` });
    const post = (user, body) => fetch(url, { method: 'POST', headers: as(user), body: JSON.stringify(body) });
    const list = async (user) => { const b = await (await fetch(url, { headers: as(user) })).json(); return (b.data || b).items; };
    try {
        assert.equal((await post('admin01', { url: 'https://u:p@example.test/a?token=x&q=1', title: 'A' })).status, 200);
        assert.deepEqual(await list('admin01'), [{ url: 'https://example.test/a?q=1', title: 'A' }]);
        assert.deepEqual(await list('bob'), [], '每人一份');
        assert.equal((await post('bob', { url: 'https://example.test/b' })).status, 403);
        assert.equal((await post('admin01', { url: 'file:///etc/passwd' })).status, 400);
        await post('admin01', { url: 'https://example.test/a?q=1', remove: true });
        assert.deepEqual(await list('admin01'), []);
    } finally {
        await app.close();
    }
});

