// 指标条件值别名 [旧名]|[新名]，以及对话里批量修改条件值：确认卡预览命中行数、执行、按处回退。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startMockBaseServer } from './helpers/mock-base.js';

const extraction = createRequire(import.meta.url)('../static/js/shared/metric-extraction.js');
const PREF_KEY = 'sla_prefs_other_eos';
const prefs = () => ({
    customMetrics: [
        { id: 'm_1', colX: 'name', valY: '汇总', colZ: 'closed_rate', label: '产品风险闭环率', subMetrics: [
            { category: 'B', colX: 'name', valY: '虚拟系统部', colZ: 'closed_rate' },
            { category: 'A', colX: 'name', valY: '甲系统部', colZ: 'closed_rate' },
        ] },
        { id: 'm_2', type: 'count', colX: 'name', valY: '甲系统部', colZ: 'status', valK: '[非空]', label: '甲计数' },
    ],
});

test('aliases match either name and keep plain values, literal bars and [空]/[非空] unchanged', () => {
    assert.equal(extraction.cellMatches('甲方新名系统部', '[甲系统部]|[甲方新名系统部]'), true);
    assert.equal(extraction.cellMatches('乙系统部', '[甲系统部]|[甲方新名系统部]'), false);
    assert.equal(extraction.cellMatches('a|b', 'a|b'), true);
    assert.equal(extraction.cellMatches('', '[空]|[x]'), true);
    assert.equal(extraction.formatAliases(['甲系统部', '甲方新名系统部']), '[甲系统部]|[甲方新名系统部]');
});

test('Dragon chat finds zero-match conditions, adds an alias after approval and reverts per field', async () => {
    const mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        APP_SCHEMA: 'sla-rules-test',
        APP_UUID: 'sla-rules-test',
        APP_DATASOURCE_ID: '2',
    });
    try {
        const sla = await import('../src/services/sla-service.js');
        const { toolByName } = await import('../src/agent/tools.js');
        await sla.upsertPrefItem(PREF_KEY, prefs());
        await sla.addSnapshot({ id: 'snap-1', timestamp: '2026-11-17T08:00:00.000Z', topMetrics: [], sourceSections: [{ key: 'other_eos', rows: [
            { name: '甲方新名系统部', closed_rate: '1', status: 'x' },
            { name: '虚拟系统部', closed_rate: '0.9', status: '' },
            { name: '汇总', closed_rate: '0.97', status: '' },
        ] }] });
        const admin = { identity: { username: 'boss', isAdmin: true } };
        const user = { identity: { username: 'guest', isAdmin: false } };

        const found = JSON.parse((await toolByName.get('sla_find_metric_rules').run({ unmatched: true }, admin)).content);
        const et = found.items.find((item) => item.subCategory === 'A');
        assert.deepEqual([et.matchedRows, et.unmatchedValuesInData], [0, ['甲方新名系统部']]);
        assert.equal((await toolByName.get('sla_find_metric_rules').run({}, user)).ok, false, 'admins only');

        const update = toolByName.get('sla_update_metric_conditions');
        const args = { replacements: [{ from: '甲系统部', addAliases: ['甲方新名系统部'] }], summary: '系统部改名' };
        assert.ok((await update.approval(args, user)).error);
        const { preview } = await update.approval(args, admin);
        assert.match(preview.title, /修改 2 处/);
        assert.ok(preview.fields.some((f) => /甲系统部 → \[甲系统部\]\|\[甲方新名系统部\]（命中 0 → 1 行）/.test(f.value)), JSON.stringify(preview.fields));

        const applied = await update.run(args, admin);
        assert.ok(applied.ok, applied.content);
        const changeId = applied.content.match(/rc_[a-z0-9_]+/)[0];
        let current = (await sla.getPrefsObject())[PREF_KEY].customMetrics;
        assert.deepEqual([current[0].subMetrics[1].valY, current[1].valY], ['[甲系统部]|[甲方新名系统部]', '[甲系统部]|[甲方新名系统部]']);

        // 之后有人手动改了其中一处：回退不覆盖它
        const edited = (await sla.getPrefsObject())[PREF_KEY];
        edited.customMetrics[1].valY = '手动改的';
        await sla.upsertPrefItem(PREF_KEY, edited);
        const reverted = await toolByName.get('sla_revert_metric_rule_change').run({ changeId }, admin);
        assert.ok(reverted.ok, reverted.content);
        assert.match(reverted.content, /已回退 1 处[\s\S]*现在是「手动改的」/);
        current = (await sla.getPrefsObject())[PREF_KEY].customMetrics;
        assert.deepEqual([current[0].subMetrics[1].valY, current[1].valY], ['甲系统部', '手动改的']);

        const history = JSON.parse((await toolByName.get('sla_list_metric_rule_changes').run({}, admin)).content);
        assert.equal(history[0].revertOf, changeId);
        assert.equal(history[1].revertedBy, history[0].id);
        assert.ok((await toolByName.get('sla_revert_metric_rule_change').approval({ changeId: 'nope' }, admin)).error);
    } finally {
        await mock.close();
    }
});
