/**
 * Digital Human Debug Mode Floating Console
 * Persistent bottom-right pill across all pages:
 *  - Tab 1: 基座连通自检 (DB / Redis / Gateway API / Notify probes + Run All)
 *  - Tab 2: 身份与环境 (SSO user / cookies / headers / masked env / subpath DH_BASE)
 *  - Tab 3: 实时后端日志 (SSE live stream + level/category/keyword filter + Clear)
 *  - Tab 4: 快捷路由导航 (Phase-1 pages & health check)
 */
(function () {
    'use strict';
    if (window !== window.top) return;
    if (document.getElementById('dhDebugPill')) return;

    const apiUrl = (path) => (typeof window.dhResolveUrl === 'function' ? window.dhResolveUrl(path) : path);
    const pageUrl = (rel) => {
        const base = window.DH_BASE || '';
        return rel === '' || rel === './' ? (base ? `${base}/` : './') : `${base ? `${base}/` : ''}${rel}`;
    };

    const PROBE_ACTIONS = [
        { action: 'schema-check', label: '🗄️ 数据库完整性检查 (缺表自检)' },
        { action: 'db-tables', label: '📋 列出自建库表' },
        { action: 'kv-roundtrip', label: '🧩 KV 读写与大字段分片闭环' },
        { action: 'write-self', label: '✏️ 写自身 Schema (debug_audit_test)' },
        { action: 'query-self', label: '🔍 查自身 Schema' },
        { action: 'query-base', label: '📖 读共享库 netcare_base' },
        { action: 'query-business', label: '🏭 测读只读业务库 (netcare)' },
        { action: 'write-base', label: '🛡️ 测写 netcare_base (预期拒绝)' },
        { action: 'query-netcare', label: '🛡️ 测读基座 netcare (预期拒绝)' },
        { action: 'write-netcare', label: '🛡️ 测写基座 netcare (预期拒绝)' },
        { action: 'cache-set', label: '⚡ Redis 写入' },
        { action: 'cache-get', label: '⚡ Redis 读取' },
        { action: 'cache-scan', label: '⚡ Redis SCAN' },
        { action: 'cache-delete', label: '🗑️ Redis 删除' },
        { action: 'datasources', label: '🗄️ 数据源列表' },
        { action: 'rep-offices', label: '🏢 代表处列表' },
        { action: 'app-menus', label: '📑 应用菜单权限' },
        { action: 'row-limit', label: '📏 查询行数上限' },
        { action: 'sql-size', label: '📦 单条 SQL 大小上限' },
        { action: 'alert-notify-check', label: '🔔 消息中心与催办名录状态' },
        { action: 'redact-check', label: '🔒 敏感凭据脱敏规则自检' },
    ];

    const state = {
        open: false,
        activeTab: 'probes',
        logs: [],
        clientErrors: [],
        logLevelFilter: 'ALL',
        logQuery: '',
        sse: null,
        ssePaused: false,
        probeResults: [],
        lastSchemaResult: null,
        lastNetResults: {},
        lastNotifyResult: null,
        lastDiagnosticBundle: null,
        summary: null,
    };

    const pushClientError = (kind, message, detail = '') => {
        state.clientErrors.push({
            ts: new Date().toISOString(),
            kind,
            message: String(message || '').slice(0, 400),
            detail: String(detail || '').slice(0, 400),
            path: window.location.pathname + window.location.search,
        });
        if (state.clientErrors.length > 40) state.clientErrors.shift();
    };
    window.addEventListener('error', (evt) => {
        pushClientError('error', evt?.message || 'Script error', evt?.filename ? `${evt.filename}:${evt.lineno}:${evt.colno}` : '');
    });
    window.addEventListener('unhandledrejection', (evt) => {
        const reason = evt?.reason;
        pushClientError('unhandledrejection', reason?.message || String(reason || 'Unhandled rejection'), reason?.stack || '');
    });

    // ── Mount Floating Pill ──
    const pill = document.createElement('button');
    pill.id = 'dhDebugPill';
    pill.type = 'button';
    pill.title = '打开数字人 Web 版调试诊断面板';
    const pillDot = document.createElement('span');
    pillDot.className = 'dh-pill-dot';
    const pillText = document.createElement('span');
    pillText.textContent = '🐛 调试模式';
    pill.append(pillDot, pillText);
    document.body.appendChild(pill);

    // ── Build Drawer DOM ──
    const overlay = document.createElement('div');
    overlay.id = 'dhDebugOverlay';
    overlay.hidden = true;

    const drawer = document.createElement('div');
    drawer.id = 'dhDebugDrawer';
    overlay.appendChild(drawer);
    document.body.appendChild(overlay);

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    // Header
    const head = el('div', 'dh-dbg-head');
    const titleWrap = el('div', 'dh-dbg-title-wrap');
    titleWrap.append(el('span', 'dh-dbg-title', '🛠️ Digital Human 诊断控制台'));
    const modeBadge = el('span', 'dh-dbg-badge', '检测中...');
    titleWrap.appendChild(modeBadge);
    const closeBtn = el('button', 'dh-dbg-close', '✕ 关闭 (Esc)');
    closeBtn.type = 'button';
    head.append(titleWrap, closeBtn);
    drawer.appendChild(head);

    // Tabs
    const tabsBar = el('div', 'dh-dbg-tabs');
    const TAB_DEFS = [
        { id: 'probes', label: '🔌 基座连通自检' },
        { id: 'identity', label: '🪪 身份与环境' },
        { id: 'logs', label: '📜 实时后端日志' },
        { id: 'routes', label: '🧭 快捷路由导航' },
    ];
    const tabBtns = new Map();
    const panels = new Map();

    const bodyWrap = el('div', 'dh-dbg-body');

    for (const def of TAB_DEFS) {
        const btn = el('button', `dh-dbg-tab${def.id === state.activeTab ? ' active' : ''}`, def.label);
        btn.type = 'button';
        btn.dataset.tab = def.id;
        btn.onclick = () => switchTab(def.id);
        tabsBar.appendChild(btn);
        tabBtns.set(def.id, btn);

        const panel = el('div', `dh-dbg-panel${def.id === state.activeTab ? ' active' : ''}`);
        bodyWrap.appendChild(panel);
        panels.set(def.id, panel);
    }

    drawer.append(tabsBar, bodyWrap);

    function switchTab(id) {
        state.activeTab = id;
        for (const [k, btn] of tabBtns.entries()) btn.classList.toggle('active', k === id);
        for (const [k, pnl] of panels.entries()) pnl.classList.toggle('active', k === id);
        if (id === 'identity') { loadSummary(); loadAdmins(); }
        if (id === 'logs') ensureSse();
    }

    // ── Panel 1: 基座连通自检 ──
    const probePanel = panels.get('probes');
    const probeSec = el('div', 'dh-dbg-section');
    const probeH4 = el('h4', '', 'MySQL / Redis / Gateway 探针');
    const headActions = el('div', 'dh-dbg-head-actions');
    const runAllBtn = el('button', 'dh-dbg-btn primary', '🚀 一键全量自检');
    runAllBtn.type = 'button';
    const collectLogsBtn = el('button', 'dh-dbg-btn secondary', '📦 一键收集所有自检详细日志');
    collectLogsBtn.type = 'button';
    collectLogsBtn.title = '一键汇集所有探针结果、环境摘要、后端日志与前端异常，用于反馈排查';
    headActions.append(runAllBtn, collectLogsBtn);
    probeH4.appendChild(headActions);
    probeSec.appendChild(probeH4);

    const exportBar = el('div', 'dh-dbg-export-bar');
    exportBar.hidden = true;
    const exportStatusText = el('span', '', '');
    const exportActions = el('div', 'dh-dbg-head-actions');
    const copyBundleBtn = el('button', 'dh-dbg-btn', '📋 复制完整日志');
    copyBundleBtn.type = 'button';
    const downloadBundleBtn = el('button', 'dh-dbg-btn primary', '⬇️ 下载 JSON 诊断包');
    downloadBundleBtn.type = 'button';
    exportActions.append(copyBundleBtn, downloadBundleBtn);
    exportBar.append(exportStatusText, exportActions);
    probeSec.appendChild(exportBar);

    const btnGrid = el('div', 'dh-dbg-btn-grid');
    for (const item of PROBE_ACTIONS) {
        const b = el('button', 'dh-dbg-btn', item.label);
        b.type = 'button';
        b.onclick = () => runProbe(item.action);
        btnGrid.appendChild(b);
    }
    probeSec.appendChild(btnGrid);

    const probeResultsBox = el('div', 'dh-dbg-probe-list');
    probeSec.appendChild(probeResultsBox);
    probePanel.appendChild(probeSec);

    // ── 数据库表完整性与缺表检查卡片 ──
    const schemaSec = el('div', 'dh-dbg-section');
    const schemaHeader = el('h4', '', '🗄️ 数据库 Schema 完整性与缺表检查');
    const schemaStatusBadge = el('span', 'dh-dbg-pill-ok', '待检测');
    schemaStatusBadge.style.marginLeft = '8px';
    schemaStatusBadge.style.fontSize = '12px';
    schemaHeader.appendChild(schemaStatusBadge);

    const schemaActions = el('div', 'dh-dbg-btn-grid');
    const checkSchemaBtn = el('button', 'dh-dbg-btn primary', '🔍 立即检查数据库表完整性');
    checkSchemaBtn.type = 'button';
    schemaActions.appendChild(checkSchemaBtn);

    const schemaPre = el('pre', 'dh-dbg-pre', '点击「立即检查」对比 db/init.sql 38 张表与当前基座数据库，自动排查是否有漏建的数据表...');
    schemaSec.append(schemaHeader, schemaActions, schemaPre);
    probePanel.appendChild(schemaSec);

    checkSchemaBtn.onclick = async () => {
        schemaPre.textContent = '正在对比检查数据库表...';
        schemaStatusBadge.className = 'dh-dbg-pill-ok';
        schemaStatusBadge.textContent = '检查中...';
        try {
            const started = Date.now();
            const res = await fetch(apiUrl('/api/debug/test/schema-check'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const data = await res.json();
            const r = data.result || data;
            state.lastSchemaResult = r;
            const duration = Date.now() - started;
            if (r.healthy) {
                schemaStatusBadge.className = 'dh-dbg-pill-ok';
                schemaStatusBadge.style.background = '#dcfce7';
                schemaStatusBadge.style.color = '#15803d';
                schemaStatusBadge.textContent = `✅ ${r.presentCount}/${r.expectedCount} 张表全部就绪`;
            } else {
                schemaStatusBadge.className = 'dh-dbg-pill-err';
                schemaStatusBadge.style.background = '#fee2e2';
                schemaStatusBadge.style.color = '#b91c1c';
                schemaStatusBadge.textContent = `⚠️ 缺失 ${r.missingCount} 张表`;
            }
            schemaPre.textContent = JSON.stringify({
                耗时ms: duration,
                健康状态: r.healthy ? '✅ 完整（无缺失表）' : `⚠️ 缺少 ${r.missingCount} 张表`,
                就绪数量: `${r.presentCount} / ${r.expectedCount}`,
                缺失表列表: r.missingTables || [],
                升级建议: r.upgradeAdvice || '',
                当前模式: r.mode,
            }, null, 2);
        } catch (err) {
            schemaStatusBadge.className = 'dh-dbg-pill-err';
            schemaStatusBadge.textContent = '❌ 检测异常';
            schemaPre.textContent = `请求失败: ${err.message}`;
        }
    };

    // 流式与出站：对话是否能逐字输出、模型网关是否可达
    const netSec = el('div', 'dh-dbg-section');
    netSec.appendChild(el('h4', '', '🌐 流式响应与出站连通'));
    const netActions = el('div', 'dh-dbg-btn-grid');
    const streamBtn = el('button', 'dh-dbg-btn', '⏱️ 流式是否被网关缓冲');
    const outboundBtn = el('button', 'dh-dbg-btn', '🛰️ 模型网关出站连通');
    streamBtn.type = 'button';
    outboundBtn.type = 'button';
    netActions.append(streamBtn, outboundBtn);
    const netPre = el('pre', 'dh-dbg-pre', '点击上方按钮开始测试...');
    netSec.append(netActions, netPre);
    probePanel.appendChild(netSec);

    streamBtn.onclick = async () => {
        netPre.textContent = '测试中（约 3 秒）...';
        const res = await runStreamCheckProbe();
        netPre.textContent = JSON.stringify(res.body, null, 2);
    };
    outboundBtn.onclick = async () => {
        netPre.textContent = '测试中...';
        const res = await runOutboundCheckProbe();
        netPre.textContent = JSON.stringify(res.body, null, 2);
    };

    // Custom Notify Tester
    const notifySec = el('div', 'dh-dbg-section');
    notifySec.appendChild(el('h4', '', '📨 自定义消息通知自检 (/api/debug/notify-test)'));
    const notifyTextarea = el('textarea', 'dh-dbg-textarea');
    notifyTextarea.rows = 6;
    const emailNotifyTemplate = () => ({
        module_type: 'digitalHumanOperations',
        sub_module_type: 'writeReport',
        msg_type: '1',
        email_params: {
            title: 'Dragon Claw Digital Human 调试邮件',
            content: '调试面板发送测试邮件通知',
            email_to: '',
            email_cc: '',
        },
    });
    const appMsgNotifyTemplate = () => ({
        module_type: 'digitalHumanOperations',
        sub_module_type: 'writeReport',
        msg_type: '2',
        app_msg_params: {
            title: 'Dragon Claw Digital Human 应用号消息',
            content: '调试面板发送测试应用号消息',
            to_user_account: '',
            type: '1',
        },
    });
    notifyTextarea.value = JSON.stringify(emailNotifyTemplate(), null, 2);
    const notifyActions = el('div', 'dh-dbg-btn-grid');
    notifyActions.style.marginTop = '8px';
    const notifyPresetEmailBtn = el('button', 'dh-dbg-btn', '📧 邮件模板 (msg_type=1)');
    notifyPresetEmailBtn.type = 'button';
    notifyPresetEmailBtn.onclick = () => { notifyTextarea.value = JSON.stringify(emailNotifyTemplate(), null, 2); };
    const notifyPresetAppBtn = el('button', 'dh-dbg-btn', '💬 应用号模板 (msg_type=2)');
    notifyPresetAppBtn.type = 'button';
    notifyPresetAppBtn.onclick = () => { notifyTextarea.value = JSON.stringify(appMsgNotifyTemplate(), null, 2); };
    const notifySendBtn = el('button', 'dh-dbg-btn primary', '发送测试通知');
    notifySendBtn.type = 'button';
    notifyActions.append(notifySendBtn, notifyPresetEmailBtn, notifyPresetAppBtn);
    const notifyPre = el('pre', 'dh-dbg-pre', '点击「发送测试通知」查看基座响应...');
    notifySec.append(notifyTextarea, notifyActions, notifyPre);
    probePanel.appendChild(notifySec);

    notifySendBtn.onclick = async () => {
        notifyPre.textContent = '发送中...';
        try {
            const payload = JSON.parse(notifyTextarea.value || '{}');
            // 默认不带收件人：避免一点按钮就把测试通知发给不相干的人
            if (payload.email_params && !String(payload.email_params.email_to || '').trim()) {
                notifyPre.textContent = '请先在 email_params.email_to 里填上你自己的工号（多个可用英文逗号分隔）或邮箱，再发送。';
                return;
            }
            if (payload.app_msg_params && !String(payload.app_msg_params.to_user_account || '').trim()) {
                notifyPre.textContent = '请先在 app_msg_params.to_user_account 里填上你自己的接收人账号（工号），再发送。';
                return;
            }
            const res = await fetch(apiUrl('/api/debug/notify-test'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ payload }),
            });
            const data = await res.json();
            state.lastNotifyResult = data;
            notifyPre.textContent = JSON.stringify(data, null, 2);
        } catch (err) {
            state.lastNotifyResult = { error: err.message };
            notifyPre.textContent = `请求失败: ${err.message}`;
        }
    };

    function renderProbeResults() {
        probeResultsBox.replaceChildren();
        for (const r of state.probeResults.slice(0, 60)) {
            const card = el('div', 'dh-dbg-probe-card');
            const top = el('div', 'dh-dbg-probe-top');
            const title = el('span', '', `${r.action} (${r.durationMs ?? '-'}ms)`);
            const badge = el('span', r.ok ? 'dh-dbg-pill-ok' : 'dh-dbg-pill-err', r.statusLabel);
            top.append(title, badge);
            const pre = el('pre', 'dh-dbg-pre', JSON.stringify(r.body, null, 2));
            card.append(top, pre);
            probeResultsBox.appendChild(card);
        }
    }

    async function runStreamCheckProbe() {
        const started = Date.now();
        try {
            const res = await fetch(apiUrl('/api/debug/stream-test'));
            const reader = res.body.getReader();
            const arrivals = [];
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.length) arrivals.push(Date.now() - started);
            }
            const spread = arrivals.length ? arrivals[arrivals.length - 1] - arrivals[0] : 0;
            const buffered = arrivals.length <= 1 || spread < 1000;
            const out = {
                结论: buffered ? '被缓冲：数据在结束时一次性到达，对话无法逐字输出（需要平台对该路径关闭代理缓冲）' : '正常：数据分批实时到达，对话可以逐字输出',
                分片到达时间ms: arrivals,
                buffered,
            };
            state.lastNetResults.streamTest = out;
            return { ok: !buffered, durationMs: Date.now() - started, body: out };
        } catch (err) {
            const out = { error: err.message };
            state.lastNetResults.streamTest = out;
            return { ok: false, durationMs: Date.now() - started, body: out };
        }
    }

    async function runOutboundCheckProbe() {
        const started = Date.now();
        try {
            const res = await fetch(apiUrl('/api/debug/outbound-test'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const out = await res.json();
            state.lastNetResults.outboundTest = out;
            return { ok: Boolean(out?.ok), durationMs: Date.now() - started, body: out };
        } catch (err) {
            const out = { ok: false, error: err.message };
            state.lastNetResults.outboundTest = out;
            return { ok: false, durationMs: Date.now() - started, body: out };
        }
    }

    async function runProbe(action, payload = {}) {
        const started = Date.now();
        try {
            const res = await fetch(apiUrl(`/api/debug/test/${encodeURIComponent(action)}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (action === 'schema-check' && data?.result) {
                state.lastSchemaResult = data.result;
            }
            const resultCode = data?.result?.code;
            const isExpectedReject = /^write-(base|netcare)|query-netcare$/.test(action) && (resultCode === 400 || resultCode === 409);
            const kvFailed = action === 'kv-roundtrip' && data?.result && data.result.intact === false;
            const redactFailed = action === 'redact-check' && data?.result && data.result.passed === false;
            const ok = res.ok && !kvFailed && !redactFailed && (isExpectedReject || resultCode === undefined || resultCode === 0);
            state.probeResults.unshift({
                action,
                durationMs: data.durationMs || (Date.now() - started),
                ok,
                statusLabel: isExpectedReject ? `✓ 预期拒绝 (${resultCode})` : (ok ? '✓ 成功' : `✕ 异常 (${res.status})`),
                body: data,
            });
        } catch (err) {
            state.probeResults.unshift({
                action,
                durationMs: Date.now() - started,
                ok: false,
                statusLabel: `✕ ${err.message}`,
                body: { error: err.message },
            });
        }
        renderProbeResults();
    }

    runAllBtn.onclick = async () => {
        runAllBtn.disabled = true;
        collectLogsBtn.disabled = true;
        state.probeResults = [];
        renderProbeResults();

        const extraSteps = 3; // healthz + outbound-test + stream-test
        const totalSteps = PROBE_ACTIONS.length + extraSteps;
        let stepIndex = 0;
        const setProgress = () => {
            stepIndex += 1;
            runAllBtn.textContent = `⏳ 自检中 (${stepIndex}/${totalSteps})...`;
        };

        // 1. /api/healthz
        setProgress();
        try {
            const t0 = Date.now();
            const hRes = await fetch(apiUrl('/api/healthz'));
            const hJson = await hRes.json();
            state.lastNetResults.healthz = hJson;
            state.probeResults.unshift({
                action: 'healthz',
                durationMs: Date.now() - t0,
                ok: hRes.ok && hJson?.status !== 'error',
                statusLabel: hRes.ok ? '✓ 成功' : `✕ 异常 (${hRes.status})`,
                body: hJson,
            });
            renderProbeResults();
        } catch (err) {
            state.probeResults.unshift({
                action: 'healthz',
                durationMs: 0,
                ok: false,
                statusLabel: `✕ ${err.message}`,
                body: { error: err.message },
            });
            renderProbeResults();
        }

        // 2. 所有基座/业务/脱敏探针
        for (const item of PROBE_ACTIONS) {
            setProgress();
            await runProbe(item.action);
        }

        // 3. 模型网关出站连通
        setProgress();
        const outboundRes = await runOutboundCheckProbe();
        state.probeResults.unshift({
            action: 'outbound-test',
            durationMs: outboundRes.durationMs,
            ok: outboundRes.ok,
            statusLabel: outboundRes.ok ? '✓ 可达' : '⚠️ 未配置或不可达',
            body: outboundRes.body,
        });
        renderProbeResults();

        // 4. SSE/NDJSON 流式代理缓冲检测
        setProgress();
        const streamRes = await runStreamCheckProbe();
        state.probeResults.unshift({
            action: 'stream-test',
            durationMs: streamRes.durationMs,
            ok: streamRes.ok,
            statusLabel: streamRes.ok ? '✓ 流式正常' : '⚠️ 被网关缓冲',
            body: streamRes.body,
        });
        renderProbeResults();

        const passCount = state.probeResults.filter((x) => x.ok).length;
        const failCount = state.probeResults.length - passCount;
        await buildDiagnosticBundle();
        exportStatusText.textContent = `全量自检完成：共 ${state.probeResults.length} 项（✓ ${passCount} 通过 / ${failCount} 异常或提示），可直接一键下载或复制检查结果`;
        exportBar.hidden = false;

        runAllBtn.disabled = false;
        collectLogsBtn.disabled = false;
        runAllBtn.textContent = '🚀 一键全量自检';
    };

    function downloadBundleFile(bundle) {
        const text = JSON.stringify(bundle, null, 2);
        const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
        a.href = url;
        a.download = `dh-diagnostic-${ts}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function copyDiagnosticBundle(bundle) {
        const text = JSON.stringify(bundle, null, 2);
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (_) { /* fallback below */ }
        return false;
    }

    async function buildDiagnosticBundle() {
        const [summaryRes, healthRes, logsRes] = await Promise.all([
            fetch(apiUrl('/api/debug/summary')).then((r) => r.json()).catch((e) => ({ error: e.message })),
            fetch(apiUrl('/api/healthz')).then((r) => r.json()).catch((e) => ({ error: e.message })),
            fetch(apiUrl('/api/debug/logs?limit=300')).then((r) => r.json()).catch((e) => ({ items: [], error: e.message })),
        ]);
        if (summaryRes && !summaryRes.error) state.summary = summaryRes;

        const fetchedLogs = Array.isArray(logsRes?.items) ? logsRes.items : [];
        const mergedLogMap = new Map();
        for (const entry of [...fetchedLogs, ...state.logs]) {
            const key = entry?.id ? `id:${entry.id}` : `raw:${entry?.ts || ''}:${entry?.message || ''}`;
            mergedLogMap.set(key, entry);
        }
        const serverLogs = [...mergedLogMap.values()];

        const passCount = state.probeResults.filter((x) => x.ok).length;
        const failCount = state.probeResults.length - passCount;
        const bundle = {
            generatedAt: new Date().toISOString(),
            client: {
                pageUrl: window.location.href,
                dhBase: window.DH_BASE || '',
                userAgent: navigator.userAgent,
                language: navigator.language,
                theme: document.documentElement.getAttribute('data-theme') || 'light',
            },
            healthz: healthRes,
            summary: summaryRes,
            probeSummary: {
                total: state.probeResults.length,
                passed: passCount,
                failedOrWarn: failCount,
                failedActions: state.probeResults.filter((x) => !x.ok).map((x) => ({
                    action: x.action,
                    statusLabel: x.statusLabel,
                    detail: x.body?.error || x.body?.result?.message || x.body?.result?.upgradeAdvice || '',
                })),
            },
            probeResults: state.probeResults,
            schemaCheck: state.lastSchemaResult,
            networkChecks: state.lastNetResults,
            notifyTest: state.lastNotifyResult,
            serverLogsCount: serverLogs.length,
            serverLogs,
            clientErrors: state.clientErrors,
        };
        state.lastDiagnosticBundle = bundle;
        return bundle;
    }

    copyBundleBtn.onclick = async () => {
        const bundle = state.lastDiagnosticBundle || await buildDiagnosticBundle();
        const copied = await copyDiagnosticBundle(bundle);
        copyBundleBtn.textContent = copied ? '✓ 已复制 JSON' : '⚠️ 剪贴板受限，请点下载';
        setTimeout(() => { copyBundleBtn.textContent = '📋 复制完整日志'; }, 2400);
    };

    downloadBundleBtn.onclick = async () => {
        downloadBundleBtn.disabled = true;
        try {
            const bundle = state.lastDiagnosticBundle || await buildDiagnosticBundle();
            downloadBundleFile(bundle);
        } finally {
            downloadBundleBtn.disabled = false;
        }
    };

    collectLogsBtn.onclick = async () => {
        collectLogsBtn.disabled = true;
        collectLogsBtn.textContent = '⏳ 正在收集...';
        try {
            const bundle = await buildDiagnosticBundle();
            const copied = await copyDiagnosticBundle(bundle);
            downloadBundleFile(bundle);
            const tip = state.probeResults.length === 0 ? '（提示：可先点左侧“一键全量自检”再收集以包含完整探针结果）' : '';
            exportStatusText.textContent = `已收集 ${state.probeResults.length} 项自检、${bundle.serverLogsCount} 条后端日志、${state.clientErrors.length} 条前端异常，已自动下载诊断 JSON${copied ? ' 并复制到剪贴板' : ''}${tip}`;
            exportBar.hidden = false;
        } catch (err) {
            exportStatusText.textContent = `收集详细日志失败: ${err.message}`;
            exportBar.hidden = false;
        } finally {
            collectLogsBtn.disabled = false;
            collectLogsBtn.textContent = '📦 一键收集所有自检详细日志';
        }
    };

    // ── Panel 2: 身份与环境 ──
    const identityPanel = panels.get('identity');
    const idSummarySec = el('div', 'dh-dbg-section');
    const idHead = el('h4', '', 'SSO 身份、网关路径与运行时环境变量');
    const idRefreshBtn = el('button', 'dh-dbg-btn', '🔄 刷新');
    idRefreshBtn.type = 'button';
    idRefreshBtn.onclick = loadSummary;
    idHead.appendChild(idRefreshBtn);
    const idKvGrid = el('div', 'dh-dbg-kv-grid');
    const idRawPre = el('pre', 'dh-dbg-pre', '加载中...');
    // 管理员名单：环境变量 DH_ADMIN_USERS 之外的管理员在这里维护（每行或逗号分隔一个工号）
    const adminSec = el('div', 'dh-dbg-section');
    adminSec.appendChild(el('h4', '', '👤 管理员名单'));
    const adminHint = el('small', '', '首位访问者自动成为超级管理员。团队管理员（非超管）受「全员开放」开关控制，仅可用开放功能及个人/协同操作，不能修改全局配置。');
    const adminTextarea = el('textarea', 'dh-dbg-textarea');
    adminTextarea.rows = 3;
    const adminActions = el('div', 'dh-dbg-btn-grid');
    adminActions.style.marginTop = '8px';
    const adminSaveBtn = el('button', 'dh-dbg-btn primary', '保存管理员名单');
    adminSaveBtn.type = 'button';
    const adminMsg = el('small', '', '');
    adminActions.append(adminSaveBtn, adminMsg);
    adminSec.append(adminHint, adminTextarea, adminActions);
    async function loadAdmins() {
        try {
            const data = await (await fetch(apiUrl('/api/auth/admins'))).json();
            adminTextarea.value = (data.stored || []).join('\n');
            adminMsg.textContent = (data.env || []).length ? `环境变量固定管理员：${data.env.join('、')}` : '';
        } catch (err) { adminMsg.textContent = `读取失败: ${err.message}`; }
    }
    adminSaveBtn.onclick = async () => {
        const users = adminTextarea.value.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean);
        try {
            const res = await fetch(apiUrl('/api/auth/admins'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ users }) });
            const data = await res.json();
            adminMsg.textContent = res.ok ? `已保存（${(data.stored || []).length} 人）` : `保存失败：${data.error || res.status}`;
            if (res.ok) loadAdmins();
        } catch (err) { adminMsg.textContent = `保存失败: ${err.message}`; }
    };
    idSummarySec.append(idHead, idKvGrid, idRawPre);
    identityPanel.append(adminSec, idSummarySec);

    async function loadSummary() {
        try {
            const res = await fetch(apiUrl('/api/debug/summary'));
            const data = await res.json();
            state.summary = data;
            const mem = Boolean(data.memoryMode);
            modeBadge.textContent = mem ? '离线内存模式' : '基座代理在线';
            modeBadge.classList.toggle('is-mem', mem);

            idKvGrid.replaceChildren();
            const cards = [
                ['当前用户 (SSO)', `${data.identity?.username || '-'} (${data.identity?.source || 'default'})`],
                ['当前语言 (current_lang)', data.identity?.lang || 'zh-CN'],
                ['前端检测网关前缀 (DH_BASE)', window.DH_BASE || '(根路径 /)'],
                ['APP_SCHEMA', data.env?.APP_SCHEMA || '(未配置)'],
                ['APP_DATASOURCE_ID', String(data.env?.APP_DATASOURCE_ID ?? '-')],
                ['Node / 版本', `${data.nodeVersion} / v${data.version}`],
            ];
            const dep = data.boot?.dependencies;
            if (dep) {
                const missing = [...(dep.required || []), ...(dep.optional || [])].filter((d) => d.have === '未安装').map((d) => d.name);
                cards.push(['依赖检查', `${dep.ok ? '通过' : '不通过'} · ${dep.profile}${missing.length ? ` · 未安装：${missing.join('、')}` : ''}${(dep.problems || []).length ? ` · ${dep.problems.length} 条提示` : ''}`]);
            }
            if (data.boot?.package?.notFromPackage?.length) cards.push(['平台注入的文件', data.boot.package.notFromPackage.join('、')]);
            for (const [k, v] of cards) {
                const kv = el('div', 'dh-dbg-kv');
                kv.append(el('small', '', k), el('code', '', v));
                idKvGrid.appendChild(kv);
            }
            idRawPre.textContent = JSON.stringify(data, null, 2);
        } catch (err) {
            idRawPre.textContent = `获取诊断摘要失败: ${err.message}`;
        }
    }

    // ── Panel 3: 实时后端日志 ──
    const logsPanel = panels.get('logs');
    const logToolbar = el('div', 'dh-dbg-log-toolbar');
    const searchInput = el('input', 'dh-dbg-input');
    searchInput.placeholder = '过滤日志关键词 (路由 / SQL / userId / 错误)...';
    searchInput.style.flex = '1';
    searchInput.style.minWidth = '180px';
    searchInput.oninput = () => { state.logQuery = searchInput.value.trim().toLowerCase(); renderLogs(); };

    const levelBtns = new Map();
    for (const lvl of ['ALL', 'DEBUG', 'INFO', 'WARN', 'ERROR']) {
        const b = el('button', `dh-dbg-btn${lvl === 'ALL' ? ' primary' : ''}`, lvl);
        b.type = 'button';
        b.onclick = () => {
            state.logLevelFilter = lvl;
            for (const [k, btn] of levelBtns.entries()) btn.classList.toggle('primary', k === lvl);
            renderLogs();
        };
        levelBtns.set(lvl, b);
        logToolbar.appendChild(b);
    }
    const pauseBtn = el('button', 'dh-dbg-btn', '⏸ 暂停');
    pauseBtn.type = 'button';
    pauseBtn.onclick = () => {
        state.ssePaused = !state.ssePaused;
        pauseBtn.textContent = state.ssePaused ? '▶ 继续' : '⏸ 暂停';
    };
    const clearBtn = el('button', 'dh-dbg-btn', '🧹 清空');
    clearBtn.type = 'button';
    clearBtn.onclick = async () => {
        state.logs = [];
        pill.classList.remove('is-error-badge');
        renderLogs();
        await fetch(apiUrl('/api/debug/logs/clear'), { method: 'POST' }).catch(() => {});
    };
    logToolbar.append(searchInput, pauseBtn, clearBtn);

    const logListBox = el('div', 'dh-dbg-log-list');
    logsPanel.append(logToolbar, logListBox);

    function renderLogs() {
        const filtered = state.logs.filter((item) => {
            if (state.logLevelFilter !== 'ALL' && item.level !== state.logLevelFilter) return false;
            if (state.logQuery) {
                const hay = `${item.category} ${item.message} ${item.userId} ${item.requestId} ${JSON.stringify(item.detail || '')}`.toLowerCase();
                if (!hay.includes(state.logQuery)) return false;
            }
            return true;
        });
        logListBox.replaceChildren();
        for (const item of filtered.slice(-250)) {
            const row = el('div', 'dh-dbg-log-row');
            const ts = String(item.ts || '').slice(11, 23);
            row.append(
                el('span', 'dh-dbg-log-ts', ts),
                el('span', `dh-dbg-log-lvl ${item.level}`, item.level),
                el('span', 'dh-dbg-log-cat', `[${item.category}]`),
                el('span', '', `${item.message}${item.durationMs != null ? ` (${item.durationMs}ms)` : ''}${item.detail ? ` | ${JSON.stringify(item.detail)}` : ''}`),
            );
            logListBox.appendChild(row);
        }
        logListBox.scrollTop = logListBox.scrollHeight;
    }

    function ensureSse() {
        if (state.sse) return;
        try {
            const es = new EventSource(apiUrl('/api/debug/logs/stream'));
            es.onmessage = (evt) => {
                if (state.ssePaused || !evt.data) return;
                try {
                    const entry = JSON.parse(evt.data);
                    if (state.logs.some((x) => x.id === entry.id)) return;
                    state.logs.push(entry);
                    if (state.logs.length > 500) state.logs.shift();
                    if (entry.level === 'ERROR') pill.classList.add('is-error-badge');
                    if (state.open && state.activeTab === 'logs') renderLogs();
                } catch (_) { /* ignore parse error */ }
            };
            es.onerror = () => { /* EventSource reconnects automatically */ };
            state.sse = es;
        } catch (_) { /* ignore */ }
    }

    // ── Panel 4: 快捷路由导航 ──
    const routesPanel = panels.get('routes');
    const routesSec = el('div', 'dh-dbg-section');
    routesSec.appendChild(el('h4', '', 'Phase-1 已开放页面与健康检查入口（自动保留子路径前缀）'));
    const routeGrid = el('div', 'dh-dbg-route-grid');
    const ROUTES = [
        { path: './', title: '🏠 平台首页 & AI 对话', desc: '双线 Web 主入口 · 工具中心与 AI 对话' },
        { path: 'uivf12', title: '🕷️ 数据抓取 Workbench', desc: '脚本生成 · Copy as Fetch AST 适配 · 扩展下载' },
        { path: 'sla', title: '📥 数据导入 SLA', desc: '数据源管理 · 快照导入 · YuXiang 规则引擎' },
        { path: 'report', title: '📊 报表看板 Report', desc: '压缩报表落库 · 图片/附件存储 · 趋势分析' },
        { path: 'expedite', title: '📣 一键催办 Expedite', desc: '逾期任务筛选 · 催办通知推送与导出' },
        { path: 'monthly', title: '🤖 AI 智能月报', desc: 'ai-report.html · 互动布局 · Excel/MSG 导出' },
        { path: 'monthly/legacy', title: '📰 旧版经典月报', desc: 'monthly.html · 历史月报快照对比与导出' },
        { path: 'bigscreen', title: '🖥️ 运营大屏 Bigscreen', desc: 'ECharts 全景监控 · 责任人矩阵 · 趋势轮播' },
        { path: 'api/healthz', title: '❤️ /api/healthz', desc: '基座网关探测与内存/MySQL健康检查 JSON' },
    ];
    for (const r of ROUTES) {
        const a = el('a', 'dh-dbg-route-card');
        a.href = pageUrl(r.path);
        if (r.path === 'api/healthz') a.target = '_blank';
        a.append(el('strong', '', r.title), el('small', '', r.desc));
        routeGrid.appendChild(a);
    }
    routesSec.appendChild(routeGrid);
    routesPanel.appendChild(routesSec);

    // ── Open / Close handlers ──
    function openDrawer() {
        state.open = true;
        overlay.hidden = false;
        loadSummary();
        ensureSse();
    }
    function closeDrawer() {
        state.open = false;
        overlay.hidden = true;
    }

    pill.onclick = openDrawer;
    closeBtn.onclick = closeDrawer;
    overlay.onclick = (e) => { if (e.target === overlay) closeDrawer(); };
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && state.open) closeDrawer();
    });

    // Load initial badge status quietly once
    setTimeout(loadSummary, 600);
})();
