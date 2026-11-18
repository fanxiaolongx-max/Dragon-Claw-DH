// 对话工具 get_expiring_followups：读最新一期入库报表的临期 / 超期催办明细（与主线版 getLatestSnapshotFollowups 口径一致），
// 「一键催办」未开放时普通账号读不到。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockBaseServer } from './helpers/mock-base.js';

const mock = await startMockBaseServer();
Object.assign(process.env, {
    LOCAL_DEV_MEMORY: '0', LOG_LEVEL: 'silent',
    BASE_QUERY_URL: `${mock.baseUrl}/query`, BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
    APP_SCHEMA: 'followups', APP_UUID: 'followups', APP_DATASOURCE_ID: '2',
});
const dao = await import('../src/dao/scoped.js');
const { TOOLS } = await import('../src/agent/tools.js');
const { setPageAccess } = await import('../src/services/distribution-service.js');
test.after(() => mock.close());

test('lists upcoming and overdue follow-ups from the latest snapshot, sorted by urgency', async () => {
    const tool = TOOLS.find((t) => t.name === 'get_expiring_followups');
    const viewer = { username: 'bob', isAdmin: false };
    assert.match((await tool.run({}, { identity: viewer })).summary, /尚无入库报表/);
    const day = 86_400_000;
    const iso = (offset) => new Date(Date.now() + offset).toISOString();
    await dao.insertRow('report_snapshots', { id: 1, snapshot_id: 'old', month: 10, created_at: '2026-10-30', raw_data_json: JSON.stringify({ expiringTickets: [] }) });
    await dao.insertRow('report_snapshots', {
        id: 2, snapshot_id: 'snap-2', month: 11, created_at: '2026-11-17',
        raw_data_json: JSON.stringify({ expiringTickets: [
            { collection: 'risk', deadline: iso(-2 * day), data: { risk_id: 'R-1', owner: '甲' } },
            { collection: 'rectification', deadline: iso(2 * day), data: { task_id: 'T-9', fullname: '乙' } },
            { collection: 'sr', title: '🔧 SR 合集', data: { sr_num: 'SR-3' } },
        ] }),
    });
    const out = await tool.run({}, { identity: viewer });
    assert.equal(out.ok, true);
    const body = JSON.parse(out.content);
    assert.equal(body.snapshot.id, 'snap-2');
    assert.deepEqual(body.items.map((i) => [i.id, i.status, i.kind, i.owner]), [
        ['T-9', 'upcoming', '整改', '乙'], ['R-1', 'overdue', '风险', '甲'], ['SR-3', 'unknown', 'SR', null],
    ]);
    assert.equal(body.dueWithin3Days, 1);
    assert.equal(body.overdue, 1);

    await setPageAccess('expedite', false);
    assert.equal((await tool.run({}, { identity: viewer })).ok, false, '一键催办收回后普通账号读不到');
    assert.equal((await tool.run({}, { identity: { username: 'root', isSuper: true } })).ok, true);
});
