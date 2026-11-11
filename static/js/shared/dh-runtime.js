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

    // ── Web 版裁剪层：隐藏桌面版专属入口（见 css/dh-web-trim.css）──
    try {
        document.documentElement.classList.add('dh-web');
        const trim = document.createElement('link');
        trim.rel = 'stylesheet';
        trim.href = DH_BASE + '/css/dh-web-trim.css';
        (document.head || document.documentElement).appendChild(trim);
    } catch (_) { /* ignore */ }

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
    // 1) 给站内绝对路径补上网关前缀；
    // 2) 对 /api 请求声明 x-dh-envelope，服务端按规范返回 HTTP 200 + {code,message,data,...}，
    //    这里再还原成桌面版前端原有的协议（成功=原始 JSON，失败=对应 HTTP 状态 + {error}）。
    //    这样网关不会把业务错误替换成错误页，页面代码也不用改。
    const API_PATH_RE = /^\/api\//;
    function isApiUrl(url) {
        try {
            const u = new URL(String(url), window.location.href);
            return u.origin === window.location.origin && API_PATH_RE.test(dhStripBase(u.pathname));
        } catch (_) { return false; }
    }
    async function unwrapEnvelope(resp) {
        if (resp.headers.get('x-dh-envelope') !== '1') return resp;
        let body;
        try { body = await resp.clone().json(); } catch (_) { return resp; }
        if (!body || typeof body !== 'object' || !('code' in body)) return resp;
        const failed = body.code !== 0;
        const status = failed ? (Number(resp.headers.get('x-dh-status')) || Number(body.code) || 500) : 200;
        const payload = failed
            ? (body.data && typeof body.data === 'object' ? body.data : { error: body.message || '请求失败' })
            : body.data;
        const headers = new Headers(resp.headers);
        headers.delete('content-length');
        const out = new Response(JSON.stringify(payload === undefined ? null : payload), {
            status: status >= 200 && status <= 599 ? status : 500,
            statusText: failed ? (body.message || '') .slice(0, 60).replace(/[^\x20-\x7e]/g, '') : 'OK',
            headers,
        });
        try { Object.defineProperty(out, 'url', { value: resp.url }); } catch (_) { /* ignore */ }
        return out;
    }
    if (typeof window.fetch === 'function') {
        const origFetch = window.fetch.bind(window);
        window.dhRawFetch = origFetch;
        window.fetch = function (input, init) {
            let target = input;
            let options = init;
            try {
                if (typeof input === 'string') target = dhResolveUrl(input);
                else if (input instanceof URL) target = dhResolveUrl(input.toString());
                else if (input && typeof Request !== 'undefined' && input instanceof Request) {
                    const nextUrl = dhResolveUrl(input.url);
                    if (nextUrl !== input.url) target = new Request(nextUrl, input);
                }
                const url = typeof target === 'string' ? target : target.url;
                if (isApiUrl(url)) {
                    const headers = new Headers((options && options.headers) || (typeof target !== 'string' && target.headers) || undefined);
                    headers.set('x-dh-envelope', '1');
                    options = Object.assign({}, options, { headers });
                    return origFetch(target, options).then(unwrapEnvelope);
                }
            } catch (_) { /* fallback */ }
            return origFetch(target, options);
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
        wrapProp(window.HTMLIFrameElement?.prototype, 'src');
        wrapProp(window.HTMLMediaElement?.prototype, 'src');
        wrapProp(window.HTMLSourceElement?.prototype, 'src');
        wrapProp(window.HTMLVideoElement?.prototype, 'poster');

        // 页面里大量用 innerHTML 拼出 <img src="/assets/...">：字符串进 DOM 之前就把站内绝对路径补上前缀，
        // 否则浏览器会先向网关根路径发一次请求（404，图标裂开）。
        const HTML_URL_ATTR_RE = /(\s(?:src|href|poster|data-src)\s*=\s*)(["'])(\/(?!\/)[^"'\s>]*)\2/gi;
        const CSS_URL_RE = /url\(\s*(["']?)(\/(?!\/)[^"')\s]+)\1\s*\)/gi;
        const rewriteHtml = (html) => {
            if (typeof html !== 'string' || html.indexOf('/') === -1) return html;
            let out = html;
            if (/(?:src|href|poster)\s*=/i.test(out)) out = out.replace(HTML_URL_ATTR_RE, (m, a, q, u) => `${a}${q}${dhResolveUrl(u)}${q}`);
            if (out.indexOf('url(') !== -1) out = out.replace(CSS_URL_RE, (m, q, u) => `url(${q}${dhResolveUrl(u)}${q})`);
            return out;
        };
        window.dhRewriteHtml = rewriteHtml;
        const wrapHtmlProp = (Proto, prop) => {
            try {
                const desc = Object.getOwnPropertyDescriptor(Proto, prop);
                if (!desc || !desc.configurable || !desc.set) return;
                Object.defineProperty(Proto, prop, {
                    configurable: true,
                    enumerable: desc.enumerable,
                    get() { return desc.get.call(this); },
                    set(val) { return desc.set.call(this, rewriteHtml(val)); },
                });
            } catch (_) { /* ignore */ }
        };
        wrapHtmlProp(Element.prototype, 'innerHTML');
        wrapHtmlProp(Element.prototype, 'outerHTML');
        try {
            const origInsert = Element.prototype.insertAdjacentHTML;
            Element.prototype.insertAdjacentHTML = function (position, html) {
                return origInsert.call(this, position, rewriteHtml(html));
            };
            const origSetAttr = Element.prototype.setAttribute;
            const URL_ATTRS = { src: 1, href: 1, poster: 1 };
            Element.prototype.setAttribute = function (name, value) {
                const key = typeof name === 'string' ? name.toLowerCase() : name;
                if (typeof value === 'string') {
                    if (URL_ATTRS[key] === 1) value = dhResolveUrl(value);
                    else if (key === 'style' && value.indexOf('url(') !== -1) value = rewriteHtml(value);
                }
                return origSetAttr.call(this, name, value);
            };
        } catch (_) { /* ignore */ }
    }

    // 页面没声明图标时浏览器会去网关根路径取 /favicon.ico（那是门户的地址，不是本应用的）
    if (DH_BASE && !document.querySelector('link[rel~="icon"]')) {
        try {
            const icon = document.createElement('link');
            icon.rel = 'icon';
            icon.href = DH_BASE + '/favicon.ico';
            (document.head || document.documentElement).appendChild(icon);
        } catch (_) { /* ignore */ }
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
    // 调试面板只对管理员出现；本地内存模式下所有页面顶部给出醒目提示，避免把演示数据当成已保存
    function showMemoryBanner() {
        if (window !== window.top || document.getElementById('dhMemoryBanner')) return;
        const bar = document.createElement('div');
        bar.id = 'dhMemoryBanner';
        bar.textContent = '本地内存模式：未连接数字人基座，所有数据在服务重启后丢失';
        bar.style.cssText = 'position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:2147483600;padding:6px 14px;border-radius:999px;background:#b45309;color:#fff;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.3);pointer-events:none';
        document.body.appendChild(bar);
    }
    function mountDebugWidgetAssets() {
        if (window !== window.top) return; // Keep widget strictly on top frame to avoid duplicate floating pills
        window.fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null)).then((me) => {
            window.DH_ME = me || null;
            if (me && me.memoryMode) showMemoryBanner();
            if (me && me.isAdmin) mountDebugWidgetNow();
        }).catch(() => {});
    }
    function mountDebugWidgetNow() {
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
