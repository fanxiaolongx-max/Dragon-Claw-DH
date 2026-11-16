// AI BI：看板保存与读取、对话生成布局（画布、格子位置收拢与去重叠、保留已有格子）、画面标记只改展示设置、页面入口。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { startMockBaseServer } from './helpers/mock-base.js';

const require = createRequire(import.meta.url);
const Board = require('../static/js/ai-bi/model.js');
const Templates = require('../static/js/ai-report/templates.js');
const Query = require('../static/js/ai-report/query.js');
const as = (user) => ({ cookie: `iLearningXUserName=${user}` });

test('看板模型：画布收拢、格子不出界、计划去重叠并保留已有格子的配方', () => {
    const board = Board.normalize({ canvas: { width: 99999, height: 10 }, items: [{ x: -50, y: 5000, w: 50, h: 50 }] });
    assert.equal(board.canvas.width, 7680);
    assert.equal(board.canvas.height, 240);
    const [cell] = board.items;
    assert.ok(cell.x >= 0 && cell.x + cell.w <= board.canvas.width && cell.y + cell.h <= board.canvas.height);

    const existing = Board.normalize({ canvas: { width: 1920, height: 1080 }, items: [{ id: 'keep', title: '旧', x: 24, y: 24, w: 400, h: 300, prompt: '旧提示词', recipe: { compute: 'function compute(){return 1}', render: 'function render(){return ""}' } }] });
    const plan = Board.fromPlan({ canvas: { width: 1920, height: 1080 }, items: [{ id: 'keep', x: 30, y: 30, w: 401, h: 301, prompt: '旧提示词' }, { id: 'made-up', title: '新', x: 100, y: 100, w: 400, h: 300, prompt: '新的' }] }, existing);
    const kept = plan.items.find((i) => i.id === 'keep');
    assert.deepEqual([kept.x, kept.y, kept.w, kept.h], [32, 32, 400, 304], '按 8 取整');
    assert.ok(kept.recipe, '已有格子的配方保留，不会重新生成');
    const added = plan.items.find((i) => i.id !== 'keep');
    assert.notEqual(added.id, 'made-up', '模型编的 id 当作新格子');
    assert.ok(added.y >= kept.y + kept.h, '重叠的格子被推到下面');

    const T = require('../static/js/ai-report/templates.js');
    const fitted = Board.fitView({ rows: [[{ id: 'a', template: 'kpi-cards', params: {} }], [{ id: 'b', template: 'line-trend', params: { title: 'x' } }]] }, { h: 600 }, T);
    assert.ok(fitted.rows[1][0].params.height > 150, '模板高度按格子大小自动算');
    assert.equal(fitted.rows[0][0].params.height, undefined, '没有高度参数的模板不加');

    const withMarks = Board.normalize({
        canvas: { width: 1920, height: 1080 },
        items: [{ id: 'c1', x: 24, y: 24, w: 400, h: 300 }],
        marks: [
            { id: 'm1', number: 1, cellId: 'c1', rx: 2, ry: -1, note: '改成横向柱图', status: 'sent' },
            { id: 'm2', number: 2, cellId: 'missing', rx: 0.5, ry: 0.5, note: '已删格子的标记' },
        ],
    });
    assert.equal(withMarks.marks.length, 1, '已删格子的标记应自动清理');
    assert.equal(withMarks.marks[0].rx, 0.98);
    assert.equal(withMarks.marks[0].ry, 0.02);
    assert.equal(withMarks.marks[0].status, 'sent');
});

