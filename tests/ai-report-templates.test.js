// AI 月报内置模板：每个模板都能用示例数据渲染；参数清洗、展示参数行、组合布局、出错提示。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../static/js/ai-report/templates.js');
const kit = require('../static/js/ai-report/render-kit.js').AiReportKit;

// 不同数据形状的示例（每个模板按自己的 kind 取）
const SAMPLE = {
    items: [{ label: 'TE', value: 96.2, target: 95, previous: 94.1 }, { label: 'ORG', value: 91.5, target: 95, previous: 92 }, { label: 'ET', value: 97.8, target: 95, previous: 97.8 }, { label: '期末', value: 12, total: true }],
    series: { categories: ['7月', '8月', '9月'], series: [{ name: '工单量', values: [120, 132, 101] }, { name: '及时率', values: [93.1, 94.8, 96.2], axis: 'right' }], target: 95 },
    matrix: { rows: ['TE', 'ORG'], columns: ['回传率', '及时率'], values: [[96, 88], [91, 97]], targets: [95, 90] },
    kpis: [{ label: '事故数', value: 3, unit: '起', delta: -2, tone: 'good', spark: [6, 5, 5, 3] }, { label: '回传率', value: 96.2, unit: '%', delta: 1.4, target: 95 }],
    rows: { rows: [{ name: 'TE', rate: 96.2, $tone: 'good' }, { name: 'ORG', rate: 91.5, $tone: 'bad' }], columns: [{ key: 'name', label: '运营商' }, { key: 'rate', label: '回传率', format: 'number' }] },
    points: [{ label: 'TE', x: 120, y: 96.2, size: 30 }, { label: 'ORG', x: 80, y: 91.5, size: 12 }],
    events: [{ date: '09-12', title: '核心网割接', text: '按计划完成', tone: 'good' }],
    text: '本月回传率 **96.2%**，较上月提升 1.4 个百分点。',
    list: [{ label: 'TE', text: '已达标', tone: 'good' }, '整体平稳'],
    links: [{ label: '风险治理', anchor: '#air-chapter-x', no: '01' }],
    tree: { name: '全部', children: [{ name: '北非', children: [{ name: '埃及', value: 12 }, { name: '摩洛哥', value: 5 }] }, { name: '中东', value: 9 }] },
    flow: { links: [{ source: '热线', target: '一线', value: 120 }, { source: '一线', target: '闭环', value: 96 }, { source: '一线', target: '升级', value: 24 }] },
    groups: [{ label: '一线', values: [2, 3, 3, 4, 5, 8, 13, 40] }, { label: '二线', values: [5, 6, 7, 9, 15] }],
    tasks: [{ label: '核心网扩容', start: '2026-09-01', end: '2026-11-15', progress: 60, owner: '张三' }, { label: '割接', start: '2026-10-10', end: '2026-10-20', progress: 100, tone: 'good' }],
    daily: Array.from({ length: 31 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, value: (i * 7) % 13 })),
};

test('每个模板都能用示例数据渲染，图表是纯 JSON', () => {
    assert.ok(T.TEMPLATES.length >= 58);
    for (const template of T.TEMPLATES) {
        kit._resetWidgets();
        const html = T.render({ template: template.id, params: { title: '标题' } }, SAMPLE[template.kind], kit);
        const widgets = kit._takeWidgets();
        assert.ok(html.length > 20, template.id);
        assert.doesNotMatch(html, /undefined|NaN|\[object Object\]/, template.id);
        for (const widget of widgets) {
            const text = JSON.stringify(widget.spec);
            assert.doesNotMatch(text, /undefined|NaN/, template.id);
            assert.deepEqual(JSON.parse(text), widget.spec, `${template.id} 的图表配置要能原样 JSON 往返（不能有函数）`);
        }
        // 示例数据形状写在目录里，和模板一致
        assert.ok(T.KINDS[template.kind], template.id);
    }
});

test('参数清洗：越界收拢、未知丢弃、只存与默认不同的值', () => {
    const view = T.normalizeView({ template: 'bar-target', params: { height: 99999, rule: 'xxx', unit: '%', bogus: 1, showValue: 'false' } });
    assert.deepEqual(view.rows[0][0].params, { unit: '%', height: 900, showValue: false });
    assert.equal(T.normalizeView({ template: 'no-such' }), null);
    const p = T.cleanParams(T.get('line-trend'), { target: '' });
    assert.equal(p.target, null);
    assert.equal(p.valueLabels, 'last');
});

