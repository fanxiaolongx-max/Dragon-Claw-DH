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
        { action: 'db-tables', label: '📋 列出自建库表' },
        { action: 'write-self', label: '✏️ 写自身 Schema (debug_audit_test)' },
        { action: 'query-self', label: '🔍 查自身 Schema' },
        { action: 'query-base', label: '📖 读共享库 netcare_base' },
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
    ];

    const state = {
        open: false,
        activeTab: 'probes',
        logs: [],
        logLevelFilter: 'ALL',
        logQuery: '',
        sse: null,
        ssePaused: false,
        probeResults: [],
        summary: null,
    };

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
        if (id === 'identity') loadSummary();
        if (id === 'logs') ensureSse();
    }

    // ── Panel 1: 基座连通自检 ──
    const probePanel = panels.get('probes');
    const probeSec = el('div', 'dh-dbg-section');
    const probeH4 = el('h4', '', 'MySQL / Redis / Gateway 探针');
    const runAllBtn = el('button', 'dh-dbg-btn primary', '🚀 一键全量自检');
    runAllBtn.type = 'button';
    probeH4.appendChild(runAllBtn);
    probeSec.appendChild(probeH4);

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

    // Custom Notify Tester
    const notifySec = el('div', 'dh-dbg-section');
    notifySec.appendChild(el('h4', '', '📨 自定义消息通知自检 (/api/debug/notify-test)'));
    const notifyTextarea = el('textarea', 'dh-dbg-textarea');
    notifyTextarea.rows = 5;
    notifyTextarea.value = JSON.stringify({
        module_type: '业务应用测试',
        sub_module_type: '调试面板探测',
        msg_type: '1',
        email_params: {
            title: 'Dragon Claw Digital Human 调试通知',
            content: '调试面板发送测试消息',
            email_to: 'email:test@huawei.com',
        },
    }, null, 2);
    const notifyActions = el('div', 'dh-dbg-btn-grid');
    notifyActions.style.marginTop = '8px';
    const notifySendBtn = el('button', 'dh-dbg-btn primary', '发送测试通知');
    notifySendBtn.type = 'button';
    notifyActions.appendChild(notifySendBtn);
    const notifyPre = el('pre', 'dh-dbg-pre', '点击「发送测试通知」查看基座响应...');
    notifySec.append(notifyTextarea, notifyActions, notifyPre);
    probePanel.appendChild(notifySec);

    notifySendBtn.onclick = async () => {
        notifyPre.textContent = '发送中...';
        try {
            const payload = JSON.parse(notifyTextarea.value || '{}');
            const res = await fetch(apiUrl('/api/debug/notify-test'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ payload }),
            });
            const data = await res.json();
            notifyPre.textContent = JSON.stringify(data, null, 2);
        } catch (err) {
            notifyPre.textContent = `请求失败: ${err.message}`;
        }
    };

    function renderProbeResults() {
        probeResultsBox.replaceChildren();
        for (const r of state.probeResults.slice(0, 20)) {
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

    async function runProbe(action, payload = {}) {
        const started = Date.now();
        try {
            const res = await fetch(apiUrl(`/api/debug/test/${encodeURIComponent(action)}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            const resultCode = data?.result?.code;
            const isExpectedReject = /^write-(base|netcare)|query-netcare$/.test(action) && (resultCode === 400 || resultCode === 409);
            const ok = res.ok && (isExpectedReject || resultCode === undefined || resultCode === 0);
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
        runAllBtn.textContent = '⏳ 正在探测...';
        state.probeResults = [];
        renderProbeResults();
        for (const item of PROBE_ACTIONS) {
            await runProbe(item.action);
        }
        runAllBtn.disabled = false;
        runAllBtn.textContent = '🚀 一键全量自检';
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
    idSummarySec.append(idHead, idKvGrid, idRawPre);
    identityPanel.appendChild(idSummarySec);

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
