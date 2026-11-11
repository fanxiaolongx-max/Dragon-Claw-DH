import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockBaseServer } from './helpers/mock-base.js';

// 大字段分片：写入时切片、读取时拼回、覆盖和删除后回收旧分片。
// 设了 DH_REAL_BASE 时同一用例跑在真实 MySQL 8 上。
test('超过阈值的字段自动分片存储，读写结果与原值完全一致，旧分片会被回收', async () => {
    const mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        DH_CHUNK_CHARS: '8192',
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        APP_SCHEMA: 'chunk-test',
        APP_DATASOURCE_ID: '2',
    });
    const dao = await import('../src/dao/scoped.js');
    const chunkCount = async () => (await dao.selectTable('dh_chunks', { columns: ['ref', 'idx'], limit: 5000 })).length;
    const key = `chunk_case_${Date.now()}`;
    const where = { whereSql: `\`kv_key\` = ${dao.sqlVal(key)}`, memFilter: () => true };

    try {
        // 8191 个 ASCII 后紧跟表情：分片边界正好落在代理对中间；再混入引号、反斜杠、换行
        const big = `${'a'.repeat(8191)}😀${"中文'引号\"与\\反斜杠\n换行 %_ ".repeat(4000)}尾巴😀`;
        assert.ok(big.length > 8192 * 5);

        await dao.kvSet(key, big);
        assert.equal(await dao.kvGet(key), big, '读回的内容必须和写入的逐字一致');
        const first = await chunkCount();
        assert.ok(first >= 6, `应切成多片，实际 ${first}`);

        // 应用库里原字段只剩标记，单条 SQL 都不超过阈值的几倍
        const sqls = mock.auditRequests.filter((r) => r.path === '/execute').map((r) => String(r.body.sql).length);
        assert.ok(Math.max(...sqls) < 8192 * 4, `单条 SQL 过大：${Math.max(...sqls)}`);

        // 覆盖成另一份大数据：旧分片回收，不累积
        const big2 = { rows: Array.from({ length: 900 }, (_, i) => ({ i, name: `条目 ${i} 😀`, note: 'x'.repeat(40) })) };
        await dao.kvSet(key, big2);
        assert.deepEqual(await dao.kvGet(key), big2);
        const second = await chunkCount();
        assert.ok(second > 0 && second < first + 3, `旧分片应被回收：${first} → ${second}`);

        // 覆盖成小数据：不再分片，旧分片清空
        await dao.kvSet(key, { small: true });
        assert.deepEqual(await dao.kvGet(key), { small: true });
        assert.equal(await chunkCount(), 0);

        // 删除带分片的行：分片一并回收
        await dao.kvSet(key, big);
        assert.ok(await chunkCount() > 0);
        await dao.deleteRows('sys_kv_store', where);
        assert.equal(await dao.kvGet(key, null), null);
        assert.equal(await chunkCount(), 0);

        // updateRows 路径
        await dao.kvSet(key, 'v1');
        await dao.updateRows('sys_kv_store', { kv_value: big }, where);
        assert.equal(await dao.kvGet(key), big);
        await dao.deleteRows('sys_kv_store', where);
        assert.equal(await chunkCount(), 0);

        assert.deepEqual(mock.sqlErrors, []);
    } finally {
        await mock.close();
    }
});