test('render 代码只是把 view 交给模板库，能原样解析回来', () => {
    const view = { title: '总览', rows: [[{ id: 'kpi', template: 'kpi-cards', data: 'kpis' }], [{ id: 'trend', template: 'line-trend', data: 'trend', width: 60, params: { unit: '%' } }, { id: 'rank', template: 'rank-bar', data: 'rank', width: 40 }]] };
    const code = T.renderSource(view);
    assert.ok(T.isTemplateRender(code));
    assert.deepEqual(T.viewFromRender(code), T.normalizeView(view));
    const render = new Function('AiReportTemplates', `${code}; return render;`)(T);
    kit._resetWidgets();
    const html = render({ kpis: SAMPLE.kpis, trend: SAMPLE.series, rank: SAMPLE.items }, kit);
    assert.match(html, /kit-layout/);
    assert.match(html, /data-slot="trend"/);
    assert.match(html, /总览/);
    assert.equal(kit._takeWidgets().length, 2);
});

test('数据不对时给出能直接改 compute 的提示', () => {
    assert.throws(() => T.render({ template: 'bar-target' }, { a: 1 }, kit), /bar-target.*数据要是数组/);
    assert.throws(() => T.render({ template: 'bar-target' }, [{ label: 'TE', value: '95%x' }], kit), /value 都不是数字/);
    assert.throws(() => T.render({ rows: [[{ id: 'a', template: 'line-trend', data: 'trend' }]] }, { rank: [] }, kit), /「trend」.*不存在.*实际只有：rank/);
    assert.throws(() => T.render({ template: 'line-trend' }, { categories: ['7月', '8月'], series: [{ name: 'x', values: [1] }] }, kit), /要和 categories 一样是 2 个/);
    assert.match(T.render({ template: 'bar-basic' }, { missing: true, message: '本月没有导入' }, kit), /本月没有导入/);
});

test('提示词里的展示参数行由 view 生成，替换旧行', () => {
    const view = { rows: [[{ id: 'chart', template: 'bar-target', data: 'chart', params: { unit: '%', rule: 'lte' } }]] };
    const prompt = T.withDescription('展示各运营商回传率。\n【展示参数】旧的', view);
    assert.equal(prompt.split('\n').filter((line) => line.startsWith('【展示参数】')).length, 1);
    assert.match(prompt, /【展示参数】chart：达标对比柱.*单位=%；达标规则=越低越好/);
    assert.ok(T.catalog().includes('heatmap-rag'));
    assert.ok(T.catalog().length < 16000, '目录要足够短，能随每次编译发给模型');
    for (const combo of T.COMPOSITIONS) assert.ok(T.normalizeView(combo), combo.id);
});

test('自己写代码的格子：kit.params 参数块可读、可改、写进提示词，其余代码不变', () => {
    const code = 'function render(result, kit) { const P = kit.params({"title":{"label":"标题","type":"text","value":"回传率 {TE}"},"top":{"label":"显示前几名","type":"number","value":10,"min":1},"order":{"label":"排序","type":"select","value":"desc","options":[["desc","从高到低"],["asc","从低到高"]]},"color":{"label":"主色","type":"color","value":"#2f6fae"},"bad":{"type":"select","options":[]}}); return P.title + P.top; }';
    const found = T.freeParams(code);
    assert.deepEqual(Object.keys(found.defs), ['title', 'top', 'order', 'color'], '没有选项的 select 被丢掉');
    const next = T.setFreeParams(code, { top: 5, order: 'asc', color: 'red' });
    assert.equal(T.freeParams(next).defs.top.value, 5);
    assert.equal(T.freeParams(next).defs.order.value, 'asc');
    assert.equal(T.freeParams(next).defs.color.value, '#2f6fae', '无效颜色不接受');
    assert.ok(next.endsWith('return P.title + P.top; }'));
    assert.equal(T.withFreeDescription('看各运营商\n【展示参数】旧', T.freeParams(next).defs), '看各运营商\n【展示参数】标题=回传率 {TE}；显示前几名=5；排序=从低到高；主色=#2f6fae');
    assert.deepEqual(kit.params(found.defs), { title: '回传率 {TE}', top: 10, order: 'desc', color: '#2f6fae' });
    assert.equal(T.freeParams('function render(r,k){ return k.params(x); }'), null);
    assert.equal(T.freeParams(T.renderSource({ template: 'kpi-cards' })), null, '模板格子不算自由参数');
});

test('只有一个分区时，结果多包一层 {data:[…]} 或少一层都能对上', () => {
    const items = [{ label: 'CNBG', value: 97.6, target: 95 }];
    assert.match(T.render({ template: 'bar-target' }, { data: items }, kit), /kit-widget/);
    assert.match(T.render({ rows: [[{ id: 'c', template: 'bar-target', data: 'chart' }]] }, items, kit), /kit-widget/);
    assert.throws(() => T.render({ rows: [[{ id: 'a', template: 'bar-target', data: 'x' }, { id: 'b', template: 'bar-target', data: 'y' }]] }, items, kit), /不存在/, '多个分区时仍然要求字段名对上');
});
