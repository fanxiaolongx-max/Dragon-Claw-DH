// 对话里改整条指标规则（增 / 改 / 删，预览值与命中行数、冲突不覆盖、倒序回退），以及抓取脚本保存：确认卡、只改传入字段。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockBaseServer } from './helpers/mock-base.js';

const PREF_KEY = 'sla_prefs_other_eos';
let mock;
before(async () => {
    mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        APP_SCHEMA: 'sla-full-edit',
        APP_UUID: 'sla-full-edit',
        APP_DATASOURCE_ID: '2',
    });
});
after(async () => { await mock?.close(); });

const admin = { identity: { username: 'boss', isAdmin: true } };
const user = { identity: { username: 'guest', isAdmin: false } };

test('整条指标规则：读取、预览、增改删、冲突不覆盖、倒序回退', async () => {
    const sla = await import('../src/services/sla-service.js');
    const { toolByName } = await import('../src/agent/tools.js');
    await sla.upsertPrefItem(PREF_KEY, { _sourceMeta: { title: 'EOS 表' }, customMetrics: [
        { id: 'm_1', type: 'extract', colX: 'name', valY: '汇总', colZ: 'closed_rate', label: '闭环率', conditions: [] },
        { id: 'm_2', type: 'count', colX: 'name', valY: '甲系统部', colZ: 'status', valK: '[非空]', label: '甲计数', conditions: [] },
    ] });
    await sla.replaceTargets({ other_eos_m_1: { label: '闭环率目标', target: 1 } });
    await sla.addSnapshot({ id: 'snap-1', timestamp: '2026-11-17T08:00:00.000Z', topMetrics: [], sourceSections: [{ key: 'other_eos', rows: [
        { name: '甲系统部', closed_rate: '1', status: 'x', region: '东' },
        { name: '甲系统部', closed_rate: '0.5', status: '', region: '西' },
        { name: '汇总', closed_rate: '0.97', status: '', region: '' },
    ] }] });
    const read = toolByName.get('sla_read_metric_rules');
    const edit = toolByName.get('sla_edit_metric_rules');

    assert.equal((await read.run({}, user)).ok, false, '仅管理员');
    const tables = JSON.parse((await read.run({}, admin)).content).tables;
    assert.deepEqual(tables[0].metrics.map((m) => m.id), ['m_1', 'm_2']);
    const one = JSON.parse((await read.run({ metricId: 'm_1' }, admin)).content).items[0];
    assert.deepEqual([one.metric.colZ, one.latest.value, one.latest.matchedRows], ['closed_rate', '0.97', 1]);

    const args = { summary: '调整计数口径', edits: [
        { op: 'update', prefKey: PREF_KEY, metricId: 'm_2', set: { conditions: [{ column: 'region', value: '东' }], label: '甲东区计数' } },
        { op: 'add', prefKey: PREF_KEY, metric: { label: '汇总闭环率（新）', type: 'extract', colX: 'name', valY: '汇总', colZ: 'closed_rate' } },
        { op: 'remove', prefKey: PREF_KEY, metricId: 'm_1' },
    ] };
    assert.ok((await edit.approval({ edits: [{ op: 'update', prefKey: PREF_KEY, metricId: 'm_2', set: { id: 'x' } }] }, admin)).error, 'ID 不能改');
    assert.ok((await edit.approval({ edits: [{ op: 'add', prefKey: PREF_KEY, metric: { type: 'extract' } }] }, admin)).error, '新增必须有名称');
    assert.ok((await edit.approval({ edits: [{ op: 'update', prefKey: 'sla_prefs_nope', metricId: 'm_2', set: { label: 'x' } }] }, admin)).error);
    assert.ok((await edit.approval(args, user)).error);
    const { preview } = await edit.approval(args, admin);
    assert.match(preview.title, /修改 3 条指标规则/);
    const m2 = preview.fields.find((f) => f.label.includes('甲东区计数'));
    assert.match(m2.value, /改 label、conditions/);
    assert.match(m2.value, /命中 2 → 1 行/, JSON.stringify(preview.fields));
    assert.match(preview.impact, /预警目标/, '删除带目标的指标要提醒');
    assert.equal(preview.fields.length, 3);

    const applied = await edit.run(args, admin);
    assert.ok(applied.ok, applied.content);
    const changeId = applied.content.match(/rc_[a-z0-9_]+/)[0];
    let metrics = (await sla.getPrefsObject())[PREF_KEY].customMetrics;
    assert.deepEqual(metrics.map((m) => m.label), ['甲东区计数', '汇总闭环率（新）']);
    assert.equal(metrics[1].sourceSecId, 'other_eos');
    assert.match(metrics[1].id, /^m_/);

    // 之后有人手动改了新增的那条：回退时不删它，其余照常撤回，并恢复被删的 m_1 到原位置
    const edited = (await sla.getPrefsObject())[PREF_KEY];
    edited.customMetrics[1].label = '手动改名';
    await sla.upsertPrefItem(PREF_KEY, edited);
    const reverted = await toolByName.get('sla_revert_metric_rule_change').run({ changeId }, admin);
    assert.ok(reverted.ok, reverted.content);
    assert.match(reverted.content, /已回退 2 处/);
    metrics = (await sla.getPrefsObject())[PREF_KEY].customMetrics;
    assert.deepEqual(metrics.map((m) => m.id).slice(0, 2), ['m_1', 'm_2']);
    assert.equal(metrics[1].label, '甲计数');
    assert.deepEqual(metrics[1].conditions, []);
    assert.equal(metrics[2].label, '手动改名', '之后被改过的不覆盖');

    const history = JSON.parse((await toolByName.get('sla_list_metric_rule_changes').run({}, admin)).content);
    assert.equal(history[0].revertOf, changeId);
    assert.equal(history[1].count, 3);
});

