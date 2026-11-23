// 数据探索 → 数据治理：一键体检（行数巡检 + 收集前 N 行）、异常、表目录（分类 / 中英文映射 / 字典导入）、派生表、收集记录、巡检历史。
(function () {
    'use strict';
    const API = 'api/db-explorer/governance';
    const $ = (sel, root) => (root || document).querySelector(sel);
    const el = (tag, props, children) => {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(props || {})) {
            if (v === undefined || v === null || v === false) continue;
            if (k === 'class') node.className = v;
            else if (k === 'text') node.textContent = v;
            else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
            else if (k === 'dataset') Object.assign(node.dataset, v);
            else node.setAttribute(k, v === true ? '' : v);
        }
        for (const c of [].concat(children || [])) if (c !== null && c !== undefined && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
        return node;
    };
    const api = async (path, options = {}) => {
        const res = await fetch(`${API}${path}`, { credentials: 'same-origin', cache: 'no-store', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
        return data;
    };
    const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('zh-CN'));
    const when = (iso) => {
        if (!iso) return '—';
        const d = new Date(iso);
        const p = (x) => String(x).padStart(2, '0');
        return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const ago = (iso) => {
        if (!iso) return '';
        const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
        if (m < 1) return '刚刚';
        if (m < 60) return `${m} 分钟前`;
        if (m < 1440) return `${Math.round(m / 60)} 小时前`;
        return `${Math.round(m / 1440)} 天前`;
    };
    const toast = (text, bad) => {
        const node = $('#govToast');
        node.textContent = text;
        node.className = `gov-toast${bad ? ' is-bad' : ''}`;
        node.hidden = false;
        clearTimeout(toast.t);
        toast.t = setTimeout(() => { node.hidden = true; }, 3500);
    };
    const ANOMALY = { emptied: '变空', filled: '从空变有', spike: '突增', drop: '突降', new_table: '新表', removed: '表消失', error: '查询失败' };
    const STATUS = { anomaly: '异常', empty: '空表', error: '查询失败', ok: '正常', unchecked: '未巡检', missing: '库里没有（只在字典里）' };
    const SAMPLE = { ok: '已收样例', empty: '无数据', error: '收集失败', inconsistent: '取样为空' };
    const REFRESH = { linked: '源表变化即联动', interval: '按间隔', manual: '只手动' };

    const state = { tab: 'anomalies', status: null, catalog: null, derived: [], category: '', filter: 'all', origin: 'all', dictOnly: false, q: '', poll: 0, shown: false };
    // 表来源标识：NetCare 业务表 / DataFab 表；DataFab 里被看板 SQL 计算引用的再叠「二次加工」
    const ORIGIN = { netcare: ['NetCare', 'NetCare 业务表'], datafab: ['DataFab', 'DataFab 看板表'] };
    const originBadges = (t) => (t ? [
        ORIGIN[t.origin] ? el('span', { class: `gov-origin o-${t.origin}`, text: ORIGIN[t.origin][0], title: ORIGIN[t.origin][1] }) : null,
        t.reprocess ? el('span', { class: 'gov-origin o-reprocess', text: '二次加工', title: `被看板 SQL 计算引用：${(t.derivedBy || []).map((d) => d.nameCn || d.name).slice(0, 6).join('、')}${(t.derivedBy || []).length > 6 ? ' …' : ''}` }) : null,
    ] : []);
    let root;

    function mount() {
        root = $('#viewGov');
        root.replaceChildren(
            el('div', { class: 'gov-head' }, [
                el('div', { class: 'gov-title' }, [el('small', { text: '数据治理' }), el('h2', { text: '业务库巡检与表字典' }), el('p', { id: 'govSub', text: '正在读取…' })]),
                el('div', { class: 'gov-actions' }, [
                    el('button', { class: 'act primary', id: 'govRunAll', type: 'button', title: '巡检所有表的行数，并收集每张表的前 N 行', onclick: () => run('all') }, '一键体检'),
                    el('button', { class: 'act', type: 'button', onclick: () => run('check') }, '只巡检行数'),
                    el('button', { class: 'act', type: 'button', onclick: () => run('collect') }, '只收集样例'),
                    el('button', { class: 'act', type: 'button', onclick: openSettings }, '设置'),
                ]),
            ]),
            el('div', { class: 'gov-progress', id: 'govProgress', hidden: true }, [el('span', { id: 'govProgressText' }), el('i', null, [el('b', { id: 'govProgressBar' })])]),
            el('div', { class: 'gov-kpis', id: 'govKpis' }),
            el('div', { class: 'gov-tabs tabs', role: 'tablist' }, [
                ['anomalies', '本轮异常'], ['catalog', '表目录与字典'], ['derived', '派生表'], ['collect', '收集结果'], ['runs', '巡检历史'],
            ].map(([id, label]) => el('button', { type: 'button', role: 'tab', dataset: { govTab: id }, 'aria-selected': String(state.tab === id), onclick: () => setTab(id) }, label))),
            el('div', { class: 'gov-body card', id: 'govBody' }),
            el('div', { class: 'gov-toast', id: 'govToast', hidden: true, role: 'status' }),
        );
    }

    async function refresh({ catalog = true } = {}) {
        try {
            const [status, view, derived] = await Promise.all([
                api('/status'),
                catalog || !state.catalog ? api('/catalog') : Promise.resolve(state.catalog),
                api('/derived'),
            ]);
            state.status = status; state.catalog = view; state.derived = derived.items || [];
        } catch (error) {
            $('#govSub').textContent = `读取失败：${error.message}`;
            return;
        }
        renderHead();
        renderTab();
        schedulePoll();
    }

    function schedulePoll() {
        clearTimeout(state.poll);
        if (!state.shown) return;
        // 跑着的时候 2 秒刷一次进度，跑完再整体刷新
        if (state.status?.running) state.poll = setTimeout(async () => {
            const wasRunning = state.status.running;
            try { state.status = await api('/status'); } catch { /* 下次再试 */ }
            renderHead();
            if (!state.status.running && wasRunning) { toast('体检完成'); refresh(); } else schedulePoll();
        }, 2000);
    }

    function renderHead() {
        const s = state.status;
        if (!s) return;
        const st = s.state || {};
        const parts = [(s.schemas || []).join('、') || '业务库'];
        if (!s.configured) parts.push('还没有授权业务数据源，巡检暂不可用');
        else {
            parts.push(st.lastCheckAt ? `上次巡检 ${when(st.lastCheckAt)}（${ago(st.lastCheckAt)}）` : '还没有巡检过');
            parts.push(s.settings.enabled ? (st.nextCheckAt ? `下次 ${when(st.nextCheckAt)}` : '等待调度') : '自动巡检已关闭');
            parts.push(`每 ${s.settings.intervalMinutes >= 60 ? `${+(s.settings.intervalMinutes / 60).toFixed(1)} 小时` : `${s.settings.intervalMinutes} 分钟`}`);
        }
        if (st.lastCheckError) parts.push(`上次失败：${st.lastCheckError}`);
        $('#govSub').textContent = parts.join(' · ');
        const running = s.running;
        $('#govProgress').hidden = !running;
        document.querySelectorAll('#viewGov .gov-actions .act').forEach((b, i) => { if (i < 3) b.disabled = Boolean(running) || !s.configured; });
        if (running) {
            const pct = running.total ? Math.round((running.done / running.total) * 100) : 0;
            $('#govProgressText').textContent = `${running.kind === 'collect' ? '正在收集样例' : '正在巡检行数'}：${running.done} / ${running.total || '?'} 张表`;
            $('#govProgressBar').style.width = `${pct}%`;
        }
        const c = state.catalog?.stats || {};
        const run = s.lastRun;
        const kpi = (label, value, hint, tone, tab, filter) => el('button', { type: 'button', class: `gov-kpi${tone ? ` is-${tone}` : ''}`, onclick: tab ? () => { if (filter) { state.filter = filter; state.category = ''; } setTab(tab); } : null }, [el('span', { text: label }), el('strong', { text: value }), el('small', { text: hint || '' })]);
        $('#govKpis').replaceChildren(
            kpi('业务表', fmt(c.tables), state.catalog?.liveError ? `读取失败：${state.catalog.liveError}` : run ? `实际库内 · 共 ${fmt(run.totalRows)} 行` : '实际库内 · 尚未巡检', state.catalog?.liveError ? 'bad' : '', 'catalog', 'all'),
            kpi('本轮异常', fmt(run?.anomalies ?? 0), run ? Object.entries(run.anomalyTypes || {}).map(([k, n]) => `${ANOMALY[k] || k} ${n}`).join(' · ') || '无变化' : '—', run?.anomalies ? 'bad' : 'good', 'anomalies'),
            kpi('空表', fmt(c.empty), '查询正常但 0 行', c.empty ? 'warn' : '', 'catalog', 'empty'),
            kpi('查询失败', fmt(c.errors), '无权限 / 不存在 / 超时…', c.errors ? 'bad' : '', 'catalog', 'error'),
            kpi('中文名覆盖', c.tables ? `${Math.round((c.withCn / c.tables) * 100)}%` : '—', `入字典 ${fmt(c.inDictionary)} 张 · 英文名 ${fmt(c.withEn)}`, '', 'catalog', 'nodict'),
            kpi('派生表', fmt(c.derived), c.derivedErrors ? `${c.derivedErrors} 张计算失败` : '联动刷新', c.derivedErrors ? 'bad' : '', 'derived'),
        );
    }

    function setTab(tab) {
        state.tab = tab;
        root.querySelectorAll('[data-gov-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.govTab === tab)));
        renderTab();
    }

    function renderTab() {
        const body = $('#govBody');
        if (!state.status) return;
        if (!state.status.configured) {
            body.replaceChildren(el('div', { class: 'empty', text: '平台还没有给本应用授权业务数据源（BUSINESS_DATASOURCE_NAME）。授权后这里会自动巡检所有业务表。' }));
            return;
        }
        ({ anomalies: renderAnomalies, catalog: renderCatalog, derived: renderDerived, collect: renderCollect, runs: renderRuns }[state.tab] || renderAnomalies)(body);
    }

    const tableByKey = (key) => state.catalog?.tables.find((t) => t.key === key);
    const nameCell = (key) => {
        const t = tableByKey(key);
        return el('div', { class: 'gov-name' }, [el('div', { class: 'gov-key' }, [el('code', { text: key.split('.').slice(1).join('.') || key }), ...originBadges(t)]), t?.nameCn ? el('span', { text: t.nameCn }) : el('span', { class: 'is-muted', text: '未命名' })]);
    };

    // ── 本轮异常 ──
    function renderAnomalies(body) {
        const run = state.status.lastRun;
        if (!run) { body.replaceChildren(el('div', { class: 'empty', text: '还没有巡检记录。点右上角「一键体检」先建立基线，下一轮起就能发现突增、突降和变空。' })); return; }
        const list = run.anomalyList || [];
        const head = el('div', { class: 'bar' }, [el('span', { class: 'status', text: `第 ${when(run.finishedAt)} 轮 · ${fmt(run.tables)} 张表 · 用时 ${Math.round((run.durationMs || 0) / 1000)} 秒 · 对比基线 ${run.baseline ? '上一轮' : '无（首轮）'}` })]);
        if (!list.length) { body.replaceChildren(head, el('div', { class: 'empty', text: run.baseline ? '和上一轮相比，所有表的数据量都在正常范围内。' : '这是第一轮巡检，已记下各表行数作为基线。' })); return; }
        const rows = list.map((a) => el('tr', { class: `sev-${a.severity}`, onclick: () => openTable(a.key) }, [
            el('td', null, [el('span', { class: `gov-chip t-${a.type}`, text: ANOMALY[a.type] || a.type })]),
            el('td', null, [nameCell(a.key)]),
            el('td', { class: 'num', text: a.prev === undefined ? '—' : fmt(a.prev) }),
            el('td', { class: 'num', text: a.count === undefined ? '—' : fmt(a.count) }),
            el('td', { class: 'num', text: a.delta === undefined ? '' : `${a.delta > 0 ? '+' : ''}${fmt(a.delta)}${a.ratio != null ? `（${a.ratio > 0 ? '+' : ''}${a.ratio}%）` : ''}` }),
            el('td', { class: 'wrap', text: a.text }),
        ]));
        body.replaceChildren(head, el('div', { class: 'grid' }, [el('table', null, [
            el('thead', null, [el('tr', null, ['类型', '表', '上一轮', '本轮', '变化', '说明'].map((h) => el('th', { text: h })))]),
            el('tbody', null, rows),
        ])]), el('p', { class: 'gov-note', text: '同一轮发现的变化已聚合成一条消息发到管理员的消息中心。阈值在「设置」里调。' }));
    }

    // ── 表目录与字典 ──
    function filtered() {
        const q = state.q.trim().toLowerCase();
        return (state.catalog?.tables || []).filter((t) => {
            if (state.dictOnly && !t.inDictionary) return false;
            if (state.category && t.category !== state.category) return false;
            if (state.origin === 'reprocess' ? !t.reprocess : state.origin === 'other' ? Boolean(t.origin) : state.origin !== 'all' && t.origin !== state.origin) return false;
            if (state.filter === 'anomaly' && t.status !== 'anomaly') return false;
            if (state.filter === 'empty' && t.status !== 'empty') return false;
            if (state.filter === 'error' && t.status !== 'error') return false;
            if (state.filter === 'nodict' && t.inDictionary) return false;
            if (state.filter === 'noname' && t.nameCn) return false;
            if (state.filter === 'derived' && !t.derivedBy.length) return false;
            if (state.filter === 'missing' && t.inLive) return false;
            return !q || [t.key, t.nameCn, t.nameEn, t.category, t.subCategory, t.description].some((v) => String(v || '').toLowerCase().includes(q));
        });
    }

    function catalogCategories(view) {
        if (!state.dictOnly) return view.categories;
        const map = new Map();
        for (const t of view.tables) {
            if (!t.inDictionary) continue;
            const name = t.category || '未分类';
            let entry = map.get(name);
            if (!entry) {
                entry = { name, total: 0, anomalies: 0, errors: 0, sub: {} };
                map.set(name, entry);
            }
            entry.total += 1;
            if (t.status === 'anomaly') entry.anomalies += 1;
            else if (t.status === 'error') entry.errors += 1;
            if (t.subCategory) entry.sub[t.subCategory] = (entry.sub[t.subCategory] || 0) + 1;
        }
        return view.categories.map((c) => map.get(c.name)).filter(Boolean);
    }

    function renderCatalog(body) {
        const view = state.catalog;
        const dictCount = view.tables.filter((t) => t.inDictionary).length;
        const visibleCats = catalogCategories(view);
        if (state.category && !visibleCats.some((c) => c.name === state.category)) state.category = '';
        const totalForCats = state.dictOnly ? dictCount : view.tables.length;
        const cats = el('nav', { class: 'gov-cats' }, [
            el('button', { type: 'button', class: !state.category ? 'is-on' : '', onclick: () => { state.category = ''; renderTab(); } }, [el('span', { text: '全部分类' }), el('b', { text: fmt(totalForCats) })]),
            ...visibleCats.map((c) => el('button', { type: 'button', class: state.category === c.name ? 'is-on' : '', title: Object.entries(c.sub).map(([k, n]) => `${k} ${n}`).join('\n'), onclick: () => { state.category = c.name; renderTab(); } }, [
                el('span', { text: c.name }),
                c.anomalies ? el('i', { class: 'dot bad', title: `${c.anomalies} 张异常` }) : c.errors ? el('i', { class: 'dot warn', title: `${c.errors} 张查询失败` }) : null,
                el('b', { text: fmt(c.total) }),
            ])),
        ]);
        const search = el('input', { type: 'search', placeholder: '搜索英文表名、中文名、英文名、说明', value: state.q, oninput: (e) => { state.q = e.target.value; drawList(); } });
        const filters = el('div', { class: 'tabs gov-filters' }, [['all', '全部'], ['anomaly', '异常'], ['empty', '空表'], ['error', '查询失败'], ['nodict', '未入字典'], ['noname', '缺中文名'], ['derived', '有派生'], ...(view.stats.missing ? [['missing', `库里没有 ${view.stats.missing}`]] : [])].map(([id, label]) => el('button', { type: 'button', 'aria-selected': String(state.filter === id), onclick: () => { state.filter = id; if (id === 'nodict') state.dictOnly = false; renderTab(); } }, label)));
        const dictToggle = el('button', {
            type: 'button',
            class: 'gov-dict-toggle',
            'aria-pressed': String(state.dictOnly),
            title: '一键过滤掉所有「非字典」表，只看已在表字典中登记的表（可与其他筛选条件组合）',
            onclick: () => {
                state.dictOnly = !state.dictOnly;
                if (state.dictOnly && state.filter === 'nodict') state.filter = 'all';
                renderTab();
            },
        }, [el('i'), el('span', { text: `只看字典表 (${fmt(dictCount)}/${fmt(view.tables.length)})` })]);
        const s = view.stats;
        const otherCount = view.tables.filter((t) => !t.origin).length;
        const originFilters = el('div', { class: 'gov-origin-filters', role: 'group', 'aria-label': '按表来源筛选' }, [
            ['all', '全部来源', view.tables.length], ['netcare', 'NetCare', s.netcare], ['datafab', 'DataFab', s.datafab], ['reprocess', '二次加工', s.reprocess], ['other', '其他', otherCount],
        ].filter(([id, , n]) => id === 'all' || n).map(([id, label, n]) => el('button', { type: 'button', class: `o-${id}`, 'aria-pressed': String(state.origin === id), onclick: () => { state.origin = id; drawList(); originFilters.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.classList.contains(`o-${state.origin}`)))); } }, [el('span', { text: label }), el('b', { text: fmt(n) })])));
        const filterRow = el('div', { class: 'gov-filter-row' }, [filters, dictToggle, originFilters]);
        const fileInput = el('input', { type: 'file', accept: '.xlsx,.csv,.json,.txt', hidden: true, onchange: (e) => importDictionary(e.target.files[0], e.target) });
        const tools = el('div', { class: 'bar' }, [search, el('span', { class: 'grow' }),
            el('button', { class: 'act', type: 'button', title: '支持 Excel / CSV / JSON；表头自动识别：表名、中文名、英文名、分类、子分类、分层、说明、字段名、字段中文名', onclick: () => fileInput.click() }, '导入表字典'),
            el('a', { class: 'act', href: `${API}/dictionary/export`, download: '', title: '导出 Excel：表标识（NetCare / DataFab / 二次加工）、表字典、最新一键体检结果、字段明细分组上色；改完可直接用「导入表字典」导回' }, '导出字典 / 模板'), fileInput]);
        const listBox = el('div', { class: 'grid gov-list' });
        function drawList() {
            const list = filtered();
            listBox.replaceChildren(list.length ? el('table', null, [
                el('thead', null, [el('tr', null, ['', '英文表名', '中文名', '英文名', '分类 / 子分类', '分层', '行数', '样例', '下游'].map((h) => el('th', { text: h })))]),
                el('tbody', null, list.slice(0, 800).map((t) => el('tr', { onclick: () => openTable(t.key), class: t.status === 'anomaly' ? 'sev-error' : '' }, [
                    el('td', null, [el('i', { class: `dot s-${t.status}`, title: STATUS[t.status] + (t.anomaly ? `：${t.anomaly.text}` : t.error ? `：${t.error}` : '') })]),
                    el('td', null, [el('div', { class: 'gov-key' }, [el('code', { text: t.name }), ...originBadges(t), t.type === 'view' ? el('span', { class: 'gov-tag', text: '视图' }) : null])]),
                    el('td', null, [t.nameCn ? el('span', { text: t.nameCn, title: t.nameCnSource === 'dictionary' ? '来自表字典' : t.nameCnSource === 'comment' ? '来自库表注释' : '来自目录盘点 / 标注' }) : el('span', { class: 'is-muted', text: '—' }), t.nameCn && !t.inDictionary ? el('sup', { class: 'gov-src', text: '非字典' }) : null]),
                    el('td', { text: t.nameEn || '—', class: t.nameEn ? '' : 'is-muted' }),
                    el('td', { text: [t.category, t.subCategory].filter(Boolean).join(' / ') }),
                    el('td', { text: t.layer || '' }),
                    el('td', { class: 'num', text: t.count === null ? (t.status === 'error' ? '失败' : '—') : fmt(t.count) }),
                    el('td', { class: 'wrap', text: t.sample ? (t.sample.status === 'ok' ? `${t.sample.sampled} 行` : (t.sample.reason || SAMPLE[t.sample.status])) : '—', title: t.sample?.reason || '' }),
                    el('td', { text: t.derivedBy.length ? `${t.derivedBy.length} 张` : '' }),
                ]))),
            ]) : el('div', { class: 'empty', text: '没有符合条件的表' }));
            if (list.length > 800) listBox.append(el('p', { class: 'gov-note', text: `只显示前 800 张，共 ${list.length} 张，请用搜索缩小范围` }));
        }
        drawList();
        body.replaceChildren(el('div', { class: 'gov-catalog' }, [cats, el('div', { class: 'gov-main' }, [tools, filterRow, listBox])]));
    }

    async function importDictionary(file, input) {
        if (!file) return;
        const buf = await file.arrayBuffer();
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        const replace = confirm('导入方式：\n确定 = 合并（只更新文件里出现的表，其余保留）\n取消 = 继续选择是否整体替换');
        const mode = replace ? 'merge' : (confirm('整体替换：删除文件里没有的表的字典记录。确定继续？') ? 'replace' : '');
        input.value = '';
        if (!mode) return;
        try {
            const out = await api('/dictionary/import', { method: 'POST', body: JSON.stringify({ filename: file.name, contentBase64: btoa(bin), mode }) });
            toast(`已导入 ${out.tables} 张表（新增 ${out.created}，更新 ${out.updated}），字段映射 ${out.columns} 条`);
            refresh();
        } catch (error) { toast(`导入失败：${error.message}`, true); }
    }

    // ── 单表详情（抽屉） ──
    async function openTable(key) {
        const drawer = openDrawer(key, '加载中…');
        let d;
        try { d = await api(`/tables/${encodeURIComponent(key)}`); } catch (error) { drawer.body.replaceChildren(el('div', { class: 'empty', text: `读取失败：${error.message}` })); return; }
        const t = tableByKey(key) || { key };
        drawer.title.replaceChildren(el('code', { text: key }), t.nameCn ? el('span', { text: ` ${t.nameCn}` }) : '');
        const dict = d.dictionary || {};
        const field = (name, label, wide) => el('label', { class: wide ? 'wide' : '' }, [el('span', { text: label }), wide
            ? el('textarea', { name, rows: 2, text: dict[name] || '' })
            : el('input', { name, value: dict[name] || (name === 'nameCn' ? t.nameCn || '' : name === 'category' && t.category !== '未分类' ? t.category : name === 'subCategory' ? t.subCategory || '' : name === 'layer' ? t.layer || '' : '') })]);
        const form = el('form', { class: 'gov-form', onsubmit: async (e) => {
            e.preventDefault();
            const data = Object.fromEntries(new FormData(form).entries());
            data.columns = [...drawer.body.querySelectorAll('[data-col]')].map((input) => ({ name: input.dataset.col, nameCn: input.value.trim(), type: input.dataset.type || '' })).filter((c) => c.nameCn);
            try { await api(`/dictionary/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify(data) }); toast('字典已保存'); refresh(); } catch (error) { toast(`保存失败：${error.message}`, true); }
        } }, [field('nameCn', '中文名'), field('nameEn', '英文名'), field('category', '分类'), field('subCategory', '子分类'), field('layer', '分层'), field('owner', '负责人'), field('description', '说明', true), field('upstream', '源表（上游，逗号分隔）', true),
            el('div', { class: 'wide bar' }, [el('button', { class: 'act primary', type: 'submit' }, '保存到表字典'), el('span', { class: 'status', text: dict.importedAt ? `字典来源：${dict.source || '手工'} · ${when(dict.importedAt)}` : '还没有入字典，保存后即入字典' })])]);
        const trend = sparkline(d.history || []);
        const s = d.sample;
        const sampleBox = s ? (s.rows?.length
            ? el('div', { class: 'grid' }, [el('table', null, [el('thead', null, [el('tr', null, Object.keys(s.rows[0]).map((c) => el('th', { text: c })))]), el('tbody', null, s.rows.map((r) => el('tr', null, Object.values(r).map((v) => el('td', { text: v === null ? 'NULL' : String(v), class: v === null ? 'null' : '' })))))])])
            : el('div', { class: `gov-reason s-${s.status}` }, [el('strong', { text: SAMPLE[s.status] || s.status }), el('span', { text: s.reason || '' }), s.error ? el('code', { text: s.error }) : null]))
            : el('div', { class: 'empty', text: '还没有收集过样例' });
        const cols = d.columns.length ? el('div', { class: 'grid' }, [el('table', null, [
            el('thead', null, [el('tr', null, ['字段（英文）', '类型', '中文名（可改）', ''].map((h) => el('th', { text: h })))]),
            el('tbody', null, d.columns.map((c) => el('tr', { class: c.missingInDb ? 'is-stale' : '' }, [
                el('td', null, [el('code', { text: c.name })]), el('td', { text: c.type || '' }),
                el('td', null, [el('input', { class: 'gov-colcn', dataset: { col: c.name, type: c.type || '' }, value: c.nameCn || '', placeholder: c.comment || '未填写' })]),
                el('td', { text: c.missingInDb ? '库里已没有' : c.inDictionary ? '字典' : '' }),
            ]))),
        ])]) : el('div', { class: 'empty', text: '字段结构要先「收集样例」后才有' });
        drawer.body.replaceChildren(
            el('section', null, [el('h4', { text: '表字典' }), form]),
            el('section', null, [el('h4', { text: `行数趋势（最近 ${d.history.length} 轮）` }), trend]),
            el('section', null, [el('h4', { text: '字段中英文映射' }), cols, el('p', { class: 'gov-note', text: '改完中文名点上面的「保存到表字典」一起保存。' })]),
            el('section', null, [el('h4', { text: s ? `样例（${when(s.collectId && state.status.lastCollection?.finishedAt)} 收集）` : '样例' }), sampleBox]),
            el('section', null, [el('h4', { text: '下游派生表' }), d.derivedBy.length ? el('ul', { class: 'gov-plain' }, d.derivedBy.map((x) => el('li', { text: `${x.nameCn}（${x.name}）· ${x.status === 'error' ? '计算失败' : '正常'}` }))) : el('p', { class: 'gov-note', text: '没有派生表引用这张表' })]),
        );
    }

    function sparkline(history) {
        const pts = history.filter((h) => h.count !== null);
        if (pts.length < 2) return el('p', { class: 'gov-note', text: pts.length ? `只有 1 轮：${fmt(pts[0].count)} 行` : '还没有行数记录' });
        const w = 560, h = 90, max = Math.max(...pts.map((p) => p.count)), min = Math.min(...pts.map((p) => p.count));
        const x = (i) => 6 + (i * (w - 12)) / (pts.length - 1);
        const y = (v) => (max === min ? h / 2 : 8 + ((max - v) * (h - 16)) / (max - min));
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.setAttribute('class', 'gov-spark'); svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', `行数从 ${pts[0].count} 到 ${pts.at(-1).count}`);
        const path = document.createElementNS(ns, 'polyline');
        path.setAttribute('points', pts.map((p, i) => `${x(i)},${y(p.count)}`).join(' '));
        svg.append(path);
        pts.forEach((p, i) => { const c = document.createElementNS(ns, 'circle'); c.setAttribute('cx', x(i)); c.setAttribute('cy', y(p.count)); c.setAttribute('r', 3); const t = document.createElementNS(ns, 'title'); t.textContent = `${when(p.at)}：${fmt(p.count)} 行`; c.append(t); svg.append(c); });
        return el('div', null, [svg, el('p', { class: 'gov-note', text: `最低 ${fmt(min)} · 最高 ${fmt(max)} · 最新 ${fmt(pts.at(-1).count)}` })]);
    }

    function openDrawer(titleText, loading) {
        $('#govDrawer')?.remove();
        const title = el('h3', { text: titleText });
        const body = el('div', { class: 'gov-drawer-body' }, [el('div', { class: 'empty', text: loading })]);
        const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        const wrap = el('div', { class: 'gov-drawer-wrap', id: 'govDrawer', onclick: (e) => { if (e.target === wrap) close(); } }, [
            el('aside', { class: 'gov-drawer', role: 'dialog', 'aria-modal': 'true' }, [el('header', null, [title, el('button', { type: 'button', class: 'gov-x', 'aria-label': '关闭', onclick: close }, '×')]), body]),
        ]);
        document.addEventListener('keydown', onKey);
        document.body.append(wrap);
        return { title, body, close };
    }

    // ── 派生表 ──
    function renderDerived(body) {
        const items = state.derived;
        const add = el('span', { class: 'gov-actions' }, [
            el('button', { class: 'act primary', type: 'button', onclick: () => editDerived(null) }, '新建派生表'),
            el('button', { class: 'act', type: 'button', title: '粘贴一段段「看板--指标」+ SQL（可以直接从需求 / Excel 复制），DataFab 写法自动改成 MySQL', onclick: importBoards }, '导入看板 SQL'),
        ]);
        const intro = el('p', { class: 'gov-note', text: '派生表 = 一条只读 SELECT 从业务表（或别的派生表）算出的新表，结果存在应用库。设为「源表变化即联动」时：每轮行数巡检发现源表行数变化、或每隔几分钟的轻量指纹检查发现源表有更新，就自动重算。' });
        if (!items.length) { body.replaceChildren(el('div', { class: 'bar' }, [add]), intro, el('div', { class: 'empty', text: '还没有派生表' })); return; }
        const groups = {};
        for (const d of items) (groups[d.category || '未分类'] ||= []).push(d);
        body.replaceChildren(el('div', { class: 'bar' }, [add, el('span', { class: 'grow' })]), intro, ...Object.entries(groups).map(([cat, list]) => el('section', { class: 'gov-dgroup' }, [
            el('h4', { text: `${cat}（${list.length}）` }),
            el('div', { class: 'gov-cards' }, list.map((d) => el('article', { class: `gov-card s-${d.status || 'pending'}` }, [
                el('header', null, [el('strong', { text: d.nameCn }), el('code', { text: d.name })]),
                el('p', { class: 'gov-meta', text: [REFRESH[d.refresh] + (d.refresh === 'interval' ? `（${d.intervalMinutes} 分钟）` : ''), d.enabled ? '' : '已停用', d.status === 'ok' ? `${fmt(d.rowCount)} 行${d.truncated ? '（已截断）' : ''}` : d.status === 'error' ? '计算失败' : '尚未计算'].filter(Boolean).join(' · ') }),
                d.lastRunAt ? el('p', { class: 'gov-meta', text: `上次 ${when(d.lastRunAt)}（${ago(d.lastRunAt)}）· ${d.lastReason || ''} · ${Math.round((d.durationMs || 0) / 100) / 10} 秒` }) : null,
                d.lastError ? el('p', { class: 'gov-err', text: d.lastError }) : null,
                d.cycle ? el('p', { class: 'gov-err', text: `循环引用：${d.cycle}` }) : null,
                d.dependsOn?.length ? el('p', { class: 'gov-meta', text: `引用派生表：${d.dependsOn.join('、')}` }) : null,
                d.dialect === 'datafab' ? el('p', { class: 'gov-meta', title: (d.dialectNotes || []).join('\n'), text: `DataFab 写法，已自动改写成 MySQL${d.dialectNotes?.length ? `（${d.dialectNotes.length} 类改动，悬停查看）` : ''}` }) : null,
                el('div', { class: 'gov-sources' }, d.sources.map((k) => el('button', { type: 'button', class: 'gov-tag', title: tableByKey(k)?.nameCn || '', onclick: () => openTable(k) }, k.split('.').slice(1).join('.')))),
                el('footer', null, [
                    el('button', { class: 'act', type: 'button', onclick: () => showDerivedData(d) }, '查看数据'),
                    el('button', { class: 'act', type: 'button', onclick: async (e) => { e.target.disabled = true; try { const r = await api(`/derived/${d.id}/refresh`, { method: 'POST', body: '{}' }); toast(r.status === 'ok' ? `已重算：${fmt(r.rowCount)} 行` : `计算失败：${r.lastError}`, r.status !== 'ok'); } catch (error) { toast(error.message, true); } refresh({ catalog: false }); } }, '重算'),
                    el('button', { class: 'act', type: 'button', onclick: () => editDerived(d) }, '编辑'),
                    el('button', { class: 'act', type: 'button', onclick: async () => { if (!confirm(`删除派生表「${d.nameCn}」及其计算结果？`)) return; try { await api(`/derived/${d.id}`, { method: 'DELETE' }); toast('已删除'); refresh(); } catch (error) { toast(error.message, true); } } }, '删除'),
                ]),
            ]))),
        ])));
    }

    function editDerived(def) {
        const drawer = openDrawer(def ? `编辑派生表：${def.nameCn}` : '新建派生表', '');
        const v = def ? { ...def, sql: def.dialect === 'datafab' ? def.sourceSql : def.sql } : { refresh: 'linked', intervalMinutes: 60, maxRows: 5000, enabled: true, dialect: 'mysql' };
        const input = (name, label, attrs = {}) => el('label', null, [el('span', { text: label }), el('input', { name, value: v[name] ?? '', ...attrs })]);
        const preview = el('div', { class: 'gov-preview' });
        const form = el('form', { class: 'gov-form', onsubmit: async (e) => {
            e.preventDefault();
            const data = Object.fromEntries(new FormData(form).entries());
            data.enabled = form.querySelector('[name=enabled]').checked;
            try {
                await api(def ? `/derived/${def.id}` : '/derived', { method: def ? 'PUT' : 'POST', body: JSON.stringify(data) });
                toast(def ? '已保存' : '已创建，正在后台首次计算');
                drawer.close();
                setTimeout(() => refresh(), 800);
            } catch (error) { toast(`保存失败：${error.message}`, true); }
        } }, [
            input('name', '英文表名', { required: true, placeholder: 'ticket_by_region', pattern: '[A-Za-z][A-Za-z0-9_]{1,63}', ...(def ? { readonly: true } : {}) }),
            input('nameCn', '中文名', { required: true, placeholder: '工单按地区统计' }),
            input('category', '分类', { placeholder: '与表目录分类一致，便于归档' }),
            el('label', null, [el('span', { text: '刷新方式' }), el('select', { name: 'refresh' }, Object.entries(REFRESH).map(([k, label]) => el('option', { value: k, ...(v.refresh === k ? { selected: true } : {}) }, label)))]),
            input('intervalMinutes', '间隔（分钟，按间隔时用）', { type: 'number', min: 5, max: 10080 }),
            input('maxRows', '最多保留行数（≤5000）', { type: 'number', min: 1, max: 5000 }),
            el('label', null, [el('span', { text: 'SQL 写法' }), el('select', { name: 'dialect' }, [['mysql', 'MySQL（原样执行）'], ['datafab', 'DataFab / Gauss（自动改写成 MySQL）']].map(([k, label]) => el('option', { value: k, ...(v.dialect === k ? { selected: true } : {}) }, label)))]),
            el('label', { class: 'wide' }, [el('span', { text: '说明' }), el('textarea', { name: 'description', rows: 2, text: v.description || '' })]),
            el('label', { class: 'wide' }, [el('span', { text: '计算 SQL（只读 SELECT / WITH；表名可以是业务表，也可以是别的派生表的英文名）' }), el('textarea', { name: 'sql', rows: 9, class: 'mono', required: true, spellcheck: 'false', text: v.sql || '' })]),
            el('label', { class: 'wide gov-check' }, [el('input', { type: 'checkbox', name: 'enabled', ...(v.enabled !== false ? { checked: true } : {}) }), el('span', { text: '启用（停用后不再自动重算）' })]),
            el('div', { class: 'wide bar' }, [
                el('button', { class: 'act', type: 'button', onclick: async () => {
                    preview.replaceChildren(el('p', { class: 'gov-note', text: '试算中…' }));
                    try {
                        const r = await api('/derived/preview', { method: 'POST', body: JSON.stringify({ sql: form.querySelector('[name=sql]').value, dialect: form.querySelector('[name=dialect]').value, ...(def ? { id: def.id, name: def.name } : {}) }) });
                        preview.replaceChildren(...(r.dialectNotes?.length ? [el('p', { class: 'gov-note', text: `已改写：${r.dialectNotes.join('；')}` }), el('pre', { class: 'gov-sql', text: r.sql })] : []), el('p', { class: 'gov-note', text: `${r.dependsOn?.length ? `引用派生表：${r.dependsOn.join('、')} · ` : ''}最终依赖业务表：${r.sources.join('、')} · 前 ${r.rows.length} 行 · ${r.durationMs} ms` }), r.rows.length ? el('div', { class: 'grid' }, [el('table', null, [el('thead', null, [el('tr', null, r.columns.map((c) => el('th', { text: c })))]), el('tbody', null, r.rows.map((row) => el('tr', null, r.columns.map((c) => el('td', { text: row[c] === null ? 'NULL' : String(row[c]) })))))])]) : el('div', { class: 'empty', text: '结果为空' }));
                    } catch (error) { preview.replaceChildren(el('p', { class: 'gov-err', text: error.message })); }
                } }, '试算前 20 行'),
                el('button', { class: 'act primary', type: 'submit' }, '保存'),
            ]),
        ]);
        drawer.body.replaceChildren(form, preview);
    }

    function importBoards() {
        const drawer = openDrawer('导入看板 SQL', '');
        const area = el('textarea', { rows: 14, class: 'mono', spellcheck: 'false', placeholder: '整改清零--整体网元进展\nselect region_cn_name "地区部", ... from rectification_overdue group by region_cn_name\n\n整改发布--地区部汇总\nselect ...' });
        const file = el('input', { type: 'file', accept: '.txt,.sql,.csv', onchange: async (e) => { const f = e.target.files[0]; if (f) area.value = await f.text(); } });
        const result = el('div', { class: 'gov-preview' });
        const send = async (dryRun) => {
            result.replaceChildren(el('p', { class: 'gov-note', text: dryRun ? '拆分中…' : '导入中…' }));
            try {
                const r = await api('/derived/import', { method: 'POST', body: JSON.stringify({ text: area.value, dryRun }) });
                const ACT = { create: '新建', update: '更新', same: '未变化', error: '失败' };
                result.replaceChildren(
                    el('p', { class: 'gov-note', text: `${dryRun ? '将导入' : '已导入'} ${r.total} 段：新建 ${r.created}，更新 ${r.updated}，未变化 ${r.unchanged}${r.errors ? `，失败 ${r.errors}` : ''}${dryRun ? '' : '。正在后台逐张计算，稍后在卡片上看结果'}` }),
                    el('div', { class: 'grid' }, [el('table', null, [
                        el('thead', null, [el('tr', null, ['看板', '指标', '动作', '源表', '改写'].map((h) => el('th', { text: h })))]),
                        el('tbody', null, r.items.map((i) => el('tr', { title: i.sql || i.error || '' }, [el('td', { text: i.board }), el('td', { text: i.metric }), el('td', { text: ACT[i.action] || i.action, class: i.action === 'error' ? 'gov-err' : '' }), el('td', { class: 'wrap', text: i.error || (i.sources || []).join('、') }), el('td', { class: 'wrap', text: (i.notes || []).join('；') })]))),
                    ])]),
                );
                if (!dryRun) refresh();
            } catch (error) { result.replaceChildren(el('p', { class: 'gov-err', text: error.message })); }
        };
        drawer.body.replaceChildren(
            el('p', { class: 'gov-note', text: '每段第一行写「看板--指标」，下面跟一条 SELECT。可以直接粘贴从需求 / Excel 复制的整块内容（被双引号包住的单元格也认）。DataFab 写法（"库"."模式"."表"、divide()、date_trunc、NULLS LAST、引用同级中文别名）会自动改成 MySQL；同一标题再导入会更新原来那张。' }),
            file, area,
            el('div', { class: 'bar' }, [el('button', { class: 'act', type: 'button', onclick: () => send(true) }, '先看拆分结果'), el('button', { class: 'act primary', type: 'button', onclick: () => send(false) }, '导入')]),
            result,
        );
    }

    async function showDerivedData(def) {
        const drawer = openDrawer(`${def.nameCn}（${def.name}）`, '加载中…');
        try {
            const r = await api(`/derived/${def.id}/data?limit=500`);
            drawer.body.replaceChildren(
                el('p', { class: 'gov-note', text: `共 ${fmt(r.total)} 行${r.truncated ? '（达到上限已截断）' : ''} · 计算于 ${when(r.refreshedAt)} · 显示前 ${r.rows.length} 行` }),
                r.rows.length ? el('div', { class: 'grid' }, [el('table', null, [el('thead', null, [el('tr', null, r.columns.map((c) => el('th', { text: (def.columns || []).find((x) => x.name === c)?.nameCn ? `${c}（${def.columns.find((x) => x.name === c).nameCn}）` : c })))]), el('tbody', null, r.rows.map((row) => el('tr', null, r.columns.map((c) => el('td', { text: row[c] === null ? 'NULL' : String(row[c]) })))))])]) : el('div', { class: 'empty', text: '还没有数据' }),
                el('pre', { class: 'gov-sql', text: def.sql }),
            );
        } catch (error) { drawer.body.replaceChildren(el('div', { class: 'empty', text: error.message })); }
    }

    // ── 收集结果 ──
    async function renderCollect(body) {
        const c = state.status.lastCollection;
        if (!c) { body.replaceChildren(el('div', { class: 'empty', text: '还没有收集过。点「只收集样例」或「一键体检」，会把每张业务表的前 N 行和字段结构收下来，空表会说明原因。' })); return; }
        body.replaceChildren(el('div', { class: 'empty', text: '加载中…' }));
        let items = [];
        try { items = (await api(`/collections/${c.id}/tables`)).items || []; } catch (error) { body.replaceChildren(el('div', { class: 'empty', text: error.message })); return; }
        const REASON = { empty: '真的没有数据', inconsistent: '取样为空但计数不为 0', permission: '没有查询权限', missing: '表不存在', timeout: '查询超时', view_broken: '视图出错', unreachable: '业务库连不上', unsupported_name: '表名含特殊字符', error: '其他报错' };
        const notOk = items.filter((t) => t.status !== 'ok');
        body.replaceChildren(
            el('div', { class: 'bar' }, [
                el('span', { class: 'status', text: `${when(c.finishedAt)} 收集 · 每表前 ${c.rows} 行 · ${fmt(c.tables)} 张表：有数据 ${fmt(c.ok)}，空表 ${fmt(c.empty)}，失败 ${fmt(c.error)}${c.inconsistent ? `，异常 ${c.inconsistent}` : ''}` }),
                el('span', { class: 'grow' }),
                el('a', { class: 'act primary', href: `${API}/collections/${c.id}/export`, download: '' }, '导出全部（JSON）'),
            ]),
            el('div', { class: 'gov-reasons' }, Object.entries(c.reasons || {}).map(([k, n]) => el('span', { class: 'gov-chip', text: `${REASON[k] || k} ${n}` }))),
            notOk.length ? el('div', { class: 'grid' }, [el('table', null, [
                el('thead', null, [el('tr', null, ['表', '情况', '原因', '字段数'].map((h) => el('th', { text: h })))]),
                el('tbody', null, notOk.map((t) => el('tr', { onclick: () => openTable(t.key) }, [el('td', null, [nameCell(t.key)]), el('td', { text: SAMPLE[t.status] || t.status }), el('td', { class: 'wrap', text: t.reason }), el('td', { class: 'num', text: fmt(t.columns) })]))),
            ])]) : el('div', { class: 'empty', text: '所有表都收到了样例' }),
        );
    }

    // ── 巡检历史 ──
    async function renderRuns(body) {
        body.replaceChildren(el('div', { class: 'empty', text: '加载中…' }));
        let items = [];
        try { items = (await api('/runs?limit=60')).items || []; } catch (error) { body.replaceChildren(el('div', { class: 'empty', text: error.message })); return; }
        if (!items.length) { body.replaceChildren(el('div', { class: 'empty', text: '还没有巡检记录' })); return; }
        body.replaceChildren(el('div', { class: 'grid' }, [el('table', null, [
            el('thead', null, [el('tr', null, ['时间', '方式', '表', '总行数', '空表', '失败', '异常', '用时'].map((h) => el('th', { text: h })))]),
            el('tbody', null, items.map((r) => el('tr', null, [
                el('td', { text: when(r.finishedAt) }), el('td', { text: r.trigger === 'schedule' ? '定时' : `手动${r.actor ? `（${r.actor}）` : ''}` }),
                el('td', { class: 'num', text: fmt(r.tables) }), el('td', { class: 'num', text: fmt(r.totalRows) }), el('td', { class: 'num', text: fmt(r.empty) }), el('td', { class: 'num', text: fmt(r.errors) }),
                el('td', { class: 'wrap', text: r.anomalies ? Object.entries(r.anomalyTypes || {}).map(([k, n]) => `${ANOMALY[k] || k} ${n}`).join('、') : '—' }),
                el('td', { class: 'num', text: `${Math.round((r.durationMs || 0) / 1000)} 秒` }),
            ]))),
        ])]));
    }

    // ── 设置 ──
    function openSettings() {
        const s = state.status?.settings || {};
        const drawer = openDrawer('巡检设置', '');
        const num = (name, label, attrs, value) => el('label', null, [el('span', { text: label }), el('input', { type: 'number', name, value: value ?? s[name], ...attrs })]);
        const form = el('form', { class: 'gov-form', onsubmit: async (e) => {
            e.preventDefault();
            const data = Object.fromEntries(new FormData(form).entries());
            data.enabled = form.querySelector('[name=enabled]').checked;
            data.notify = form.querySelector('[name=notify]').checked;
            data.changeRatio = Number(data.changeRatio) / 100;
            try { await api('/settings', { method: 'PUT', body: JSON.stringify(data) }); toast('设置已保存'); drawer.close(); refresh({ catalog: false }); } catch (error) { toast(error.message, true); }
        } }, [
            el('label', { class: 'wide gov-check' }, [el('input', { type: 'checkbox', name: 'enabled', ...(s.enabled ? { checked: true } : {}) }), el('span', { text: '自动巡检（关闭后只能手动体检）' })]),
            num('intervalMinutes', '行数巡检周期（分钟，≥15）', { min: 15, max: 10080 }),
            num('collectIntervalMinutes', '自动收集周期（分钟，0 = 只手动）', { min: 0, max: 43200 }),
            num('collectRows', '每表收集前几行（1~200）', { min: 1, max: 200 }),
            num('linkIntervalMinutes', '派生表联动检查间隔（分钟）', { min: 1, max: 1440 }),
            num('changeRatio', '突增 / 突降阈值（%）', { min: 1, max: 10000, step: 1 }, Math.round((s.changeRatio || 0.3) * 100)),
            num('minAbsChange', '至少变化多少行才算', { min: 0 }),
            num('concurrency', '并发查询数（1~8）', { min: 1, max: 8 }),
            el('label', null, [el('span', { text: '行数口径' }), el('select', { name: 'countMode' }, [el('option', { value: 'exact', ...(s.countMode !== 'estimate' ? { selected: true } : {}) }, '精确（COUNT(*)，准但慢）'), el('option', { value: 'estimate', ...(s.countMode === 'estimate' ? { selected: true } : {}) }, '估算（information_schema，快但有误差）')])]),
            el('label', { class: 'wide' }, [el('span', { text: '排除的表（支持 * 通配，或 /正则/，逗号分隔）' }), el('input', { name: 'exclude', value: (s.exclude || []).join(', '), placeholder: '*_bak, tmp_*' })]),
            el('label', { class: 'wide gov-check' }, [el('input', { type: 'checkbox', name: 'notify', ...(s.notify ? { checked: true } : {}) }), el('span', { text: '有异常时聚合成一条消息发给管理员' })]),
            el('div', { class: 'wide bar' }, [el('button', { class: 'act primary', type: 'submit' }, '保存')]),
        ]);
        drawer.body.replaceChildren(form);
    }

    async function run(kind) {
        try {
            await api('/run', { method: 'POST', body: JSON.stringify({ kind }) });
            toast(kind === 'all' ? '已开始体检：先巡检行数，再收集样例' : kind === 'check' ? '已开始巡检行数' : '已开始收集样例');
            state.status = await api('/status');
            renderHead();
            schedulePoll();
        } catch (error) { toast(error.message, true); }
    }

    window.DbGovernance = {
        show() {
            if (!root) mount();
            state.shown = true;
            refresh();
        },
        hide() { state.shown = false; clearTimeout(state.poll); },
        openTable,
    };
})();
