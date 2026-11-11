/**
 * Digital Human Web Runtime Shim
 * 1. Dynamically computes gateway subpath prefix (window.DH_BASE) for root and /digital-human/dh/{UUID}/ deployments.
 * 2. Rewrites /api/*, /assets/*, /js/*, /css/*, page routes for fetch / XHR / EventSource / DOM nodes.
 * 3. Injects SSO session marker so desktop login overlays never block gateway-authenticated users.
 * 4. Intercepts Phase-2 unmigrated tools with a clean Web-mode notification instead of dead links.
 * 5. Loads the persistent bottom-right 🐛 Debug Mode widget across every page.
 */
(function () {
    'use strict';
    if (window.__dhRuntimeInstalled) return;
    window.__dhRuntimeInstalled = true;

    const REWRITE_PREFIX_RE = /^\/(?:api|assets|css|js|downloads|uivf12|sla|report|expedite|monthly|ai-report|bigscreen|pages|favicon\.ico|healthz|ping|tools|custom-tools|praudit|frt|storage|db-explorer|netcare-explorer|topic-analysis|duty-roster|requirements|custom-report)(?:\/|\?|$)/i;
    const APP_ROUTE_TAIL_RE = /\/(?:monthly\/legacy|pages\/[a-zA-Z0-9_.-]+\.html|index\.html|uivf12|sla|report|expedite|monthly|ai-report|bigscreen|praudit|frt|storage|db-explorer|netcare-explorer|topic-analysis|duty-roster|requirements|custom-report|(?:tools|custom-tools)\/.*)$/;
    const PHASE2_RE = /^\/(?:praudit|frt|storage|db-explorer|netcare-explorer|topic-analysis|duty-roster|requirements|custom-report|tools\/|custom-tools\/)/i;

    function detectDhBase() {
        const p = window.location.pathname || '/';
        const m = p.match(/^(\/digital-human\/dh\/[0-9a-f-]+)(?=\/|$)/i);
        if (m) return m[1];
        try {
            const cs = document.currentScript && document.currentScript.src;
            if (cs) {
                const sp = new URL(cs, window.location.href).pathname;
                const marker = sp.indexOf('/js/shared/dh-runtime.js');
                if (marker > 0) {
                    const candidate = sp.slice(0, marker);
                    if (/\/monthly\/legacy\/?$/i.test(p) && /\/monthly$/i.test(candidate)) {
                        return candidate.replace(/\/monthly$/i, '');
                    }
                    return candidate.replace(/\/pages$/, '');
                }
            }
        } catch (_) { /* ignore */ }
        const stripped = p.replace(APP_ROUTE_TAIL_RE, '').replace(/\/+$/, '');
        return stripped === '/' ? '' : stripped;
    }

    const DH_BASE = detectDhBase();
    window.DH_BASE = DH_BASE;

    function dhStripBase(pathname) {
        const p = String(pathname || '/');
        if (DH_BASE && (p === DH_BASE || p.startsWith(DH_BASE + '/'))) {
            return p.slice(DH_BASE.length) || '/';
        }
        return p;
    }

    function dhResolveUrl(rawUrl) {
        if (typeof rawUrl !== 'string') return rawUrl;
        const val = rawUrl.trim();
        if (!val || val.startsWith('#') || val.startsWith('data:') || val.startsWith('blob:') || val.startsWith('javascript:')) {
            return rawUrl;
        }
        if (/^https?:\/\//i.test(val)) {
            if (!DH_BASE) return rawUrl;
            try {
                const u = new URL(val);
                if (u.origin === window.location.origin && REWRITE_PREFIX_RE.test(u.pathname) && !u.pathname.startsWith(DH_BASE + '/') && u.pathname !== DH_BASE) {
                    u.pathname = DH_BASE + u.pathname;
                    return u.toString();
                }
            } catch (_) { /* ignore */ }
            return rawUrl;
        }
        if (val.startsWith('//')) return rawUrl;
        if (val.startsWith('/')) {
            if (!DH_BASE) return rawUrl;
            if (val === DH_BASE || val.startsWith(DH_BASE + '/')) return rawUrl;
            if (val === '/') return DH_BASE + '/';
            if (REWRITE_PREFIX_RE.test(val)) return DH_BASE + val;
            return rawUrl;
        }
        return rawUrl;
    }

    window.dhStripBase = dhStripBase;
    window.dhResolveUrl = dhResolveUrl;

    // ── Digital Human SSO token marker so legacy frontend skips login redirects ──
    try {
        if (!localStorage.getItem('tools_token')) {
            localStorage.setItem('tools_token', 'digital-human-sso');
        }
        if (!localStorage.getItem('tools_tenant_id')) {
            localStorage.setItem('tools_tenant_id', 'default');
        }
    } catch (_) { /* ignore storage restrictions */ }

    // ── Intercept Fetch ──
    if (typeof window.fetch === 'function') {
        const origFetch = window.fetch.bind(window);
        window.fetch = function (input, init) {
            try {
                if (typeof input === 'string') {
                    return origFetch(dhResolveUrl(input), init);
                }
                if (input instanceof URL) {
                    return origFetch(dhResolveUrl(input.toString()), init);
                }
                if (input && typeof Request !== 'undefined' && input instanceof Request) {
                    const nextUrl = dhResolveUrl(input.url);
                    if (nextUrl !== input.url) {
                        return origFetch(new Request(nextUrl, input), init);
                    }
                }
            } catch (_) { /* fallback */ }
            return origFetch(input, init);
        };
    }

    // ── Intercept EventSource ──
    if (typeof window.EventSource === 'function') {
        const OrigEventSource = window.EventSource;
        window.EventSource = function (url, opts) {
            return new OrigEventSource(dhResolveUrl(String(url)), opts);
        };
        window.EventSource.prototype = OrigEventSource.prototype;
    }

    // ── Intercept XHR ──
    if (typeof XMLHttpRequest !== 'undefined') {
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            return origOpen.call(this, method, typeof url === 'string' ? dhResolveUrl(url) : url, ...rest);
        };
    }

    // ── Synchronously rewrite dynamic DOM element src/href under gateway subpath ──
    if (DH_BASE) {
        const wrapProp = (Proto, prop) => {
            if (!Proto) return;
            try {
                const desc = Object.getOwnPropertyDescriptor(Proto, prop);
                if (!desc || !desc.configurable || !desc.set || !desc.get) return;
                Object.defineProperty(Proto, prop, {
                    configurable: true,
                    enumerable: desc.enumerable,
                    get() { return desc.get.call(this); },
                    set(val) {
                        const resolved = typeof val === 'string' ? dhResolveUrl(val) : val;
                        return desc.set.call(this, resolved);
                    },
                });
            } catch (_) { /* ignore non-configurable */ }
        };
        wrapProp(window.HTMLScriptElement?.prototype, 'src');
        wrapProp(window.HTMLImageElement?.prototype, 'src');
        wrapProp(window.HTMLLinkElement?.prototype, 'href');
        wrapProp(window.HTMLAnchorElement?.prototype, 'href');
    }

    // ── Phase-2 Tool Interception & Notice ──
    function phase2Check(href) {
        if (!href) return null;
        try {
            const u = new URL(String(href), window.location.href);
            if (u.origin !== window.location.origin) return null;
            const path = dhStripBase(u.pathname);
            if (PHASE2_RE.test(path)) return path;
        } catch (_) { /* ignore */ }
        return null;
    }

    function showPhase2Notice(label) {
        const title = String(label || '该功能').replace(/\s+/g, ' ').trim().slice(0, 48);
        const msg = `「${title}」为 Web 版二期规划功能，当前暂未开放。一期已开放：首页 AI 对话、数据抓取、数据导入、报表看板、一键催办、AI 月报、大屏看板。`;
        if (typeof window.showToast === 'function') {
            window.showToast(msg, 'info');
            return;
        }
        let toast = document.getElementById('dhPhase2Toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'dhPhase2Toast';
            toast.style.cssText = [
                'position:fixed', 'top:20px', 'left:50%', 'transform:translateX(-50%)',
                'z-index:2147483640', 'max-width:min(540px,calc(100vw - 32px))',
                'padding:12px 18px', 'border-radius:12px',
                'background:rgba(15,23,42,0.95)', 'color:#f8fafc',
                'border:1px solid rgba(56,189,248,0.45)',
                'box-shadow:0 12px 34px rgba(0,0,0,0.45)',
                'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            ].join(';');
            document.body.appendChild(toast);
        }
        toast.textContent = `ℹ️ ${msg}`;
        toast.hidden = false;
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => { toast.hidden = true; }, 4200);
    }

    window.dhIsPhase2Href = phase2Check;
    window.dhNotifyPhase2 = showPhase2Notice;

    document.addEventListener('click', (event) => {
        const anchor = event.target?.closest?.('a[href]');
        if (!anchor) return;
        const rawHref = anchor.getAttribute('href') || '';
        const p2 = phase2Check(rawHref);
        if (p2) {
            event.preventDefault();
            event.stopPropagation();
            const label = anchor.dataset?.toolTitle || anchor.textContent || p2;
            showPhase2Notice(label);
            return;
        }
        if (DH_BASE && rawHref.startsWith('/') && !rawHref.startsWith('//') && !rawHref.startsWith(DH_BASE)) {
            anchor.setAttribute('href', dhResolveUrl(rawHref));
        }
    }, true);

    const origWinOpen = window.open;
    if (typeof origWinOpen === 'function') {
        window.open = function (url, target, features) {
            if (typeof url === 'string' && phase2Check(url)) {
                showPhase2Notice(url);
                return null;
            }
            return origWinOpen.call(this, typeof url === 'string' ? dhResolveUrl(url) : url, target, features);
        };
    }

    // ── Rewrite inserted img/script/a attributes when DH_BASE is active ──
    function fixAttributes(node) {
        if (!DH_BASE || !node || node.nodeType !== 1) return;
        for (const attr of ['src', 'href']) {
            if (node.hasAttribute?.(attr)) {
                const raw = node.getAttribute(attr);
                const next = dhResolveUrl(raw);
                if (next && next !== raw) node.setAttribute(attr, next);
            }
        }
        node.querySelectorAll?.('img[src^="/"], script[src^="/"], link[href^="/"], a[href^="/"]').forEach((el) => {
            const attr = el.hasAttribute('src') ? 'src' : 'href';
            const raw = el.getAttribute(attr);
            const next = dhResolveUrl(raw);
            if (next && next !== raw) el.setAttribute(attr, next);
        });
    }

    // ── Inject Persistent Debug Widget once DOM is ready ──
    function mountDebugWidgetAssets() {
        if (window !== window.top) return; // Keep widget strictly on top frame to avoid duplicate floating pills
        const cssHref = dhResolveUrl('/css/dh-debug-widget.css');
        const jsSrc = dhResolveUrl('/js/shared/dh-debug-widget.js');
        if (!document.querySelector('link[href*="dh-debug-widget.css"]')) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = cssHref;
            document.head.appendChild(link);
        }
        if (!document.querySelector('script[src*="dh-debug-widget.js"]')) {
            const s = document.createElement('script');
            s.src = jsSrc;
            s.defer = true;
            document.head.appendChild(s);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            if (DH_BASE) {
                fixAttributes(document.documentElement);
                new MutationObserver((records) => {
                    for (const rec of records) {
                        if (rec.type === 'childList') rec.addedNodes.forEach(fixAttributes);
                        else fixAttributes(rec.target);
                    }
                }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] });
            }
            mountDebugWidgetAssets();
        }, { once: true });
    } else {
        mountDebugWidgetAssets();
    }
})();
