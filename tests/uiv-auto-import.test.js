// UIVF12 自动导入：抓取页每抓到一张表就 POST 一次 { name, rows }（与桌面版下载拦截脚本一致），
// 会话要逐表追加，而不是每次覆盖；导入页读取全部表、服务端直接归档、导入完成后删除会话。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockBaseServer } from './helpers/mock-base.js';

const json = (headers = {}) => ({ 'Content-Type': 'application/json', cookie: 'iLearningXUserName=user01', ...headers });

test('per-table uploads accumulate in one session, are archived on the server and removed afterwards', async () => {
    const mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        APP_SCHEMA: 'auto-import-test',
        APP_UUID: 'auto-import-test',
        APP_DATASOURCE_ID: '2',
        DH_ADMIN_USERS: 'admin01',
    });
    delete process.env.DH_OPEN_ADMIN;
    const { createServer } = await import('../src/server.js');
    const app = await createServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const sid = 'a'.repeat(32), token = 'b'.repeat(32);
    const post = (body, t = token) => fetch(`${url}/api/uiv-auto-import/${sid}/datasets?token=${t}`, { method: 'POST', headers: json(), body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    try {
        // 抓取脚本的真实请求形状：一次一张表
        const first = await post({ name: 'risk.csv', rows: [{ 名称: '甲', 值: 'a,"b"' }], origin: 'https://site.example' });
        assert.equal(first.body?.dataset?.rowCount, 1, first.status + ' ' + JSON.stringify(first.body));
        // 桥接上传：同一张表分片追加（重复的分片号只收一次）
        await post({ name: 'bridge.csv', rows: [{ n: 1 }], append: true, clientUploadId: 'u1', chunkIndex: 0 });
        await post({ name: 'bridge.csv', rows: [{ n: 1 }], append: true, clientUploadId: 'u1', chunkIndex: 0 });
        assert.equal((await post({ name: 'bridge.csv', rows: [{ n: 2 }], append: true, clientUploadId: 'u1', chunkIndex: 1 })).body.dataset.rowCount, 2, 'chunks append, a repeated chunk is ignored');
        assert.equal((await post({ name: 'plain', rows: [{ k: 1 }] })).body.count, 3, 'each table is appended, not a replacement');
        // 桌面端补传的同名文件被跳过；补传先到、页面上传后到时以页面上传为准
        assert.equal((await post({ name: 'risk.csv', rows: [{ 名称: 'disk' }], fallback: true })).body.skipped, true);
        await post({ name: 'z.csv', rows: [{ v: 'disk' }], fallback: true });
        await post({ name: 'z.csv', rows: [{ v: 'page' }] });
        assert.equal((await post({ name: 'x.csv', rows: [{ a: 1 }] }, 'c'.repeat(32))).status, 403, 'a different token cannot write into the session');

        const session = await (await fetch(`${url}/api/uiv-auto-import/${sid}?token=${token}`, { headers: json() })).json();
        assert.deepEqual(session.datasets.map((d) => [d.name, d.rows.length]), [['risk.csv', 1], ['bridge.csv', 2], ['plain', 1], ['z.csv', 1]]);
        assert.equal(session.datasets[3].rows[0].v, 'page');
        assert.equal(session.token, undefined, 'the token is never echoed back');
        assert.equal((await fetch(`${url}/api/uiv-auto-import/${sid}?token=${'c'.repeat(32)}`, { headers: json() })).status, 403);

        // 旧的一次性 { datasets } 形状仍可用
        const legacy = 'd'.repeat(32);
        await fetch(`${url}/api/uiv-auto-import/${legacy}/datasets`, { method: 'POST', headers: json(), body: JSON.stringify({ datasets: [{ name: 'a.csv', rows: [{ x: 1 }] }, { name: 'b.csv', rows: [{ y: 2 }] }] }) });
        assert.equal((await (await fetch(`${url}/api/uiv-auto-import/${legacy}`, { headers: json() })).json()).datasets.length, 2);

        // 服务端归档：开启原始数据上传后，直接把会话存成一批原始表格
        const admin = json({ cookie: 'iLearningXUserName=admin01' });
        const off = await (await fetch(`${url}/api/upload/source-batches/from-auto-import`, { method: 'POST', headers: admin, body: JSON.stringify({ sessionId: sid, token }) })).json();
        assert.equal(off.uploadOriginals, false, 'follows the original-upload switch like the page does');
        await fetch(`${url}/api/upload/import-settings`, { method: 'PUT', headers: admin, body: JSON.stringify({ uploadOriginals: true }) });
        const archived = await (await fetch(`${url}/api/upload/source-batches/from-auto-import`, { method: 'POST', headers: admin, body: JSON.stringify({ sessionId: sid, token, targetMonth: 11 }) })).json();
        assert.ok(archived.batchId, JSON.stringify(archived));
        assert.deepEqual(archived.files.map((f) => [f.name, f.rows]), [['risk.csv', 1], ['bridge.csv', 2], ['plain.csv', 1], ['z.csv', 1]]);
        const missing = await fetch(`${url}/api/upload/source-batches/from-auto-import`, { method: 'POST', headers: admin, body: JSON.stringify({ sessionId: 'e'.repeat(32), token }) });
        assert.equal(missing.status, 404);

        // 导入完成后删除会话
        assert.equal((await (await fetch(`${url}/api/uiv-auto-import/${sid}?token=${token}`, { method: 'DELETE', headers: json() })).json()).success, true);
        assert.equal((await fetch(`${url}/api/uiv-auto-import/${sid}?token=${token}`, { headers: json() })).status, 404);
    } finally {
        await app.close();
        await mock.close();
    }
});
