// 取数查询：AI 用 JSON 说要什么数据，平台执行并核对字段名和筛选值；结果直接是模板要的数据形状。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Q = require('../static/js/ai-report/query.js');
const T = require('../static/js/ai-report/templates.js');
const kit = require('../static/js/ai-report/render-kit.js').AiReportKit;

const input = {
    $month: '2026-10',
    d1: { rows: [
        { scope: 'TOTAL', period: 'currentYtd', sr_total: 4389, sr_frt: 0.9758, unclose: 452 },
        { scope: 'CNBG', period: 'currentYtd', sr_total: 3519, sr_frt: 0.9758, unclose: 372 },
        { scope: 'EBG', period: 'currentYtd', sr_total: 870, sr_frt: 0, unclose: 80 },
        { scope: 'CNBG', period: 'previousYtd', sr_total: 4005, sr_frt: 0.9955, unclose: 372 },
    ] },
    t1: { rows: [
        { month: '2026-09', op: 'TE', cnt: 3 }, { month: '2026-08', op: 'TE', cnt: 5 }, { month: '2026-09', op: 'ET', cnt: 4 }, { month: '2026-10', op: 'TE', cnt: 1 },
    ] },
    m1: { metrics: [{ label: '回传率', numValue: 96.2, target: 95 }, { label: '整改', numValue: 88, target: 100 }] },
};

test('取数查询：分类对比、指标卡、趋势、明细、文字都直接是模板要的形状', () => {
    const items = Q.run({ shape: 'items', from: 'd1', where: [{ field: 'period', value: 'currentYtd' }, { field: 'scope', op: '!=', value: 'TOTAL' }], label: 'scope', value: { field: 'sr_frt', scale: 100, digits: 1 }, target: { const: 95 }, sort: { by: 'value', dir: 'desc' } }, input);
    assert.deepEqual(items, [{ label: 'CNBG', value: 97.6, target: 95 }, { label: 'EBG', value: 0, target: 95 }]);

    const kpis = Q.run({ shape: 'kpis', from: 'd1', where: [{ field: 'scope', value: 'TOTAL' }], cards: [{ label: 'SR 总量', value: 'sr_total' }, { label: 'FRT 达成率', value: { field: 'sr_frt', scale: 100, digits: 1 }, unit: '%' }] }, input);
    assert.deepEqual(kpis, [{ label: 'SR 总量', value: 4389 }, { label: 'FRT 达成率', value: 97.6, unit: '%' }]);

    const series = Q.run({ shape: 'series', from: 't1', x: 'month', series: [{ name: '事件数', field: 'cnt', agg: 'sum' }] }, input);
    assert.deepEqual(series, { categories: ['2026-08', '2026-09', '2026-10'], series: [{ name: '事件数', values: [5, 7, 1] }] });

    const rows = Q.run({ shape: 'rows', from: 'd1', where: [{ field: 'period', value: 'currentYtd' }], columns: { 范围: 'scope', 未关闭: 'unclose' }, sort: { by: '未关闭', dir: 'desc' }, limit: 2 }, input);
    assert.deepEqual(rows, [{ 范围: 'TOTAL', 未关闭: 452 }, { 范围: 'CNBG', 未关闭: 372 }]);

    const grouped = Q.run({ shape: 'items', from: 't1', label: 'op', value: { field: 'cnt', agg: 'sum' } }, input);
    assert.deepEqual(grouped, [{ label: 'TE', value: 9 }, { label: 'ET', value: 4 }]);

    assert.equal(Q.run({ shape: 'text', from: 'd1', where: [{ field: 'scope', value: 'TOTAL' }, { field: 'period', value: 'currentYtd' }], parts: ['本月工单 ', { field: 'sr_total' }, ' 单'] }, input), '本月工单 4389 单');
    assert.deepEqual(Q.run({ shape: 'items', from: 'm1', label: 'label', value: 'numValue', target: 'target' }, input)[1], { label: '整改', value: 88, target: 100 });

    // 一个 view 多个分区：query 写成 {分区 data 名: 查询}
    const multi = Q.run({ kpi: { shape: 'kpis', from: 'd1', where: [{ field: 'scope', value: 'TOTAL' }], cards: [{ label: '总量', value: 'sr_total' }] }, chart: { shape: 'items', from: 't1', label: 'op', value: { field: 'cnt', agg: 'sum' } } }, input);
    assert.deepEqual(Object.keys(multi), ['kpi', 'chart']);
});

test('取数查询：猜错的字段名和筛选值当场报错，并给出真实名称', () => {
    assert.throws(() => Q.run({ shape: 'items', from: 'd1', label: 'operator', value: 'sr_frt' }, input), /没有字段「operator」，实际字段：scope、period/);
    assert.throws(() => Q.run({ shape: 'items', from: 'd1', where: [{ field: 'period', value: '2026-10' }], label: 'scope', value: 'sr_frt' }, input), /没有取值「2026-10」，实际取值：currentYtd、previousYtd/);
    assert.throws(() => Q.run({ shape: 'items', from: 'x9', label: 'a', value: 'b' }, input), /数据源「x9」不存在/);
    // 一个分类对应多行又没写汇总（把各期达成率相加成 296%）：报错并指出区别在哪一列
    assert.throws(() => Q.run({ shape: 'items', from: 'd1', where: [{ field: 'scope', op: '!=', value: 'TOTAL' }], label: 'scope', value: { field: 'sr_frt', scale: 100 } }, input), /「sr_frt」在「CNBG」对应 2 行，没写怎么汇总。这些行的区别在：period（currentYtd、previousYtd）/);
    // 筛选值存在但组合后没有行：是正常的“本月没有”，不报错
    assert.deepEqual(Q.run({ shape: 'items', from: 'd1', where: [{ field: 'scope', value: 'EBG' }, { field: 'period', value: 'previousYtd' }], label: 'scope', value: 'sr_total' }, input), []);
});

test('取数查询：存进格子的 compute 只是把查询交给平台，模板能直接画出来', () => {
    const query = { shape: 'items', from: 'd1', where: [{ field: 'period', value: 'currentYtd' }], label: 'scope', value: 'sr_total' };
    const code = Q.computeSource(query);
    assert.ok(Q.isQueryCompute(code));
    assert.deepEqual(Q.queryFromCompute(code), query);
    globalThis.AiReportQuery = Q;
    const compute = new Function(`${code}; return compute;`)();
    const html = T.render({ template: T.TEMPLATES.find((t) => t.kind === 'items').id }, compute(input), kit);
    assert.match(html, /CNBG|kit-widget/);
    delete globalThis.AiReportQuery;
});
