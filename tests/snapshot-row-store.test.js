// 快照明细行去重存储：多份快照共享同一份压缩数据，读出来与原来一致；
// 旧快照可逐条转换；没人引用的数据块会被回收；月报资料库只读需要的那一份。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockBaseServer } from './helpers/mock-base.js';

const rows = (n, tag = '') => Array.from({ length: n }, (_, i) => ({ id: `T${i}`, name: `部门${i % 4}${tag}`, note: 'x'.repeat(80), 'a,"b"': i }));
const snapshot = (id, timestamp, sections) => ({
    id, timestamp, files: ['risk.csv'], topMetrics: [{ key: 'k', label: '闭环率', value: '97%', sourceSelections: [{ sectionKey: 'risk', indexes: [0, 2] }] }],
    sourceSections: sections.map(([key, data]) => ({ key, title: key, headers: Object.keys(data[0] || {}), sourceFiles: [`${key}.csv`], rows: data })),
});

test('snapshots share one compressed copy of unchanged tables, read back unchanged, convert old rows and collect garbage', async () => {
    const mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        APP_SCHEMA: 'row-store-test',
        APP_UUID: 'row-store-test',
        APP_DATASOURCE_ID: '2',
        SNAPSHOT_ROWS_COMPACT_DELAY_MS: String(24 * 3600 * 1000),
    });
    try {
        const sla = await import('../src/services/sla-service.js');
        const upload = await import('../src/services/upload-service.js');
        const rowStore = await import('../src/services/snapshot-row-store.js');
        const { selectTable, kvGet, parseJsonCol, upsertRow } = await import('../src/dao/scoped.js');
        const raw = async (id) => parseJsonCol((await selectTable('sla_snapshots', { whereSql: `\`id\` = '${id}'`, limit: 1 }))[0].payload_json, {});
        const blobCount = async () => Object.keys((await kvGet('snapshot_rows_index', {})) || {}).length;

        const big = rows(300);
        const day1 = snapshot('day1', '2026-11-16T08:00:00.000Z', [['risk', big], ['other_a', rows(3)]]);
        const day2 = snapshot('day2', '2026-11-17T08:00:00.000Z', [['risk', big], ['other_a', rows(3, '改')]]);
        await sla.addSnapshot(day1);
        await sla.addSnapshot(day2);

        const stored = await raw('day1');
        assert.equal(stored.sourceSections[0].rows, undefined, 'detail rows are not stored inline');
        assert.equal(stored.sourceSections[0].rowCount, 300);
        assert.equal((await raw('day2')).sourceSections[0].rowsRef, stored.sourceSections[0].rowsRef, 'the unchanged table is stored once');
        assert.equal(await blobCount(), 3);
        const blob = await kvGet(`snapshot_rows:${stored.sourceSections[0].rowsRef}`, null);
        assert.ok(blob.data.length * 4 < blob.rawBytes, `compressed ${blob.data.length} vs ${blob.rawBytes}`);

        const list = await sla.listSnapshots({ view: 'full' });
        assert.deepEqual(list.find((s) => s.id === 'day1').sourceSections, day1.sourceSections);
        assert.deepEqual((await sla.getLatestSnapshot()).sourceSections[1].rows, rows(3, '改'));
        assert.deepEqual((await sla.getSnapshotById('day1')).sourceSections[0].rows, big);

        // 月报资料库：目录只要行数，单张表与指标溯源读得到明细
        const catalog = await upload.getSourceCatalog({ days: 0 });
        const section = catalog.snapshots.find((s) => s.id === 'day1').sections.find((sec) => sec.key === 'risk');
        assert.equal(section.rowCount, 300, 'row counts come from the stored reference without restoring rows');
        assert.deepEqual((await upload.getSection('day1', 'risk')).rows, big);
        assert.deepEqual((await upload.getMetricTable('day1', 'k')).rows, [big[0], big[2]]);

        // 规则刷新只改指标，明细引用不变
        await sla.updateSnapshot('day2', { topMetrics: [{ key: 'k', label: '闭环率', value: '98%' }] });
        const updated = await sla.getSnapshotById('day2');
        assert.deepEqual([updated.topMetrics[0].value, updated.sourceSections[0].rows.length], ['98%', 300]);

        // 旧快照（明细内嵌）照常可读，转换后读出来一样，可重复执行
        const legacy = snapshot('legacy', '2026-11-10T08:00:00.000Z', [['risk', rows(20, '旧')]]);
        await upsertRow('sla_snapshots', { id: 'legacy', category: '', name: 'legacy', snapshot_time: legacy.timestamp, payload_json: JSON.stringify(legacy), created_at: Date.now() }, ['id']);
        assert.deepEqual((await sla.getSnapshotById('legacy')).sourceSections, legacy.sourceSections);
        assert.equal((await sla.compactSnapshotRows({ pauseMs: 0 })).converted, 1);
        assert.equal((await raw('legacy')).sourceSections[0].rows, undefined);
        assert.deepEqual((await sla.getSnapshotById('legacy')).sourceSections, legacy.sourceSections);
        assert.equal((await sla.compactSnapshotRows({ pauseMs: 0 })).converted, 0);

        // 删除 day1：它独有的小表没人引用了；保护期内不回收，过了才回收，共享的大表保留
        await sla.deleteSnapshot('day1');
        const before = await blobCount();
        assert.equal(await rowStore.collectGarbage(), 0);
        assert.equal(await rowStore.collectGarbage({ graceMs: -1 }), 1);
        assert.equal(await blobCount(), before - 1);
        assert.deepEqual((await sla.getSnapshotById('day2')).sourceSections[0].rows, big);

        const missing = await rowStore.hydrate({ sourceSections: [{ key: 'x', rowsRef: 'f'.repeat(64), rowCount: 3 }] });
        assert.deepEqual([missing.sourceSections[0].rows, missing.sourceSections[0].rowsMissing], [[], true]);
    } finally {
        await mock.close();
    }
});
