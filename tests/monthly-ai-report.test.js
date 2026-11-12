import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startMockBaseServer, getFreePort, waitForServer } from './helpers/mock-base.js';
import { summarizeSql } from '../src/dao/base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.dirname(__dirname);

async function startMockOpenAiServer() {
    const captured = [];
    let mode = 'ready';
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (d) => chunks.push(d));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let body = {};
            try { body = JSON.parse(raw); } catch { body = {}; }
            captured.push({ url: req.url, body });
            res.setHeader('Content-Type', 'application/json');
            if (mode === 'non-interactive-compile') {
                res.end(JSON.stringify({
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                recipe: {
                                    summary: { zh: '整改汇总', en: 'Rectify' },
                                    sources: [{ id: 'm1', kind: 'metrics', label: '整改指标', names: ['整改 / ET'], monthOffset: 0 }],
                                    compute: 'function compute(input){ var m=(input&&input.m1&&input.m1.metrics)||[]; return { items: m }; }',
                                    render: 'function render(result, kit){ return kit.table(result.items); }',
                                    narrative: null,
                                },
                            }),
                        },
                    }],
                    usage: { prompt_tokens: 100, completion_tokens: 50 },
                }));
                return;
            }
            const sysMsg = String(body?.messages?.[0]?.content || '');
            if (sysMsg.includes('配方编译器')) {
                res.end(JSON.stringify({
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                recipe: {
                                    summary: { zh: '10月整改指标概览', en: 'Oct Rectify' },
                                    sources: [{ id: 'm1', kind: 'metrics', label: '整改指标', names: ['整改 / ET'], monthOffset: 0 }],
                                    compute: 'function compute(input){ var m=(input&&input.m1&&input.m1.metrics)||[]; return { count: m.length, items: m }; }',
                                    render: 'function render(result, kit){ return kit.interactive({ html: "<div>" + kit.esc(result.items[0] && result.items[0].label) + "</div>", css: "", script: "" }, { height: 220 }); }',
                                    narrative: 'should-be-cleared-when-interactive',
                                },
                            }),
                        },
                    }],
                    usage: { prompt_tokens: 120, completion_tokens: 60 },
                }));
                return;
            }
            res.end(JSON.stringify({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            type: 'ready',
                            text: '已识别到 10 月份「整改 / ET（96%，未达标，差4%）」等指标，将直接为您生成整改指标看板。',
                        }),
                    },
                }],
                usage: { prompt_tokens: 90, completion_tokens: 45 },
            }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    return {
        baseUrl: `http://127.0.0.1:${addr.port}/v1`,
        captured,
        setMode(next) { mode = next; },
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

test('summarizeSql handles 8MB SQL literals without stack overflow', () => {
    const hugeSql = `INSERT INTO \`sys_kv_store\` VALUES ('dh_probe_blob', '${'x'.repeat(8192 * 1024)}')`;
    const summary = summarizeSql(hugeSql);
    assert.equal(summary, 'INSERT INTO `sys_kv_store` VALUES (?, ?)');
});

test('AI Monthly Report discovers cross-month SLA & report_metric_data and compiles interactive cells', async () => {
    const mock = await startMockBaseServer();
    const mockAi = await startMockOpenAiServer();
    const port = await getFreePort();

    const child = spawn(process.execPath, ['run.js'], {
        cwd: APP_ROOT,
        env: {
            ...process.env,
            PORT: String(port),
            HOST: '127.0.0.1',
            LOCAL_DEV_MEMORY: '0',
            BASE_QUERY_URL: `${mock.baseUrl}/query`,
            BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
            BASE_DATASOURCES_URL: `${mock.baseUrl}/query/datasources`,
            BASE_REP_OFFICES_URL: `${mock.baseUrl}/common/rep-offices`,
            BASE_APP_MENUS_URL: `${mock.baseUrl}/app/menus`,
            BASE_CACHE_QUERY_URL: `${mock.baseUrl}/cache/query`,
            BASE_CACHE_EXECUTE_URL: `${mock.baseUrl}/cache/execute`,
            BASE_NOTIFY_URL: `${mock.baseUrl}/notify/send`,
            APP_SCHEMA: 'da8d3449-344f-4b10-805d-0f831e2ad754',
            APP_UUID: 'da8d3449-344f-4b10-805d-0f831e2ad754',
            APP_DATASOURCE_ID: '2',
            APP_DATASOURCE_NAME: 'netcare-digital-human-app',
            DH_OPEN_ADMIN: 'true',
            LOG_LEVEL: 'silent',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const appUrl = `http://127.0.0.1:${port}`;
    try {
        await waitForServer(`${appUrl}/api/healthz`);

        // Configure AI profile pointing at mockAi
        const saveAi = await fetch(`${appUrl}/api/ai-settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'MockGLM',
                provider: 'openai-compatible',
                apiBaseUrl: mockAi.baseUrl,
                apiKey: 'test-key',
                model: 'glm-52',
                models: ['glm-52'],
            }),
        });
        assert.equal(saveAi.status, 200, `Expected AI settings save 200, got ${saveAi.status}: ${await saveAi.text()}`);

        // 1. Save an SLA snapshot imported in Nov (2026-11-12) targeting month 10 (2026-10)
        const slaRes = await fetch(`${appUrl}/api/sla/snapshot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: 'sla-snap-nov-for-oct',
                timestamp: '2026-11-12T09:00:00.000Z',
                selectedTargetMonth: 10,
                topMetrics: [
                    {
                        key: 'rectify',
                        label: '整改',
                        value: '96%',
                        target: '≥ 100%',
                        isWarn: true,
                        gap: '-4%',
                        subMetrics: [
                            { category: 'ET', value: '96%', target: '≥ 100%', gap: '-4%', isWarn: true },
                            { category: 'TE', value: '100%', target: '≥ 100%', gap: '0%', isWarn: false },
                        ],
                    },
                ],
            }),
        });
        assert.equal(slaRes.status, 200);

        // 2. Save Report Dashboard snapshot for month 10 (created_at in Nov 2026) with 整改/ET & 拓扑/TE
        const rptRes = await fetch(`${appUrl}/api/db/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                snapshot_id: 'rpt-2026-10',
                month: 10,
                created_at: '2026-11-12 17:10:00',
                standard_total_score: 91.5,
                cat_scores: [
                    { cat_name: 'ET', base_score: 90, manual_score: 90, final_score: 90 },
                    { cat_name: 'TE', base_score: 88, manual_score: 88, final_score: 88 },
                ],
                metric_data: [
                    {
                        cat_name: 'ET',
                        metric_label: '整改',
                        weight: 10,
                        target_val: '≥ 100%',
                        raw_val: '96%',
                        num_val: 96,
                        is_failing: 1,
                        gap: '4%',
                        earned_score: 9.6,
                    },
                    {
                        cat_name: 'TE',
                        metric_label: '拓扑',
                        weight: 8,
                        target_val: '≥ 100%',
                        raw_val: '67%',
                        num_val: 67,
                        is_failing: 1,
                        gap: '33%',
                        earned_score: 5.36,
                    },
                ],
            }),
        });
        assert.equal(rptRes.status, 200);

        // 3. Verify GET /api/ai-report/metrics?month=2026-10 finds cross-month SLA & dashboard metrics
        const mOctRes = await fetch(`${appUrl}/api/ai-report/metrics?month=2026-10`);
        assert.equal(mOctRes.status, 200);
        const mOct = await mOctRes.json();
        const labels = mOct.map((m) => m.label);
        assert.ok(labels.includes('整改 / ET'), `Expected 整改 / ET in 2026-10 metrics, got: ${labels.join(', ')}`);
        assert.ok(labels.includes('拓扑 / TE'), `Expected 拓扑 / TE in 2026-10 metrics, got: ${labels.join(', ')}`);
        const rectifyEt = mOct.find((m) => m.label === '整改 / ET');
        assert.equal(rectifyEt.numValue, 96);
        assert.equal(rectifyEt.isFailing, true);
        assert.equal(rectifyEt.weight, 10);

        // Verify 2026-11 stays isolated and does not pick up month 10 data
        const mNovRes = await fetch(`${appUrl}/api/ai-report/metrics?month=2026-11`);
        const mNov = await mNovRes.json();
        assert.equal(mNov.length, 0);

        // 4. Verify GET /api/ai-report/datasets?month=2026-10 includes report_metric_data & report_category_scores
        const dsRes = await fetch(`${appUrl}/api/ai-report/datasets?month=2026-10`);
        assert.equal(dsRes.status, 200);
        const dsJson = await dsRes.json();
        const rmd = dsJson.datasets.find((d) => d.id === 'report_metric_data');
        const rcs = dsJson.datasets.find((d) => d.id === 'report_category_scores');
        assert.ok(rmd && rmd.rowCount === 2, 'Expected report_metric_data dataset with 2 rows');
        assert.ok(rcs && rcs.rowCount === 2, 'Expected report_category_scores dataset with 2 rows');

        // 5. Verify run-data resolves bare names ('整改'), slash names ('整改 / ET'), and report_metric_data dataset
        const runRes = await fetch(`${appUrl}/api/ai-report/run-data`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                month: '2026-10',
                recipe: {
                    summary: { zh: 'test', en: 'test' },
                    sources: [
                        { id: 'm1', kind: 'metrics', label: '整改', names: ['整改'], monthOffset: 0 },
                        { id: 'd1', kind: 'dataset', dataset: 'report_metric_data', label: '指标明细', monthOffset: 0 },
                    ],
                    compute: 'function compute(i){ return i; }',
                    render: 'function render(r,k){ return ""; }',
                },
            }),
        });
        assert.equal(runRes.status, 200);
        const runJson = await runRes.json();
        assert.equal(runJson.missing.length, 0);
        assert.equal(runJson.input.m1.values['整改 / ET'], 96);
        assert.equal(runJson.input.m1.targets['整改 / ET'], 100);
        assert.ok(runJson.input.m1.metrics.some((m) => m.label === '整改 / ET'));
        assert.equal(runJson.input.d1.rows.length, 2);

        // 6. Verify /api/ai-report/cell/chat includes matched metrics & datasets and forbids external source prompt
        const chatRes = await fetch(`${appUrl}/api/ai-report/cell/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ month: '2026-10', message: '整改指标我想看看' }),
        });
        assert.equal(chatRes.status, 200);
        const chatJson = await chatRes.json();
        assert.equal(chatJson.type, 'ready');
        const aiReq = mockAi.captured.at(-1)?.body;
        assert.ok(aiReq, 'Expected OpenAI chat completion call');
        assert.match(aiReq.messages[0].content, /禁止.*上传Excel\/CSV/);
        assert.match(aiReq.messages[1].content, /整改 \/ ET/);
        assert.match(aiReq.messages[1].content, /report_metric_data/);

        // 7. Verify /api/ai-report/cell/compile with interactive=true enforces kit.interactive & narrative=null
        const cmpRes = await fetch(`${appUrl}/api/ai-report/cell/compile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ month: '2026-10', interactive: true, prompt: '展示本月整改指标' }),
        });
        assert.equal(cmpRes.status, 200);
        const cmpJson = await cmpRes.json();
        assert.match(cmpJson.recipe.render, /kit\.interactive\s*\(/);
        assert.equal(cmpJson.recipe.narrative, null);

        // Even if model mistakenly outputs kit.table when interactive=true, compiler falls back to kit.interactive
        mockAi.setMode('non-interactive-compile');
        const cmpFbRes = await fetch(`${appUrl}/api/ai-report/cell/compile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ month: '2026-10', interactive: true, prompt: '整改指标情况' }),
        });
        assert.equal(cmpFbRes.status, 200);
        const cmpFbJson = await cmpFbRes.json();
        assert.match(cmpFbJson.recipe.render, /kit\.interactive\s*\(/);
        assert.equal(cmpFbJson.recipe.narrative, null);
    } finally {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
        await mockAi.close();
        await mock.close();
    }
});