test('抓取脚本保存：要确认，修改时只改传入的字段，请求头和请求体保留', async () => {
    const uiv = await import('../src/services/uiv-service.js');
    const { toolByName } = await import('../src/agent/tools.js');
    await uiv.saveScripts([{ id: 'script_keep', name: '工单抓取', category: '运维', url: 'https://a.example/api', method: 'POST', code: 'fetch("https://a.example/api")', headers: { 'X-Site': 'cn' }, body: '{"page":1}', configOptions: { isPagination: true }, createdAt: 123 }]);
    const save = toolByName.get('save_uiv_script');
    assert.equal(save.kind, 'write', '执行前弹确认卡');

    assert.ok((await save.approval({ id: 'script_keep', name: '新名字' }, user)).error);
    assert.ok((await save.approval({ id: 'nope', name: 'x' }, admin)).error);
    const { preview } = await save.approval({ id: 'script_keep', name: '工单抓取 v2', url: 'https://a.example/api' }, admin);
    assert.match(preview.title, /修改抓取脚本「工单抓取」/);
    assert.deepEqual(preview.fields.map((f) => f.label), ['name'], '没变的字段不算改动');

    const out = await save.run({ id: 'script_keep', name: '工单抓取 v2' }, admin);
    assert.ok(out.ok, out.content);
    const kept = (await uiv.listScripts()).find((s) => s.id === 'script_keep');
    assert.equal(kept.name, '工单抓取 v2');
    assert.deepEqual([kept.category, kept.method, kept.code, kept.body, kept.createdAt], ['运维', 'POST', 'fetch("https://a.example/api")', '{"page":1}', 123]);
    assert.deepEqual(kept.headers, { 'X-Site': 'cn' });
    assert.deepEqual(kept.configOptions, { isPagination: true });

    assert.ok((await save.approval({ name: '只有名字' }, admin)).error, '新建需要地址');
    const created = await save.run({ name: '新脚本', url: 'https://b.example/x' }, admin);
    assert.ok(created.ok, created.content);
    assert.equal((await uiv.listScripts()).find((s) => s.name === '新脚本').category, '默认分类');
});
