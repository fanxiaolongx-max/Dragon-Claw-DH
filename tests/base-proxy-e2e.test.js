import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.dirname(__dirname);

/**
 * Stateful Mock Digital Human Base Server
 * Simulates NetCare Digital Human Gateway REST APIs:
 *  - POST /query & POST /execute (with netcare / netcare_base permission enforcement + stateful in-mem SQL tables)
 *  - GET /query/datasources, GET /common/rep-offices, GET /app/menus, GET /healthz
 *  - POST /cache/execute, POST /cache/query/key, POST /cache/query, DELETE /cache/execute/key
 *  - POST /notify/send
 */
import { startMockBaseServer, getFreePort, waitForServer } from './helpers/mock-base.js';

test('Base Proxy E2E: full Phase-1 routes, subpath rewriting, debug probes & binary exports', async () => {
    const mock = await startMockBaseServer();
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
            APP_SCHEMA: '79f71a0e-7c2d-44c4-85aa-c1a8d7cb4f08',
            APP_UUID: '79f71a0e-7c2d-44c4-85aa-c1a8d7cb4f08',
            APP_DATASOURCE_ID: '2',
            APP_DATASOURCE_NAME: 'netcare-digital-human-app',
            APP_CACHE_DATASOURCE_ID: '14',
            APP_CACHE_DATASOURCE_NAME: 'redis',
            DEBUG: 'true',
            DH_OPEN_ADMIN: 'true', // 本用例覆盖功能路径；权限规则见 tests/access.test.js
            LOG_LEVEL: 'silent',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const appUrl = `http://127.0.0.1:${port}`;
    const subPrefix = '/digital-human/dh/79f71a0e-7c2d-44c4-85aa-c1a8d7cb4f08';

    try {
        await waitForServer(`${appUrl}/api/healthz`);

        // 1. Health & Base Proxy Mode check
        const hRes = await fetch(`${appUrl}/api/healthz`);
        assert.equal(hRes.status, 200);
        const hJson = await hRes.json();
        assert.equal(hJson.status, 'ok');
        assert.equal(hJson.code, 0);
        assert.equal(hJson.data.status, 'ok');
        assert.equal(hJson.data.runtime, 'node');
        assert.equal(hJson.data.base_api, 'ok');
        assert.equal(hJson.data.data_mode, 'online');
        for (const alias of ['/health', '/healthz', '/api/health']) {
            assert.equal((await (await fetch(`${appUrl}${alias}`)).json()).status, 'ok', alias);
        }

        // 业务错误要带着原因返回给用户，不能被统一成“服务内部错误”
        const missing = await fetch(`${appUrl}/api/ai-report/documents/no-such-doc`);
        assert.equal(missing.status, 404);
        assert.doesNotMatch((await missing.json()).error, /服务内部错误/);
        const badCategory = await fetch(`${appUrl}/api/uiv/categories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(badCategory.status, 400);
        assert.equal((await badCategory.json()).error, '分类名不能为空');

        // 2. Gateway subpath rewriting & trailing slash redirect + Identity SSO
        const bareSubRes = await fetch(`${appUrl}${subPrefix}`, { redirect: 'manual' });
        assert.equal(bareSubRes.status, 302);
        assert.match(bareSubRes.headers.get('location'), /79f71a0e-7c2d-44c4-85aa-c1a8d7cb4f08\/$/);

        const meRes = await fetch(`${appUrl}${subPrefix}/api/auth/me`, {
            headers: {
                'x-forwarded-prefix': subPrefix,
                cookie: 'iLearningXUserName=tester001; current_lang=en_US',
            },
        });
        assert.equal(meRes.status, 200);
        const me = await meRes.json();
        assert.equal(me.username, 'tester001');
        assert.equal(me.lang, 'en-US');

        // 3. Debug Probes + Request ID propagation + Permission Rejection Checks
        const reqId = 'e2e-trace-12345';
        const writeSelfRes = await fetch(`${appUrl}/api/debug/test/write-self`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-request-id': reqId },
            body: JSON.stringify({ msg: 'E2E 探针写入' }),
        });
        const writeSelf = await writeSelfRes.json();
        assert.equal(writeSelf.result.code, 0);
        assert.ok(mock.auditRequests.some((r) => r.path === '/execute' && r.requestId === reqId));

        const querySelf = await (await fetch(`${appUrl}/api/debug/test/query-self`, { method: 'POST' })).json();
        assert.equal(querySelf.result.data.rows[0].msg, 'E2E 探针写入');

        const queryBase = await (await fetch(`${appUrl}/api/debug/test/query-base`, { method: 'POST' })).json();
        assert.equal(queryBase.result.code, 0);

        const writeBase = await (await fetch(`${appUrl}/api/debug/test/write-base`, { method: 'POST' })).json();
        assert.equal(writeBase.result.code, 409);

        const queryNetcare = await (await fetch(`${appUrl}/api/debug/test/query-netcare`, { method: 'POST' })).json();
        assert.equal(queryNetcare.result.code, 400);

        const writeNetcare = await (await fetch(`${appUrl}/api/debug/test/write-netcare`, { method: 'POST' })).json();
        assert.equal(writeNetcare.result.code, 409);

        // Schema Check probe
        const schemaCheck = await (await fetch(`${appUrl}/api/debug/test/schema-check`, { method: 'POST' })).json();
        assert.equal(schemaCheck.result.expectedCount, 64);
        assert.equal(typeof schemaCheck.result.healthy, 'boolean');
        assert.ok(Array.isArray(schemaCheck.result.missingTables));
        assert.ok(Array.isArray(schemaCheck.result.expectedTables));
        assert.ok(typeof schemaCheck.result.upgradeAdvice, 'string');

        // Redis Cache Probes
        await fetch(`${appUrl}/api/debug/test/cache-set`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'probe_test_k', value: 'hello-dh', ttl: 120 }),
        });
        const cacheGet = await (await fetch(`${appUrl}/api/debug/test/cache-get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'probe_test_k' }),
        })).json();
        assert.equal(cacheGet.result.data.exists, true);
        assert.equal(cacheGet.result.data.value, 'hello-dh');

        // Notify test
        const notifyRes = await (await fetch(`${appUrl}/api/debug/notify-test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ module_type: '测试', email_params: { title: 'Hi', content: 'Body' } }),
        })).json();
        assert.equal(notifyRes.result.success, true);
        assert.equal(notifyRes.result.baseResult.data.success, true);
        assert.equal(mock.notifications.length, 1);
        assert.equal(mock.notifications[0].module_type, '测试');

        // Expedite Notify: single recipient by employee ID
        const expNotifySingle = await (await fetch(`${appUrl}/api/expedite/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                recipients: ['l00123'],
                title: '【AIOps 一键催办】指标跟进提醒',
                content: '请尽快处理网络安全分类下未达标指标',
            }),
        })).json();
        assert.equal(expNotifySingle.success, true);
        assert.equal(expNotifySingle.payload.module_type, 'digitalHumanOperations');
        assert.equal(expNotifySingle.payload.sub_module_type, 'writeReport');
        assert.equal(expNotifySingle.payload.msg_type, '1');
        assert.equal(expNotifySingle.payload.email_params.email_to, 'l00123');
        assert.equal(mock.notifications.length, 2);

        // Expedite Notify: batch items based on advanced distribution strategy
        const expNotifyBatch = await (await fetch(`${appUrl}/api/expedite/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [
                    { recipients: ['l00123'], title: '催办1', content: '内容1' },
                    { recipients: ['w00456'], title: '催办2', content: '内容2' },
                ],
            }),
        })).json();
        assert.equal(expNotifyBatch.success, true);
        assert.equal(expNotifyBatch.batch, true);
        assert.equal(expNotifyBatch.sentCount, 2);
        assert.equal(mock.notifications.length, 4);

        // Logs API & SSE stream
        const logsJson = await (await fetch(`${appUrl}/api/debug/logs?limit=20`)).json();
        assert.ok(Array.isArray(logsJson.items) && logsJson.items.length > 0);
        const sseController = new AbortController();
        const sseRes = await fetch(`${appUrl}/api/debug/logs/stream`, { signal: sseController.signal });
        assert.equal(sseRes.headers.get('content-type'), 'text/event-stream; charset=utf-8');
        const reader = sseRes.body.getReader();
        const { value: sseChunk } = await reader.read();
        assert.match(Buffer.from(sseChunk).toString('utf8'), /^data: \{/);
        sseController.abort();

        // 4. Homepage Bootstrap & Shell Routes
        const bootRes = await fetch(`${appUrl}/api/home/bootstrap`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: ['/api/app-version', '/api/nav-settings', '/api/auth/me', '/api/onboarding/defaults/status'] }),
        });
        const boot = await bootRes.json();
        assert.equal(boot.results['/api/nav-settings'].status, 200);
        assert.equal(JSON.parse(boot.results['/api/onboarding/defaults/status'].body).required, false);
        assert.ok(Array.isArray(JSON.parse(boot.results['/api/nav-settings'].body).primaryIds));

        // 5. AI Settings + Streaming Chat via mock LLM endpoint
        const aiCfgRes = await fetch(`${appUrl}/api/ai-settings/profiles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'MockLLM',
                baseUrl: `${mock.baseUrl}/v1`,
                apiKey: 'test-key-000',
                model: 'test-model',
                activate: true,
            }),
        });
        assert.equal(aiCfgRes.status, 201);
        const chatRes = await fetch(`${appUrl}/api/ai/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: 'sess-e2e-1', message: '帮我分析指标', stream: true }),
        });
        assert.equal(chatRes.status, 200);
        const chatNdjson = await chatRes.text();
        const chatEvents = chatNdjson.trim().split('\n').map((l) => JSON.parse(l));
        assert.ok(chatEvents.some((e) => e.type === 'delta'));
        const doneEvt = chatEvents.find((e) => e.type === 'done');
        assert.equal(doneEvt.reply, '你好，这是数字人 AI 回复。');

        // 6. UIV Data Capture + AST Parse + Auto Import + Local Browser 501 Guard
        const macroRes = await fetch(`${appUrl}/api/uiv/run-uivision-macro`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(macroRes.status, 501);

        const astRes = await fetch(`${appUrl}/api/uiv-ai-adapter/parse-fetch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: 'fetch("https://netcare.huawei.com/api/v1/list", { method: "POST", headers: { "x-csrf-token": "abc" }, body: JSON.stringify({ page: 1 }) });' }),
        });
        const ast = await astRes.json();
        assert.equal(ast.parsed.method, 'POST');
        assert.deepEqual(ast.sensitiveHeaderNames, ['x-csrf-token']);

        await fetch(`${appUrl}/api/uiv-auto-import/sess-auto-1/datasets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: 'ext', datasets: [{ name: 'test.csv', rows: [{ a: 1 }] }] }),
        });
        const autoGet = await (await fetch(`${appUrl}/api/uiv-auto-import/sess-auto-1`)).json();
        assert.equal(autoGet.datasets.length, 1);

        // 7. SLA Compressed Snapshot + YuXiang Excel Export
        const snapPayload = { filename: 'demo.xlsx', importedAt: new Date().toISOString(), rows: [{ metric: 'SLA-1', count: 3 }] };
        const gzSnap = zlib.gzipSync(Buffer.from(JSON.stringify(snapPayload))).toString('base64');
        const slaSave = await fetch(`${appUrl}/api/sla/snapshot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ compressedSnapshot: { encoding: 'gzip+base64', data: gzSnap } }),
        });
        assert.equal(slaSave.status, 200);
        const slaList = await (await fetch(`${appUrl}/api/sla/snapshots`)).json();
        assert.equal(slaList.length, 1);

        const postSla = (route, body) => fetch(`${appUrl}${subPrefix}/api/sla/${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const yxPayload = {
            targetMonth: 11,
            metrics: [{
                label: '整改',
                target: '≥ 95',
                TE: { achv: '98%', score: 2.346 },
                ORG: { achv: '90%', score: 0, isFailing: true },
                ET: { achv: '--', score: 0 },
            }],
            adjustments: [
                { label: '人为事故 (含整改逾期、错认漏认)', type: '扣分', unit: 1, TE: { count: 1, score: -1 } },
                { label: 'Jam宣传跨及产品逃生演练/半年', type: '加分', unit: 2, VDF: { count: 1, score: 2 } },
            ],
            totals: {
                subTotal: { TE: 99.72 },
                adjustTotal: { TE: -1, VDF: 2 },
                weightInMonth: { TE: 100 },
                finalResult: { TE: 98.72 },
            },
        };
        const previewRes = await postSla('preview-yuxiang', yxPayload);
        assert.equal(previewRes.status, 200);
        const preview = await previewRes.json();
        assert.equal(preview.maxCol, 18);
        assert.equal(preview.rows.length, preview.maxRow);
        assert.ok(preview.merges.includes('A60:E60'));
        assert.equal(preview.rows[0][9].val, 'Target\n  (Nov.)');
        assert.equal(preview.rows[11][9].val, '≥ 95%');
        assert.equal(preview.rows[11][14].val, '2.35');
        assert.equal(preview.rows[11][15].val, '0.00');
        assert.equal(preview.rows[11][15].color, 'FFFF0000');
        assert.equal(preview.rows[11][16].val, '/');
        assert.equal(preview.rows[59][14].val, '98.72');

        const yxRes = await postSla('export-yuxiang', {
            ...yxPayload,
            overrides: { '12_11': '99%', '12_15': '3.25', '12_16': '', '12_26': 'ignored' },
        });
        assert.equal(yxRes.status, 200);
        assert.match(yxRes.headers.get('content-type'), /spreadsheetml\.sheet/);
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(Buffer.from(await yxRes.arrayBuffer()));
        const worksheet = workbook.worksheets[0];
        assert.equal(worksheet.getCell('K12').value, '99%');
        assert.equal(worksheet.getCell('O12').value, 3.25);
        assert.equal(worksheet.getCell('O12').numFmt, '0.00');
        assert.equal(worksheet.getCell('P12').value, '');
        assert.equal(worksheet.getCell('Z12').value, '[Map:整改]');
        assert.equal(worksheet.getCell('O38').value, -1);
        assert.equal(worksheet.getCell('R54').value, 2);
        assert.equal(worksheet.getCell('O58').value, -1);
        assert.equal(worksheet.getCell('O60').value, 98.72);

        const mappingUrl = `${appUrl}${subPrefix}/api/sla/template-mapping`;
        const mapping = await (await fetch(mappingUrl)).json();
        assert.equal(mapping.find(row => row.r === 12).mapping, '整改');
        const editedMapping = [
            { r: 3, sourceR: 12, text: 'Custom rectification', mapping: '自定义整改' },
            { r: 4, isNew: true, templateSourceR: 3, text: '', mapping: '' },
            ...mapping.filter(row => ![12, 60].includes(row.r)).map((row, idx) => ({ ...row, r: idx + 5 })),
        ];
        const mappingSave = await postSla('template-mapping', editedMapping);
        assert.equal(mappingSave.status, 200);
        const savedMapping = await (await fetch(mappingUrl)).json();
        assert.equal(savedMapping[0].text, 'Custom rectification');
        assert.equal(savedMapping[0].mapping, '自定义整改');
        assert.equal(savedMapping[1].text, '');
        assert.equal(savedMapping.some(row => ['整改', 'SYS_FinalResult'].includes(row.mapping)), false);
        const editedPreview = await (await postSla('preview-yuxiang', {
            ...yxPayload,
            metrics: [{ ...yxPayload.metrics[0], label: '自定义整改' }],
        })).json();
        assert.equal(editedPreview.rows[2][2].val, 'Custom rectification');
        assert.equal(editedPreview.rows[2][14].val, '2.35');
        assert.equal(editedPreview.rows[59][14].val, '100.00');
        assert.ok(editedPreview.rows.every(row => row[14].val !== '98.72'));

        // 8. Report Dashboard Compressed Save + Owners + Backup + Expedite
        const repPayload = {
            snapshot_id: 'rep-snap-1',
            month: 11,
            standard_total_score: 96,
            raw_data: { ok: true },
            cat_scores: [{ cat_name: 'Rect', base_score: 90, final_score: 90 }],
            metric_data: [{ cat_name: 'Rect', metric_label: 'M1', is_failing: 1, gap: '-2%' }],
        };
        const gzRep = zlib.gzipSync(Buffer.from(JSON.stringify(repPayload))).toString('base64');
        const repSave = await fetch(`${appUrl}/api/db/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                transport: { compression: 'gzip+base64' },
                compressedReportPayload: { encoding: 'gzip+base64', data: gzRep },
            }),
        });
        assert.equal(repSave.status, 200);
        const latestFail = await (await fetch(`${appUrl}/api/db/latest_failing`)).json();
        assert.equal(latestFail.snapshot_id, 'rep-snap-1');
        assert.equal(latestFail.failing_metrics.Rect.length, 1);

        // 9. Monthly Pages (/monthly -> ai-report.html, /monthly/legacy -> monthly.html) + MSG Export
        const monthlyHtml = await (await fetch(`${appUrl}/monthly`)).text();
        assert.match(monthlyHtml, /AI 月报/);
        const legacyHtml = await (await fetch(`${appUrl}/monthly/legacy`)).text();
        assert.match(legacyHtml, /monthly-workspace\.js/);
        const aiRedir = await fetch(`${appUrl}/ai-report`, { redirect: 'manual' });
        assert.equal(aiRedir.status, 302);
        assert.equal(aiRedir.headers.get('location'), 'monthly');

        const msgRes = await fetch(`${appUrl}/api/report-msg/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subject: '2026-11 Operations Monthly', html: '<h1>Monthly</h1>', text: 'Monthly' }),
        });
        assert.equal(msgRes.status, 200);
        const msgBuf = Buffer.from(await msgRes.arrayBuffer());
        // OLE2 / CFB magic bytes: D0 CF 11 E0 A1 B1 1A E1
        assert.equal(msgBuf.subarray(0, 8).toString('hex'), 'd0cf11e0a1b11ae1');

        // 10. AI Report Document CRUD
        const docSave = await (await fetch(`${appUrl}/api/ai-report/documents`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '2026-11 AI 月报', reportMonth: '2026-11', pages: [] }),
        })).json();
        assert.ok(docSave.id, `Expected saved doc.id, got: ${JSON.stringify(docSave)}`);
        assert.equal(docSave.reportMonth, '2026-11');
        const docList = await (await fetch(`${appUrl}/api/ai-report/documents`)).json();
        assert.equal(Array.isArray(docList), true);
        assert.equal(docList.length, 1);
        // 默认显示的月报（与主线版一致）：设为默认后排在最前、读取时带标记；另存的新报告不继承
        const doc2 = await (await fetch(`${appUrl}/api/ai-report/documents`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '2026-10 AI 月报', reportMonth: '2026-10', pages: [] }),
        })).json();
        const setDef = await (await fetch(`${appUrl}/api/ai-report/documents/${docSave.id}/default`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isDefault: true }),
        })).json();
        assert.deepEqual(setDef, { id: docSave.id, isDefault: true });
        const listed = await (await fetch(`${appUrl}/api/ai-report/documents`)).json();
        assert.equal(listed[0].id, docSave.id);
        assert.deepEqual(listed.map((d) => d.isDefault), [true, false]);
        assert.equal((await (await fetch(`${appUrl}/api/ai-report/documents/${doc2.id}`)).json()).isDefault, false);
        assert.equal((await (await fetch(`${appUrl}/api/ai-report/documents/${docSave.id}`)).json()).isDefault, true);
        await fetch(`${appUrl}/api/ai-report/documents/${docSave.id}/default`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isDefault: false }) });
        assert.equal((await (await fetch(`${appUrl}/api/ai-report/documents`)).json()).some((d) => d.isDefault), false);
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            await Promise.race([
                new Promise((r) => child.once('exit', r)),
                new Promise((r) => setTimeout(() => { try { child.kill('SIGKILL'); } catch {} r(); }, 2500)),
            ]);
        }
        await mock.close();
    }
    assert.equal(stderr.includes('ERR_'), false, `Unexpected stderr: ${stderr}`);
});