test('cache operations auto-resolve CACHE datasourceId from /query/datasources when env var omitted', async () => {
    const seenDsIds = [];
    const store = new Map();
    const gw = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (d) => chunks.push(d));
        req.on('end', () => {
            const url = new URL(req.url, 'http://127.0.0.1');
            let body = {};
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = {}; }
            res.setHeader('Content-Type', 'application/json');
            if (url.pathname === '/query/datasources') {
                res.end(JSON.stringify({
                    code: 0,
                    message: 'ok',
                    data: [
                        { id: 2, name: 'netcare-digital-human-app', dbType: 'mysql', dsType: 'APP_CUSTOM' },
                        { id: 4, name: '\r\nnetcare-digital-human-cache', dbType: 'redis', dsType: 'CACHE' },
                    ],
                }));
                return;
            }
            if (url.pathname.startsWith('/cache/')) {
                seenDsIds.push(`${req.method} ${url.pathname} -> ${body.datasourceId}`);
                if (Number(body.datasourceId) !== 4) {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ code: 400, message: `数据源不存在: ${body.datasourceId}`, data: null }));
                    return;
                }
                if (url.pathname === '/cache/execute') {
                    store.set(body.key, body.value);
                    res.end(JSON.stringify({ code: 0, data: { success: true } }));
                    return;
                }
                if (url.pathname === '/cache/query/key') {
                    res.end(JSON.stringify({ code: 0, data: { exists: store.has(body.key), key: body.key, value: store.get(body.key) ?? null } }));
                    return;
                }
                if (url.pathname === '/cache/query') {
                    res.end(JSON.stringify({ code: 0, data: { keys: Array.from(store.keys()), count: store.size } }));
                    return;
                }
                if (url.pathname === '/cache/execute/key' && req.method === 'DELETE') {
                    res.end(JSON.stringify({ code: 0, data: { deleted: store.delete(body.key) } }));
                    return;
                }
            }
            res.end(JSON.stringify({ code: 0, data: { rows: [], affectedRows: 0 } }));
        });
    });
    await new Promise((resolve) => gw.listen(0, '127.0.0.1', resolve));
    const gwUrl = `http://127.0.0.1:${gw.address().port}`;
    const port = await getFreePort();
    const child = spawn(process.execPath, ['run.js'], {
        cwd: APP_ROOT,
        env: {
            ...process.env,
            PORT: String(port),
            HOST: '127.0.0.1',
            LOCAL_DEV_MEMORY: '0',
            BASE_QUERY_URL: `${gwUrl}/query`,
            BASE_EXECUTE_URL: `${gwUrl}/execute`,
            BASE_DATASOURCES_URL: `${gwUrl}/query/datasources`,
            BASE_CACHE_QUERY_URL: `${gwUrl}/cache/query`,
            BASE_CACHE_EXECUTE_URL: `${gwUrl}/cache/execute`,
            APP_SCHEMA: 'da8d3449-344f-4b10-805d-0f831e2ad754',
            APP_UUID: 'da8d3449-344f-4b10-805d-0f831e2ad754',
            APP_DATASOURCE_ID: '2',
            APP_DATASOURCE_NAME: 'netcare-digital-human-app',
            DH_OPEN_ADMIN: 'true',
            LOG_LEVEL: 'silent',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const appUrl = `http://127.0.0.1:${port}`;
    try {
        await waitForServer(`${appUrl}/api/healthz`);
        for (const action of ['cache-set', 'cache-get', 'cache-scan', 'cache-delete']) {
            const r = await fetch(`${appUrl}/api/debug/test/${action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: 'debug_probe_key', value: 'ok' }),
            });
            assert.equal(r.status, 200, `${action} returned ${r.status}`);
            const j = await r.json();
            assert.equal(j.result?.code, 0, `${action} failed: ${JSON.stringify(j)}`);
        }
        assert.equal(seenDsIds.length, 4);
        for (const entry of seenDsIds) {
            assert.match(entry, /-> 4$/);
        }
    } finally {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
        await new Promise((resolve) => gw.close(resolve));
    }
});

test('leave-page guards use AppDialog without native beforeunload and homepage product tour is wired', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const rootDir = path.resolve(import.meta.dirname, '..');

    const aiReportJs = fs.readFileSync(path.join(rootDir, 'static/js/ai-report/app.js'), 'utf8');
    const dutyJs = fs.readFileSync(path.join(rootDir, 'static/js/duty-roster.js'), 'utf8');
    const toolFrameJs = fs.readFileSync(path.join(rootDir, 'static/js/home/tool-frame.js'), 'utf8');
    const tourJs = fs.readFileSync(path.join(rootDir, 'static/js/home/product-tour.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(rootDir, 'static/index.html'), 'utf8');
    const homeV2Js = fs.readFileSync(path.join(rootDir, 'static/js/home/home-v2.js'), 'utf8');

    assert.equal(/\bbeforeunload\b/.test(aiReportJs), false, 'ai-report/app.js should not attach beforeunload');
    assert.equal(/\bbeforeunload\b/.test(dutyJs), false, 'duty-roster.js should not attach beforeunload');
    assert.match(aiReportJs, /window\.__dhIsDirty/);
    assert.match(aiReportJs, /window\.__dhConfirmLeave/);
    assert.match(dutyJs, /window\.__dhIsDirty/);
    assert.match(dutyJs, /window\.__dhConfirmLeave/);
    assert.match(toolFrameJs, /confirmLeaveTool/);
    assert.match(toolFrameJs, /AppDialog\.confirm/);

    assert.match(tourJs, /window\.HomeProductTour\s*=/);
    assert.match(tourJs, /dh_home_tour_v1:/);
    assert.match(tourJs, /navigator\.webdriver/);
    assert.match(tourJs, /restoreSnapshot/);
    assert.match(indexHtml, /js\/home\/product-tour\.js/);
    assert.match(homeV2Js, /HomeProductTour\?\.replay/);
});

