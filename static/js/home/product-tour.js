// 首页新版界面（html[data-ui="v2"]）首次进入产品新手引导：
// 按用户维度记录完成状态；自动展开对应浮层/模式讲解完整工作区，支持上一步/下一步/键盘/跳过，并在结束或跳过时精准恢复进入前状态。
(function () {
    'use strict';

    const root = document.documentElement;
    if (root.getAttribute('data-ui') !== 'v2') return;

    const STORAGE_PREFIX = 'dh_home_tour_v1:';
    const ANIM_MS = 380;
    const STEP_FADE_MS = 150;
    const SAFE_MARGIN = 14;
    const CARD_GAP = 16;

    const COPY = {
        'zh-CN': {
            skip: '跳过引导',
            prev: '上一步',
            next: '下一步',
            done: '开始使用',
            stepOf: '{i} / {n}',
            hintKeys: '← → 切换 · Esc 跳过',
            steps: [
                {
                    id: 'composer',
                    eyebrow: '智能工作台',
                    title: 'Dragon Claw 对话引擎',
                    body: '随时向数字人提问、分析业务指标或下达多步骤任务；支持上传文件（↑）、AI 润色提示词、切换模型与语音输入。',
                    badge: '核心交互'
                },
                {
                    id: 'discover',
                    eyebrow: '快捷入口',
                    title: '一键「发现应用」',
                    body: '点击此处随时唤出「最近使用」与「常用推荐」面板，输入拼音首字母即可秒级检索所有业务工具。',
                    badge: '支持拼音搜索'
                },
                {
                    id: 'tools',
                    eyebrow: '工具中心',
                    title: '全量可视化工具矩阵',
                    body: '切换到工具视图可按分类浏览全部业务应用，支持自由分组、置顶收藏，并在首页内嵌窗口中无缝打开。',
                    badge: '自动切换演示'
                },
                {
                    id: 'sidebar',
                    eyebrow: '工作区导航',
                    title: '对话、频道、技能与定时任务',
                    body: '快速新建会话、接入 WeLink / 微信频道会话、探索技能插件库，或让定时任务在后台自动准点运行。',
                    badge: '高频工作流'
                },
                {
                    id: 'more',
                    eyebrow: '扩展生态',
                    title: '「更多」扩展菜单',
                    body: '展开即可进入资料库、运维待办、需求管理与自定义捷径，常用功能一触即达。',
                    badge: '已为您自动展开'
                },
                {
                    id: 'controls',
                    eyebrow: '效率控制',
                    title: '检索历史与专注模式',
                    body: '支持全局搜索会话、应用与技能，按来源或状态筛选任务，还可随时收起侧栏获得全屏级阅读体验。',
                    badge: '快捷管理'
                },
                {
                    id: 'account',
                    eyebrow: '个人中心',
                    title: '消息通知、外观定制与重温引导',
                    body: '底部聚合消息中心、扫码绑定与账号菜单——切换深浅主题、宽屏模式或以后想再次观看，点这里「新手引导」即可。',
                    badge: '可随时重温'
                }
            ]
        },
        'en-US': {
            skip: 'Skip',
            prev: 'Back',
            next: 'Next',
            done: 'Get started',
            stepOf: '{i} / {n}',
            hintKeys: '← → Navigate · Esc Skip',
            steps: [
                {
                    id: 'composer',
                    eyebrow: 'AI Workspace',
                    title: 'Dragon Claw Conversation Studio',
                    body: 'Ask questions, analyze metrics, or run multi-step workflows. Attach files, enhance prompts, switch models, or dictate by voice.',
                    badge: 'Core'
                },
                {
                    id: 'discover',
                    eyebrow: 'Quick Launch',
                    title: 'Discover Apps Anytime',
                    body: 'Open your recent and recommended tools right over your workspace, with instant search across all business apps.',
                    badge: 'Auto-opened'
                },
                {
                    id: 'tools',
                    eyebrow: 'Tool Gallery',
                    title: 'Unified Business Tool Matrix',
                    body: 'Browse every operational tool by category, organize groups, and launch pages seamlessly inside the workspace.',
                    badge: 'Live Preview'
                },
                {
                    id: 'sidebar',
                    eyebrow: 'Navigation',
                    title: 'Chats, Channels, Skills & Schedules',
                    body: 'Start fresh chats, sync WeLink / WeChat channel threads, manage skills & plugins, or automate recurring schedules.',
                    badge: 'Workflows'
                },
                {
                    id: 'more',
                    eyebrow: 'Extensions',
                    title: 'More Capabilities & Shortcuts',
                    body: 'Access the Knowledge Library, Ops Drafts, Requirements Plaza, tool imports, and custom shortcuts from one clean menu.',
                    badge: 'Auto-opened'
                },
                {
                    id: 'controls',
                    eyebrow: 'Focus & Search',
                    title: 'Global Search, Filters & Collapse',
                    body: 'Search chats, apps, and skills in one keystroke, filter task streams, or collapse the sidebar for distraction-free focus.',
                    badge: 'Productivity'
                },
                {
                    id: 'account',
                    eyebrow: 'Personal Hub',
                    title: 'Alerts, Preferences & Tour Replay',
                    body: 'Check notifications, link channels via QR code, switch light/dark themes or wide layout—and replay this tour anytime here.',
                    badge: 'Replayable'
                }
            ]
        }
    };

    const lang = () => (window.ToolsI18n?.getLanguage?.() === 'en-US' ? 'en-US' : 'zh-CN');
    const copy = () => COPY[lang()] || COPY['zh-CN'];
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

    function currentUserKey() {
        const direct = (() => {
            try { return localStorage.getItem('tools_user') || ''; } catch { return ''; }
        })();
        const u = direct
            || window.__platformUser?.username
            || window.__platformUser?.userId
            || window.__platformUser?.id
            || '';
        return String(u).trim().toLowerCase();
    }

    function storageKeyForUser(userKey = currentUserKey()) {
        return userKey ? `${STORAGE_PREFIX}${userKey}` : '';
    }

    function hasCompleted(userKey = currentUserKey()) {
        const k = storageKeyForUser(userKey);
        if (!k) return true;
        try { return Boolean(localStorage.getItem(k)); } catch { return true; }
    }

    function markCompleted(userKey = currentUserKey()) {
        const k = storageKeyForUser(userKey);
        if (!k) return;
        try {
            localStorage.setItem(k, JSON.stringify({ doneAt: Date.now(), version: 1 }));
        } catch {
            // 隐私模式下忽略写入失败
        }
    }

    function hasOpenModalDialog() {
        const dialogs = document.querySelectorAll('dialog[open]');
        for (const d of dialogs) {
            if (!d.closest('.v2-tour-root')) return true;
        }
        const overlays = document.querySelectorAll('#loginModal:not([hidden]), .auth-overlay.is-open, #navSettingsModal[style*="flex"]');
        return overlays.length > 0;
    }

    function canAutoStart() {
        if (navigator.webdriver) return false;
        if (root.getAttribute('data-ui') !== 'v2') return false;
        const params = new URLSearchParams(location.search);
        if (params.has('app') || params.has('tour') && params.get('tour') === '0') return false;
        if (window.HomeToolFrame?.isOpen?.()) return false;
        if (window.HomeSkillHub?.isOpen?.()) return false;
        if (document.body.classList.contains('v2-library-open')) return false;
        if (hasOpenModalDialog()) return false;
        const userKey = currentUserKey();
        if (!userKey) return false;
        return !hasCompleted(userKey);
    }

    function isElVisible(el) {
        if (!(el instanceof Element)) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
    }

    function unionRect(selectors, options = {}) {
        const pad = options.pad ?? 8;
        const maxH = options.maxH ?? Infinity;
        const maxW = options.maxW ?? Infinity;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let matched = false;
        for (const sel of selectors) {
            const nodes = typeof sel === 'string' ? document.querySelectorAll(sel) : [sel];
            for (const el of nodes) {
                if (!isElVisible(el)) continue;
                const r = el.getBoundingClientRect();
                minX = Math.min(minX, r.left);
                minY = Math.min(minY, r.top);
                maxX = Math.max(maxX, r.right);
                maxY = Math.max(maxY, r.bottom);
                matched = true;
            }
        }
        if (!matched) {
            const w = Math.min(420, window.innerWidth - 40);
            const h = 140;
            return { x: (window.innerWidth - w) / 2, y: (window.innerHeight - h) / 2, width: w, height: h, rx: 16 };
        }
        let x = Math.max(6, minX - pad);
        let y = Math.max(6, minY - pad);
        let w = Math.min(window.innerWidth - x - 6, (maxX - minX) + pad * 2, maxW);
        let h = Math.min(window.innerHeight - y - 6, (maxY - minY) + pad * 2, maxH);
        w = Math.max(40, w);
        h = Math.max(40, h);
        return { x, y, width: w, height: h, rx: options.rx ?? 14 };
    }

    function clickSafe(selector) {
        const el = document.querySelector(selector);
        if (el instanceof HTMLElement) el.click();
    }

    function setSidebar(collapsed) {
        window.HomeV2?.setSideCollapsed?.(Boolean(collapsed));
    }

    function setMode(mode) {
        window.HomeMode?.set?.(mode === 'tools' ? 'tools' : 'chat');
    }

    function closeAllTransientUi() {
        window.HomeV2?.closePop?.();
        const search = document.getElementById('v2Search');
        if (search && getComputedStyle(search).display !== 'none') {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }
    }

    // 每一步的自动进入动作与高亮区域测量
    const STEP_DEFS = [
        {
            id: 'composer',
            async prepare() {
                closeAllTransientUi();
                setMode('chat');
                setSidebar(false);
                await delay(80);
            },
            measure() {
                return unionRect(['.dc-composer-surface', '#dcComposer'], { pad: 10, rx: 22 });
            },
            preferPlacement: 'top'
        },
        {
            id: 'discover',
            async prepare() {
                closeAllTransientUi();
                setMode('chat');
                setSidebar(false);
                await delay(60);
                clickSafe('#v2DiscoverBtn');
                await delay(140);
            },
            measure() {
                const hasPop = isElVisible(document.querySelector('.v2-discover.is-open'));
                return unionRect(hasPop ? ['#v2DiscoverBtn', '.v2-discover.is-open'] : ['#v2DiscoverBtn'], {
                    pad: 10,
                    maxH: window.innerHeight - 28,
                    rx: 16
                });
            },
            preferPlacement: 'right'
        },
        {
            id: 'tools',
            async prepare() {
                closeAllTransientUi();
                setMode('tools');
                setSidebar(false);
                const main = document.querySelector('.home-main');
                if (main) main.scrollTop = 0;
                await delay(130);
            },
            measure() {
                const grid = document.getElementById('toolsGrid');
                const seg = document.querySelector('.v2-tools-modes');
                const selectors = [];
                if (isElVisible(seg)) selectors.push(seg);
                if (isElVisible(grid)) {
                    const cards = [...grid.querySelectorAll('.tool-card')].slice(0, 6).filter(isElVisible);
                    if (cards.length) selectors.push(...cards);
                    else selectors.push(grid);
                }
                return unionRect(selectors.length ? selectors : ['.home-tools-band'], {
                    pad: 12,
                    maxH: Math.min(360, window.innerHeight * 0.52),
                    rx: 18
                });
            },
            preferPlacement: 'bottom'
        },
        {
            id: 'sidebar',
            async prepare() {
                closeAllTransientUi();
                setMode('chat');
                setSidebar(false);
                await delay(100);
            },
            measure() {
                return unionRect(['#homeSidebar .v2-nav'], { pad: 8, rx: 14 });
            },
            preferPlacement: 'right'
        },
        {
            id: 'more',
            async prepare() {
                closeAllTransientUi();
                setMode('chat');
                setSidebar(false);
                await delay(60);
                clickSafe('[data-v2-flyout="more"]');
                await delay(140);
            },
            measure() {
                const hasFly = isElVisible(document.querySelector('.v2-flyout.is-open'));
                return unionRect(
                    hasFly ? ['[data-v2-flyout="more"]', '.v2-flyout.is-open'] : ['[data-v2-flyout="more"]'],
                    { pad: 10, maxH: window.innerHeight - 28, rx: 16 }
                );
            },
            preferPlacement: 'right'
        },
        {
            id: 'controls',
            async prepare() {
                closeAllTransientUi();
                setMode('chat');
                setSidebar(false);
                await delay(80);
            },
            measure() {
                return unionRect(['.v2-side-tools'], { pad: 8, rx: 12 });
            },
            preferPlacement: 'right'
        },
        {
            id: 'account',
            async prepare() {
                closeAllTransientUi();
                setMode('chat');
                setSidebar(false);
                await delay(60);
                clickSafe('#v2UserBtn');
                await delay(140);
            },
            measure() {
                const hasMenu = isElVisible(document.querySelector('.v2-user-pop.is-open'));
                return unionRect(hasMenu ? ['.v2-userbar', '.v2-user-pop.is-open'] : ['.v2-userbar'], {
                    pad: 10,
                    maxH: window.innerHeight - 24,
                    rx: 18
                });
            },
            preferPlacement: 'right'
        }
    ];

    let state = null;

    function snapshotCurrentUi() {
        const main = document.querySelector('.home-main');
        return {
            mode: window.HomeMode?.get?.() === 'tools' ? 'tools' : 'chat',
            sideCollapsed: Boolean(window.HomeV2?.isSideCollapsed?.()),
            libraryOpen: document.body.classList.contains('v2-library-open'),
            scrollTop: main ? main.scrollTop : 0,
            suspendedHub: false,
            suspendedLibrary: false
        };
    }

    function restoreSnapshot(snap) {
        if (!snap) return;
        closeAllTransientUi();
        root.classList.remove('v2-tour-suspending');
        window.HomeV2?.setSideCollapsed?.(snap.sideCollapsed);
        window.HomeMode?.set?.(snap.mode);
        if (snap.libraryOpen) document.body.classList.add('v2-library-open');
        const main = document.querySelector('.home-main');
        if (main) main.scrollTop = snap.scrollTop || 0;
    }

    function createDom() {
        const maskId = `v2TourMask_${Math.random().toString(36).slice(2, 8)}`;
        const rootEl = document.createElement('div');
        rootEl.className = 'v2-tour-root';
        rootEl.setAttribute('role', 'dialog');
        rootEl.setAttribute('aria-modal', 'true');
        rootEl.innerHTML = `
            <div class="v2-tour-backdrop" aria-hidden="true">
                <svg class="v2-tour-svg" width="100%" height="100%">
                    <defs>
                        <mask id="${maskId}">
                            <rect x="0" y="0" width="100%" height="100%" fill="white"></rect>
                            <rect class="v2-tour-cutout" x="0" y="0" width="120" height="60" rx="14" ry="14" fill="black"></rect>
                        </mask>
                    </defs>
                    <rect class="v2-tour-scrim" x="0" y="0" width="100%" height="100%" mask="url(#${maskId})"></rect>
                </svg>
            </div>
            <div class="v2-tour-ring" aria-hidden="true"></div>
            <section class="v2-tour-card" aria-live="polite">
                <div class="v2-tour-top">
                    <div class="v2-tour-meta">
                        <span class="v2-tour-eyebrow"></span>
                        <span class="v2-tour-badge"></span>
                    </div>
                    <button type="button" class="v2-tour-skip"></button>
                </div>
                <div class="v2-tour-body">
                    <h3 class="v2-tour-title"></h3>
                    <p class="v2-tour-desc"></p>
                </div>
                <div class="v2-tour-foot">
                    <div class="v2-tour-dots" aria-hidden="true"></div>
                    <div class="v2-tour-actions">
                        <button type="button" class="v2-tour-btn is-ghost" data-tour-prev></button>
                        <button type="button" class="v2-tour-btn is-primary" data-tour-next></button>
                    </div>
                </div>
                <div class="v2-tour-kbd"></div>
            </section>`;
        document.body.appendChild(rootEl);
        return {
            rootEl,
            backdrop: rootEl.querySelector('.v2-tour-backdrop'),
            cutout: rootEl.querySelector('.v2-tour-cutout'),
            ring: rootEl.querySelector('.v2-tour-ring'),
            card: rootEl.querySelector('.v2-tour-card'),
            eyebrow: rootEl.querySelector('.v2-tour-eyebrow'),
            badge: rootEl.querySelector('.v2-tour-badge'),
            skipBtn: rootEl.querySelector('.v2-tour-skip'),
            body: rootEl.querySelector('.v2-tour-body'),
            title: rootEl.querySelector('.v2-tour-title'),
            desc: rootEl.querySelector('.v2-tour-desc'),
            dots: rootEl.querySelector('.v2-tour-dots'),
            prevBtn: rootEl.querySelector('[data-tour-prev]'),
            nextBtn: rootEl.querySelector('[data-tour-next]'),
            kbd: rootEl.querySelector('.v2-tour-kbd')
        };
    }

    function easeOutCubic(t) {
        return 1 - Math.pow(1 - t, 3);
    }

    function applyCutout(dom, rect) {
        dom.cutout.setAttribute('x', rect.x.toFixed(1));
        dom.cutout.setAttribute('y', rect.y.toFixed(1));
        dom.cutout.setAttribute('width', rect.width.toFixed(1));
        dom.cutout.setAttribute('height', rect.height.toFixed(1));
        dom.cutout.setAttribute('rx', rect.rx.toFixed(1));
        dom.cutout.setAttribute('ry', rect.rx.toFixed(1));

        dom.ring.style.transform = `translate3d(${rect.x.toFixed(1)}px, ${rect.y.toFixed(1)}px, 0)`;
        dom.ring.style.width = `${rect.width.toFixed(1)}px`;
        dom.ring.style.height = `${rect.height.toFixed(1)}px`;
        dom.ring.style.borderRadius = `${rect.rx.toFixed(1)}px`;
    }

    function animateCutoutTo(nextRect) {
        if (!state) return;
        const { dom } = state;
        if (state.raf) cancelAnimationFrame(state.raf);
        const startRect = state.currentRect || { ...nextRect };
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !state.currentRect) {
            state.currentRect = nextRect;
            applyCutout(dom, nextRect);
            return;
        }
        const t0 = performance.now();
        const tick = now => {
            if (!state) return;
            const p = clamp((now - t0) / ANIM_MS, 0, 1);
            const e = easeOutCubic(p);
            const cur = {
                x: startRect.x + (nextRect.x - startRect.x) * e,
                y: startRect.y + (nextRect.y - startRect.y) * e,
                width: startRect.width + (nextRect.width - startRect.width) * e,
                height: startRect.height + (nextRect.height - startRect.height) * e,
                rx: startRect.rx + (nextRect.rx - startRect.rx) * e
            };
            state.currentRect = cur;
            applyCutout(dom, cur);
            if (p < 1) {
                state.raf = requestAnimationFrame(tick);
            } else {
                state.currentRect = nextRect;
                state.raf = 0;
            }
        };
        state.raf = requestAnimationFrame(tick);
    }

    function overlapArea(a, b) {
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.width) - Math.max(a.x, b.x));
        const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.height) - Math.max(a.y, b.y));
        return ix * iy;
    }

    function placeCard(targetRect, preferPlacement) {
        if (!state) return;
        const { card } = state.dom;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const cw = Math.min(356, vw - SAFE_MARGIN * 2);
        card.style.width = `${cw}px`;
        const ch = card.offsetHeight || 220;

        const order = [preferPlacement, 'right', 'bottom', 'top', 'left']
            .filter((v, idx, arr) => v && arr.indexOf(v) === idx);

        const candidates = {
            right: {
                x: targetRect.x + targetRect.width + CARD_GAP,
                y: clamp(targetRect.y + (targetRect.height - ch) / 2, SAFE_MARGIN, vh - ch - SAFE_MARGIN)
            },
            left: {
                x: targetRect.x - cw - CARD_GAP,
                y: clamp(targetRect.y + (targetRect.height - ch) / 2, SAFE_MARGIN, vh - ch - SAFE_MARGIN)
            },
            bottom: {
                x: clamp(targetRect.x + (targetRect.width - cw) / 2, SAFE_MARGIN, vw - cw - SAFE_MARGIN),
                y: targetRect.y + targetRect.height + CARD_GAP
            },
            top: {
                x: clamp(targetRect.x + (targetRect.width - cw) / 2, SAFE_MARGIN, vw - cw - SAFE_MARGIN),
                y: targetRect.y - ch - CARD_GAP
            }
        };

        let best = null;
        let bestScore = Infinity;
        for (let i = 0; i < order.length; i++) {
            const p = candidates[order[i]];
            if (!p) continue;
            const cx = clamp(p.x, SAFE_MARGIN, vw - cw - SAFE_MARGIN);
            const cy = clamp(p.y, SAFE_MARGIN, vh - ch - SAFE_MARGIN);
            const outOfBounds = (p.x < SAFE_MARGIN || p.x + cw > vw - SAFE_MARGIN || p.y < SAFE_MARGIN || p.y + ch > vh - SAFE_MARGIN) ? 1 : 0;
            const area = overlapArea({ x: cx, y: cy, w: cw, h: ch }, targetRect);
            const score = area * 10 + outOfBounds * 5000 + i * 25;
            if (score < bestScore) {
                bestScore = score;
                best = { x: cx, y: cy };
            }
        }
        const chosen = best || {
            x: clamp(vw - cw - SAFE_MARGIN, SAFE_MARGIN, vw - cw - SAFE_MARGIN),
            y: clamp(vh - ch - SAFE_MARGIN, SAFE_MARGIN, vh - ch - SAFE_MARGIN)
        };
        card.style.transform = `translate3d(${chosen.x.toFixed(1)}px, ${chosen.y.toFixed(1)}px, 0)`;
    }

    function updateCardContent(index) {
        if (!state) return;
        const { dom } = state;
        const c = copy();
        const total = STEP_DEFS.length;
        const stepCopy = c.steps[index] || c.steps[0];

        dom.eyebrow.textContent = `${stepCopy.eyebrow} · ${c.stepOf.replace('{i}', String(index + 1)).replace('{n}', String(total))}`;
        dom.badge.textContent = stepCopy.badge || '';
        dom.badge.hidden = !stepCopy.badge;
        dom.skipBtn.textContent = c.skip;
        dom.title.textContent = stepCopy.title;
        dom.desc.textContent = stepCopy.body;
        dom.prevBtn.textContent = c.prev;
        dom.prevBtn.hidden = index === 0;
        dom.nextBtn.textContent = index === total - 1 ? c.done : c.next;
        dom.kbd.textContent = c.hintKeys;

        dom.dots.innerHTML = STEP_DEFS.map((_, i) =>
            `<button type="button" class="v2-tour-dot${i === index ? ' is-active' : i < index ? ' is-done' : ''}" data-tour-dot="${i}" aria-label="${esc(c.steps[i]?.title || '')}"></button>`
        ).join('');
    }

    async function goToStep(index) {
        if (!state) return;
        const bounded = clamp(index, 0, STEP_DEFS.length - 1);
        const token = ++state.navToken;
        state.index = bounded;
        const def = STEP_DEFS[bounded];

        state.dom.card.classList.add('is-transitioning');
        await def.prepare();
        if (!state || state.navToken !== token) return;

        const rect = def.measure();
        updateCardContent(bounded);
        animateCutoutTo(rect);
        placeCard(rect, def.preferPlacement);

        setTimeout(() => {
            if (!state || state.navToken !== token) return;
            state.dom.card.classList.remove('is-transitioning');
        }, Math.min(STEP_FADE_MS, 90));
    }

    function stop({ complete = true } = {}) {
        if (!state) return;
        const current = state;
        state = null;
        if (current.raf) cancelAnimationFrame(current.raf);
        document.removeEventListener('keydown', current.onKeyDown, true);
        window.removeEventListener('resize', current.onResize);
        current.dom.rootEl.classList.remove('is-open');

        if (complete) markCompleted(current.userKey);
        restoreSnapshot(current.snapshot);

        setTimeout(() => {
            current.dom.rootEl.remove();
        }, 260);
    }

    async function start(options = {}) {
        if (state) return;
        const force = Boolean(options.force);
        const userKey = currentUserKey() || (force ? 'guest' : '');
        if (!force && !canAutoStart()) return;

        const snapshot = snapshotCurrentUi();
        if (snapshot.libraryOpen) document.body.classList.remove('v2-library-open');
        if (window.HomeToolFrame?.isOpen?.() || window.HomeSkillHub?.isOpen?.()) {
            root.classList.add('v2-tour-suspending');
        }

        const dom = createDom();
        state = {
            dom,
            snapshot,
            userKey,
            index: 0,
            navToken: 0,
            raf: 0,
            currentRect: null,
            onKeyDown: null,
            onResize: null
        };

        dom.skipBtn.addEventListener('click', () => stop({ complete: true }));
        dom.prevBtn.addEventListener('click', () => {
            if (state && state.index > 0) goToStep(state.index - 1);
        });
        dom.nextBtn.addEventListener('click', () => {
            if (!state) return;
            if (state.index >= STEP_DEFS.length - 1) stop({ complete: true });
            else goToStep(state.index + 1);
        });
        dom.dots.addEventListener('click', event => {
            const btn = event.target.closest('[data-tour-dot]');
            if (!btn || !state) return;
            const idx = Number(btn.dataset.tourDot);
            if (Number.isInteger(idx)) goToStep(idx);
        });
        dom.backdrop.addEventListener('click', () => {
            if (!state) return;
            dom.card.classList.remove('is-nudge');
            void dom.card.offsetWidth;
            dom.card.classList.add('is-nudge');
        });

        state.onKeyDown = event => {
            if (!state) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                stop({ complete: true });
            } else if (event.key === 'ArrowRight' || event.key === 'Enter') {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (state.index >= STEP_DEFS.length - 1) stop({ complete: true });
                else goToStep(state.index + 1);
            } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (state.index > 0) goToStep(state.index - 1);
            }
        };
        document.addEventListener('keydown', state.onKeyDown, true);

        let resizeTimer = 0;
        state.onResize = () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (!state) return;
                const def = STEP_DEFS[state.index];
                if (!def) return;
                const rect = def.measure();
                state.currentRect = rect;
                applyCutout(dom, rect);
                placeCard(rect, def.preferPlacement);
            }, 60);
        };
        window.addEventListener('resize', state.onResize);

        // 先测量首步锚点，让遮罩与聚光环从目标自身平滑浮现，杜绝生硬闪现
        await STEP_DEFS[0].prepare();
        if (!state) return;
        const firstRect = STEP_DEFS[0].measure();
        state.currentRect = firstRect;
        applyCutout(dom, firstRect);
        updateCardContent(0);
        placeCard(firstRect, STEP_DEFS[0].preferPlacement);

        requestAnimationFrame(() => {
            if (state) dom.rootEl.classList.add('is-open');
        });
    }

    function scheduleAutoStart() {
        let attempts = 0;
        const tryRun = () => {
            attempts += 1;
            if (state) return;
            if (canAutoStart()) {
                start({ force: false });
                return;
            }
            // 等待首次登录后写入 tools_user（最多约 6 秒）
            if (!currentUserKey() && attempts < 15 && !navigator.webdriver) {
                setTimeout(tryRun, 400);
            }
        };
        setTimeout(tryRun, 750);
    }

    window.addEventListener('dh:platform-user', () => {
        if (!state && canAutoStart()) setTimeout(() => start({ force: false }), 500);
    });
    window.addEventListener('tools:user-synced', () => {
        if (!state && canAutoStart()) setTimeout(() => start({ force: false }), 500);
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scheduleAutoStart, { once: true });
    } else {
        scheduleAutoStart();
    }

    window.HomeProductTour = {
        start: () => start({ force: false }),
        replay: () => start({ force: true }),
        stop: () => stop({ complete: true }),
        isRunning: () => Boolean(state),
        hasCompleted
    };
})();