test('AI BI 静态资源：缩放控制栏、侧栏调宽、输入框圆角焦点与多标记持久能力', () => {
    const html = fs.readFileSync(new URL('../static/ai-bi.html', import.meta.url), 'utf8');
    const css = fs.readFileSync(new URL('../static/css/ai-bi.css', import.meta.url), 'utf8');
    const appJs = fs.readFileSync(new URL('../static/js/ai-bi/app.js', import.meta.url), 'utf8');
    const markerJs = fs.readFileSync(new URL('../static/js/ai-report/marker.js', import.meta.url), 'utf8');
    assert.match(html, /id="biZoomBar"/);
    assert.match(html, /id="biSideResizer"/);
    assert.match(html, /id="biMoreMenu"/);
    assert.match(html, /data-bi="undo"/);
    assert.match(html, /data-bi="redo"/);
    assert.match(css, /\.bi-side \.bi-composer textarea:focus-visible\{[^}]*box-shadow:none/);
    assert.match(css, /\.bi-zoom-bar\{/);
    assert.match(css, /\.bi-side-resizer\{/);
    assert.match(appJs, /setSideWidth/);
    assert.match(appJs, /stepZoom/);
    assert.match(appJs, /layer:scaler/);
    assert.match(markerJs, /data-mark-delete/);
    assert.match(markerJs, /data-mark-save/);
});

test('看板接口、对话生成布局、标记调整与页面入口', async () => {
    const mock = await startMockBaseServer();
    Object.assign(process.env, { LOCAL_DEV_MEMORY: '0', LOG_LEVEL: 'silent', BASE_QUERY_URL: `${mock.baseUrl}/query`, BASE_EXECUTE_URL: `${mock.baseUrl}/execute`, APP_SCHEMA: 'bi-test', APP_UUID: 'bi-test', APP_DATASOURCE_ID: '2' });
    delete process.env.DH_OPEN_ADMIN;
    delete process.env.DH_ADMIN_USERS;
    const { createServer } = await import('../src/server.js');
    const app = await createServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const call = async (user, method, path, body) => {
        const res = await fetch(`${url}${path}`, { method, headers: { ...as(user), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { data = text; }
        return { status: res.status, data };
    };
    try {
        assert.equal((await call('alice', 'GET', '/api/auth/me')).data.isAdmin, true);
        assert.equal((await call('alice', 'POST', '/api/ai-settings/profiles', { name: 'MockLLM', baseUrl: `${mock.baseUrl}/v1`, apiKey: 'test-key-000', model: 'test-model', activate: true })).status, 201);

        // 页面与入口
        const page = await fetch(`${url}/ai-bi`, { headers: as('bob') });
        assert.equal(page.status, 200);
        assert.match(await page.text(), /js\/ai-bi\/app\.js/);
        assert.match(fs.readFileSync(new URL('../static/js/shared/platform-core.js', import.meta.url), 'utf8'), /id: 'monthly'[^\n]*\n\s*\{ id: 'ai-bi'/, 'AI BI 紧跟在月报页面后面');

        // 这个月一点数据都没有：直接说明，不画格子
        const empty = await call('bob', 'POST', '/api/ai-report/bi/plan', { month: '2026-10', message: '做个看板', board: {} });
        assert.equal(empty.data.type, 'answer');
        assert.match(empty.data.text, /还没有任何数据/);
        const sla = await call('alice', 'POST', '/api/sla/snapshot', { id: 'sla-bi-oct', timestamp: '2026-11-12T09:00:00.000Z', selectedTargetMonth: 10, topMetrics: [{ key: 'rectify', label: '整改', value: '96%', target: '≥ 100%', isWarn: true, gap: '-4%', subMetrics: [] }] });
        assert.equal(sla.status, 200);

        // 对话 → 计划：画布、格子位置被收拢、超出画布的被拉回
        mock.options.completionText = JSON.stringify({ type: 'plan', reply: '做好了', name: '运维看板', canvas: { width: 1920, height: 1080 }, items: [{ title: '指标', x: 24, y: 24, w: 1872, h: 150, prompt: '核心指标，模板 kpi-cards' }, { title: '趋势', x: 1800, y: 900, w: 900, h: 400, prompt: '近 6 个月趋势，模板 line-trend' }] });
        const plan = await call('bob', 'POST', '/api/ai-report/bi/plan', { month: '2026-10', message: '做个 16:9 的看板', board: {} });
        assert.equal(plan.status, 200);
        assert.equal(plan.data.type, 'plan');
        assert.equal(plan.data.name, '运维看板');
        const trend = plan.data.items.find((i) => i.title === '趋势');
        assert.ok(trend.x + trend.w <= 1920 && trend.y + trend.h <= 1080, '超出画布的格子被拉回');
        const sent = JSON.stringify(mock.aiRequests.at(-1));
        assert.match(sent, /AI BI/);
        assert.match(sent, /bar-target｜达标对比柱/, '模板目录随计划请求发给模型');
        mock.options.completionText = JSON.stringify({ type: 'ask', question: '想看哪个主题？', choices: ['运维质量', '工单'] });
        assert.deepEqual((await call('bob', 'POST', '/api/ai-report/bi/plan', { month: '2026-10', message: '做个看板' })).data.choices, ['运维质量', '工单']);

        // 保存、列表、读取；普通用户可以保存，删除仅管理员
        const saved = await call('bob', 'POST', '/api/ai-bi/boards', { name: '运维看板', month: '2026-10', canvas: { width: 1920, height: 1080 }, items: plan.data.items });
        assert.equal(saved.status, 200);
        assert.match(saved.data.id, /^board-/);
        const list = (await call('carol', 'GET', '/api/ai-bi/boards')).data;
        assert.equal(list.length, 1);
        assert.equal(list[0].items, 2);
        assert.deepEqual(list[0].canvas.width, 1920);
        assert.equal((await call('carol', 'GET', `/api/ai-bi/boards/${saved.data.id}`)).data.items.length, 2);
        assert.equal((await call('bob', 'DELETE', `/api/ai-bi/boards/${saved.data.id}`)).status, 403);

        // 画面标记：只改展示设置；模型改了分区或数据字段就交回对话
        const view = { rows: [[{ id: 'chart', template: 'bar-target', data: 'rows' }]] };
        mock.options.completionText = JSON.stringify({ type: 'view', reply: '改成横向', view: { rows: [[{ id: 'chart', template: 'bar-target', data: 'rows', params: { orientation: 'horizontal', bogus: 1 } }]] } });
        const adjusted = await call('bob', 'POST', '/api/ai-report/cell/adjust', { view, prompt: 'x', note: '改成横向条', target: { slot: 'chart' } });
        assert.equal(adjusted.data.type, 'view');
        assert.deepEqual(adjusted.data.view.rows[0][0].params, { orientation: 'horizontal' });
        mock.options.completionText = JSON.stringify({ type: 'view', view: { rows: [[{ id: 'chart', template: 'bar-target', data: 'other' }]] } });
        assert.equal((await call('bob', 'POST', '/api/ai-report/cell/adjust', { view, note: '换数据' })).data.type, 'data');
        mock.options.completionText = JSON.stringify({ type: 'view', view: { rows: [[{ id: 'chart', template: 'line-trend', data: 'rows' }]] } });
        assert.equal((await call('bob', 'POST', '/api/ai-report/cell/adjust', { view, note: '换成折线' })).data.type, 'data', '换成数据形状不同的模板也要交回对话');

        // 自己写代码的格子：标记只改参数块里的值；旧格子可以一键整理出参数块
        const defs = { top: { label: '显示前几名', type: 'number', value: 10 }, order: { label: '排序', type: 'select', value: 'desc', options: [['desc', '从高到低'], ['asc', '从低到高']] } };
        mock.options.completionText = JSON.stringify({ type: 'params', reply: '只显示前 5 名', values: { top: 5, bogus: 1 } });
        const freeAdjusted = await call('bob', 'POST', '/api/ai-report/cell/adjust', { params: defs, note: '只显示前 5 名' });
        assert.deepEqual(freeAdjusted.data.values, { top: 5 });
        const plainRender = 'function render(result, kit) { return kit.bar(result.items.slice(0, 10), { title: "各运营商" }); }';
        mock.options.completionText = JSON.stringify({ render: 'function render(result, kit) { const P = kit.params({"title":{"label":"标题","type":"text","value":"各运营商"},"top":{"label":"显示前几名","type":"number","value":10}}); return kit.bar(result.items.slice(0, P.top), { title: P.title }); }' });
        const extracted = await call('bob', 'POST', '/api/ai-report/cell/params', { render: plainRender, prompt: 'x' });
        assert.equal(extracted.status, 200);
        assert.ok(Templates.freeParams(extracted.data.render));
        mock.options.completionText = JSON.stringify({ render: 'function render(result, kit) { const P = kit.params({"top":{"label":"x","type":"number","value":1}}); return (; }' });
        assert.equal((await call('bob', 'POST', '/api/ai-report/cell/params', { render: plainRender })).status >= 400, true, '语法错误的整理结果不能用');

        // 取数查询：模型给 query + view，平台生成取数和展示代码，不用模型写代码
        mock.options.completionText = JSON.stringify({ recipe: { summary: { zh: '整改', en: '' }, sources: [{ id: 'm1', kind: 'metrics', label: '本月指标', names: [], monthOffset: 0 }], query: { shape: 'items', from: 'm1', label: 'label', value: 'numValue' }, view: { template: 'bar-target', params: { target: 95 } }, narrative: null } });
        const compiled = await call('bob', 'POST', '/api/ai-report/cell/compile', { month: '2026-10', prompt: '各指标对比，模板 bar-target', interactive: false });
        assert.equal(compiled.status, 200);
        assert.ok(Query.isQueryCompute(compiled.data.recipe.compute), '取数代码来自 query');
        assert.deepEqual(Query.queryFromCompute(compiled.data.recipe.compute).from, 'm1');
        assert.ok(Templates.isTemplateRender(compiled.data.recipe.render));

        assert.equal((await call('alice', 'DELETE', `/api/ai-bi/boards/${saved.data.id}`)).status, 200);
        assert.equal((await call('alice', 'GET', '/api/ai-bi/boards')).data.length, 0);
    } finally {
        delete mock.options.completionText;
        await app.close();
        await mock.close();
    }
});
