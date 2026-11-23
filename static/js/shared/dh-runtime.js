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

    const REWRITE_PREFIX_RE = /^\/(?:api|assets|css|js|downloads|builtin-tools|(?:uivf12|sla|report|expedite|monthly|monthly-legacy|ai-report|ai-bi|bigscreen|db-explorer|topic-analysis|duty-roster|frt|praudit|requirements|custom-tool|401)(?:\.html)?|pages|favicon\.ico|healthz|ping|tools|custom-tools|storage|netcare-explorer|requirements|custom-report)(?:\/|\?|$)/i;
    const APP_ROUTE_TAIL_RE = /\/(?:monthly\/legacy|pages\/[a-zA-Z0-9_.-]+\.html|(?:index|uivf12|sla|report|expedite|monthly|monthly-legacy|ai-report|bigscreen|db-explorer|topic-analysis|duty-roster|frt|praudit|requirements|ai-bi|custom-tool)\.html|uivf12|sla|report|expedite|monthly|ai-report|bigscreen|praudit|frt|storage|db-explorer|netcare-explorer|topic-analysis|duty-roster|requirements|ai-bi|custom-report|(?:tools|custom-tools)\/.*)$/;
    const PHASE2_RE = /^\/(?:storage|netcare-explorer|custom-report)/i;
    const STATIC_PAGE_MAP = {
        '/uivf12': '/uivf12.html',
        '/sla': '/sla.html',
        '/report': '/report.html',
        '/expedite': '/expedite.html',
        '/monthly': '/monthly.html',
        '/ai-report': '/monthly.html',
        '/monthly/legacy': '/monthly-legacy.html',
        '/bigscreen': '/bigscreen.html',
        '/db-explorer': '/db-explorer.html',
        '/topic-analysis': '/topic-analysis.html',
        '/duty-roster': '/duty-roster.html',
        '/frt': '/frt.html',
        '/praudit': '/praudit.html',
        '/requirements': '/requirements.html',
        '/ai-bi': '/ai-bi.html',
        '/pages/ai-bi.html': '/ai-bi.html',
        '/pages/uivf12.html': '/uivf12.html',
        '/pages/sla.html': '/sla.html',
        '/pages/report.html': '/report.html',
        '/pages/expedite.html': '/expedite.html',
        '/pages/ai-report.html': '/monthly.html',
        '/pages/monthly-designer.html': '/monthly.html',
        '/pages/monthly.html': '/monthly-legacy.html',
        '/pages/bigscreen.html': '/bigscreen.html',
        '/pages/db-explorer.html': '/db-explorer.html',
        '/pages/topic-analysis.html': '/topic-analysis.html',
        '/pages/duty-roster.html': '/duty-roster.html',
        '/pages/frt.html': '/frt.html',
        '/pages/praudit.html': '/praudit.html',
        '/pages/requirements.html': '/requirements.html',
    };

    // 底座 Nginx 只把 /api/* 转给 Node，无后缀页面和 /custom-tools/:slug/ 会回落到 static/index.html 造成套娃；
    // 统一映射为 static/ 根目录真实存在的 .html 文件，在底座 Nginx 和本地 Fastify 下都能直接打开。
    function dhMapStaticRoute(urlOrPath) {
        if (typeof urlOrPath !== 'string' || !urlOrPath.startsWith('/')) return urlOrPath;
        const hashIdx = urlOrPath.indexOf('#');
        const hash = hashIdx >= 0 ? urlOrPath.slice(hashIdx) : '';
        const noHash = hashIdx >= 0 ? urlOrPath.slice(0, hashIdx) : urlOrPath;
        const qIdx = noHash.indexOf('?');
        const cleanPath = qIdx >= 0 ? noHash.slice(0, qIdx) : noHash;
        const search = qIdx >= 0 ? noHash.slice(qIdx) : '';
        const normalized = cleanPath.length > 1 ? cleanPath.replace(/\/+$/, '') : cleanPath;
        const mapped = STATIC_PAGE_MAP[normalized.toLowerCase()];
        if (mapped) return mapped + search + hash;
        const customMatch = cleanPath.match(/^\/(?:custom-tools|tools)\/([^/]+)\/?(?:index\.html)?$/i);
        if (customMatch && customMatch[1].toLowerCase() !== 'f12-to-extension') {
            const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : '');
            params.set('slug', decodeURIComponent(customMatch[1]));
            return '/custom-tool.html?' + params.toString() + hash;
        }
        return urlOrPath;
    }

    function detectDhBase() {
        const p = window.location.pathname || '/';
        const m = p.match(/^(\/digital-human\/dh\/[0-9a-f-]+)(?=\/|$)/i);
        if (m) return m[1];
        try {
            const cs = document.currentScript && document.currentScript.src;
            if (cs) {
                const sp = new URL(cs, window.location.href).pathname;
                const marker = sp.indexOf('/js/shared/dh-runtime.js');
                if (marker >= 0) {
                    const candidate = sp.slice(0, marker);
                    if (/\/monthly\/legacy\/?$/i.test(p) && /\/monthly$/i.test(candidate)) {
                        return candidate.replace(/\/monthly$/i, '');
                    }
                    return candidate.replace(/\/pages$/, '');
                }
            }
        } catch (_) { /* ignore */ }
        // 内置工具页面在 builtin-tools/<标识>/ 下，基址是它上面两层
        const stripped = p.replace(/\/builtin-tools\/.*$/i, '').replace(APP_ROUTE_TAIL_RE, '').replace(/\/+$/, '');
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
    window.dhStripBase = dhStripBase;

    function dhResolveUrl(rawUrl) {
        if (typeof rawUrl !== 'string') return rawUrl;
        const val = rawUrl.trim();
        if (!val || val.startsWith('#') || val.startsWith('data:') || val.startsWith('blob:') || val.startsWith('javascript:')) {
            return rawUrl;
        }
        if (/^https?:\/\//i.test(val)) {
            try {
                const u = new URL(val);
                if (u.origin === window.location.origin) {
                    const stripped = dhStripBase(u.pathname) + u.search + u.hash;
                    const mapped = dhMapStaticRoute(stripped);
                    if (DH_BASE && REWRITE_PREFIX_RE.test(mapped)) {
                        return DH_BASE + mapped;
                    }
                    if (mapped !== stripped && !DH_BASE) return u.origin + mapped;
                }
            } catch (_) { /* ignore */ }
            return rawUrl;
        }
        if (val.startsWith('//')) return rawUrl;
        if (val.startsWith('/')) {
            const stripped = dhStripBase(val);
            const mapped = dhMapStaticRoute(stripped);
            if (!DH_BASE) return mapped;
            if (mapped === '/') return DH_BASE + '/';
            if (REWRITE_PREFIX_RE.test(mapped)) return DH_BASE + mapped;
            return val;
        }
        return rawUrl;
    }

    window.dhStripBase = dhStripBase;
    window.dhMapStaticRoute = dhMapStaticRoute;
    window.dhResolveUrl = dhResolveUrl;

    // ── Web 版裁剪层：隐藏桌面版专属入口（见 css/dh-web-trim.css）──
    try {
        document.documentElement.classList.add('dh-web');
        const trim = document.createElement('link');
        trim.rel = 'stylesheet';
        let trimQuery = '';
        try {
            const cs = document.currentScript && document.currentScript.src;
            if (cs) trimQuery = new URL(cs, window.location.href).search || '';
        } catch (_) { /* ignore */ }
        trim.href = DH_BASE + '/css/dh-web-trim.css' + trimQuery;
        (document.head || document.documentElement).appendChild(trim);
    } catch (_) { /* ignore */ }

    const IS_401_PAGE = /(?:^|\/)(?:401|unauthorized|login)(?:\.html)?$/i.test(window.location.pathname || '');

    // ── Digital Human SSO token marker so legacy frontend skips login redirects ──
    try {
        if (!IS_401_PAGE && !localStorage.getItem('tools_token')) {
            localStorage.setItem('tools_token', 'digital-human-sso');
        }
        if (!localStorage.getItem('tools_tenant_id')) {
            localStorage.setItem('tools_tenant_id', 'default');
        }
        // 推广视频文件不随 Web 版发布（体积大）：视频小窗按「永久关闭」处理，只保留推广链接横幅
        localStorage.setItem('tools.home.promoVideos.dismissed', 'v2');
    } catch (_) { /* ignore storage restrictions */ }

    let dhAuthBootMask = null;
    function installBootMask() {
        if (IS_401_PAGE || !DH_BASE || dhAuthBootMask || window !== window.top) return;
        try {
            const st = document.createElement('style');
            st.id = 'dhAuthBootMask';
            st.textContent = 'html,body{opacity:0 !important;pointer-events:none !important;}';
            (document.head || document.documentElement).appendChild(st);
            dhAuthBootMask = st;
            setTimeout(clearBootMask, 1500);
        } catch (_) { /* ignore */ }
    }
    function clearBootMask() {
        if (!dhAuthBootMask) return;
        try { dhAuthBootMask.remove(); } catch (_) { /* ignore */ }
        dhAuthBootMask = null;
    }
    installBootMask();

    // ── Digital Human 平台身份同步（规范 §12.5） ──
    // 平台使用 W3 SSO + Cookie/CSRF 双重认证，服务端拿不到浏览器 localStorage 里的 CSRF token；
    // 前端在加载时读缓存并异步调 /digital-human/api/dh/user/current，在 fetch('/api/*') 注入 x-dh-user / x-dh-displayname。
    function getCsrfToken() {
        for (const store of [localStorage, sessionStorage]) {
            try {
                for (const key of ['csrfToken', 'x-csrf-token', 'csrf-token', 'XSRF-TOKEN', 'dh_csrf_token']) {
                    const direct = store.getItem(key);
                    if (direct && String(direct).trim()) return String(direct).trim();
                }
                const gc = store.getItem('globalConfig');
                if (gc) {
                    const cfg = JSON.parse(gc);
                    const tok = cfg?.csrfToken || cfg?.configData?.csrfToken || cfg?.token;
                    if (tok && String(tok).trim()) return String(tok).trim();
                }
            } catch (_) { /* ignore */ }
        }
        try {
            const meta = document.querySelector('meta[name="csrf-token"],meta[name="x-csrf-token"],meta[name="x-gde-csrf-token"]');
            if (meta?.content?.trim()) return meta.content.trim();
        } catch (_) { /* ignore */ }
        try {
            for (const part of String(document.cookie || '').split(';')) {
                const idx = part.indexOf('=');
                if (idx <= 0) continue;
                const k = part.slice(0, idx).trim().toLowerCase();
                if (['xsrf-token', 'csrf-token', 'csrftoken', 'x-csrf-token'].includes(k)) {
                    const v = decodeURIComponent(part.slice(idx + 1).trim());
                    if (v) return v;
                }
            }
        } catch (_) { /* ignore */ }
        return '';
    }

    let dhPlatformUser = null;
    let dhPlatformUserSettled = false;
    let dhRedirecting401 = false;
    function clearClientAuthState() {
        dhPlatformUser = null;
        try {
            localStorage.removeItem('dh_platform_user');
            localStorage.removeItem('tools_user');
            localStorage.removeItem('tools_display_name');
            localStorage.removeItem('tools_token');
            localStorage.removeItem('tools_role');
            localStorage.removeItem('tools_super');
        } catch (_) { /* ignore */ }
    }
    function rememberLoginUrl(resp) {
        try {
            return resp.clone().json().then((body) => {
                const u = body && typeof body.loginUrl === 'string' ? body.loginUrl : '';
                if (/^https?:\/\//i.test(u)) sessionStorage.setItem('dh_sso_login_url', u);
            }).catch(() => {});
        } catch (_) { return Promise.resolve(); }
    }
    function redirectTo401() {
        if (IS_401_PAGE || dhRedirecting401) return;
        dhRedirecting401 = true;
        clearClientAuthState();
        const url401 = dhResolveUrl('/401.html');
        try {
            (window.top || window).location.replace(url401);
        } catch (_) {
            window.location.replace(url401);
        }
    }
    try {
        const cachedUser = localStorage.getItem('dh_platform_user');
        if (cachedUser) {
            const parsed = JSON.parse(cachedUser);
            if (parsed && parsed.userName) dhPlatformUser = parsed;
        }
    } catch (_) { /* ignore */ }

    const origFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
    let dhPlatformUserPromise = null;
    if (origFetch && /\/dh\/[^/]+$/i.test(DH_BASE) && !IS_401_PAGE) {
        const currentUserUrl = DH_BASE.replace(/\/dh\/[^/]+$/, '/api/dh/user/current');
        const csrf = getCsrfToken();
        dhPlatformUserPromise = origFetch(currentUserUrl, {
            credentials: 'include',
            headers: csrf ? { 'x-csrf-token': csrf } : {},
        })
            .then(async (r) => {
                if (r.status === 401 || r.status === 403) {
                    clearClientAuthState();
                    return null;
                }
                const data = r.ok ? await r.json().catch(() => null) : null;
                if (data && data.code === 0 && data.data && data.data.uid) {
                    const d = data.data;
                    const next = {
                        userName: String(d.uid).trim(),
                        displayName: String(d.cn || d.name || d.uid).trim(),
                        empNo: String(d.uid).trim(),
                    };
                    const changed = !dhPlatformUser || dhPlatformUser.userName !== next.userName || dhPlatformUser.displayName !== next.displayName;
                    dhPlatformUser = next;
                    try {
                        localStorage.setItem('dh_platform_user', JSON.stringify(next));
                        localStorage.setItem('tools_user', next.userName);
                        localStorage.setItem('tools_display_name', next.displayName);
                        if (!localStorage.getItem('tools_token')) localStorage.setItem('tools_token', 'digital-human-sso');
                    } catch (_) { /* ignore */ }
                    if (changed) {
                        try { window.dispatchEvent(new CustomEvent('dh:platform-user', { detail: next })); } catch (_) { /* ignore */ }
                    }
                    return dhPlatformUser;
                }
                if (r.ok) {
                    clearClientAuthState();
                }
                return null;
            })
            .catch(() => dhPlatformUser)
            .finally(() => {
                dhPlatformUserSettled = true;
            });
    } else {
        dhPlatformUserSettled = true;
    }

    // ── Intercept Fetch ──
    // 1) 给站内绝对路径补上网关前缀；
    // 2) 注入 x-dh-user / x-dh-displayname 平台身份头；
    // 3) 对 /api 请求声明 x-dh-envelope，服务端按规范返回 HTTP 200 + {code,message,data,...}，
    //    这里再还原成桌面版前端原有的协议（成功=原始 JSON，失败=对应 HTTP 状态 + {error}）。
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
    if (origFetch) {
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
                    const sendApiFetch = () => {
                        const headers = new Headers((options && options.headers) || (typeof target !== 'string' && target.headers) || undefined);
                        headers.set('x-dh-envelope', '1');
                        // 客户端类型（与主线版 shared/api.js 同名同值），审计日志按它区分 Web / 移动 Web
                        if (!headers.has('X-Client-Platform')) headers.set('X-Client-Platform', /iPhone|iPad|iPod|Android/i.test(typeof navigator === 'undefined' ? '' : navigator.userAgent) ? 'mobile_web' : 'web');
                        if (dhPlatformUser?.userName) {
                            if (!headers.has('x-dh-user')) headers.set('x-dh-user', encodeURIComponent(dhPlatformUser.userName));
                            if (!headers.has('x-dh-displayname') && dhPlatformUser.displayName) {
                                headers.set('x-dh-displayname', encodeURIComponent(dhPlatformUser.displayName));
                            }
                        }
                        const opts = Object.assign({}, options, { headers });
                        return origFetch(target, opts).then(unwrapEnvelope).then((resp) => {
                            if (resp && resp.status === 401 && !IS_401_PAGE) {
                                // 基座 SSO 失效时网关/加载器会在 401 里带 loginUrl：记下来给 401 页直接跳 SSO 登录
                                const captured = rememberLoginUrl(resp);
                                if (!/\/api\/auth\/(?:me|logout)\b/.test(url)) captured.then(redirectTo401, redirectTo401);
                            }
                            return resp;
                        });
                    };
                    if (!dhPlatformUserSettled && dhPlatformUserPromise) {
                        return dhPlatformUserPromise.then(sendApiFetch, sendApiFetch);
                    }
                    return sendApiFetch();
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

    // ── 基座版禁用本地 UI.Vision 插件一键批脚本与插件下载（无论是否超级管理员），浮窗脚本/F12 手动复制保留可用 ──
    const OPENX_DESKTOP_URL = 'https://openx.huawei.com/Egypt_CNBG_CS_Tools_Platform/overview';
    const DH_UIV_DISABLED_SELECTOR = [
        '#btnDownloadUivExtension',
        '.btn-batch-uiv-run',
        '.btn-batch-speed',
        '.btn-batch-filter',
        '[data-dh-uiv-disabled]',
    ].join(', ');

    function isEnLang() {
        const lang = window.ToolsI18n?.getLanguage?.() || localStorage.getItem('tools_lang') || localStorage.getItem('tools_language') || '';
        return /^en/i.test(lang);
    }

    function getOpenxPlainHint() {
        return isEnLang()
            ? `This feature invokes the local UI.Vision plugin and is only available in the mainline desktop edition. Please download the OpenX desktop edition: ${OPENX_DESKTOP_URL}`
            : `该功能需调用本地 UI.Vision 插件运行脚本，仅在主线版提供（基座版已禁用）。请前往 OpenX 下载桌面版：${OPENX_DESKTOP_URL}`;
    }

    function getOpenxHtmlHint() {
        return isEnLang()
            ? `🔒 This feature invokes the local UI.Vision plugin and is only built for the mainline edition.<br>Please download the <a href="${OPENX_DESKTOP_URL}" target="_blank" rel="noopener noreferrer" style="color:#38bdf8;font-weight:700;text-decoration:underline;">OpenX</a> desktop edition.`
            : `🔒 该功能需调用本地 UI.Vision 插件运行脚本，是在主线版做的，暂不支持基座版。<br>请前往下载 <a href="${OPENX_DESKTOP_URL}" target="_blank" rel="noopener noreferrer" style="color:#38bdf8;font-weight:700;text-decoration:underline;">OpenX</a> 桌面版使用。`;
    }

    let dhOpenxTip = null;
    let dhOpenxHideTimer = null;
    let dhOpenxAnchor = null;

    function ensureOpenxTooltip() {
        if (dhOpenxTip && document.body?.contains(dhOpenxTip)) return dhOpenxTip;
        if (!document.body) return null;
        const tip = document.createElement('div');
        tip.id = 'dhOpenxDesktopTooltip';
        tip.setAttribute('role', 'tooltip');
        tip.hidden = true;
        tip.style.cssText = [
            'position:fixed',
            'z-index:2147483645',
            'max-width:340px',
            'padding:10px 14px',
            'border-radius:10px',
            'background:rgba(15,23,42,0.96)',
            'color:#f8fafc',
            'border:1px solid rgba(56,189,248,0.45)',
            'box-shadow:0 10px 28px rgba(0,0,0,0.45)',
            'font:12.5px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif',
            'pointer-events:auto',
        ].join(';');
        tip.addEventListener('mouseenter', () => clearTimeout(dhOpenxHideTimer));
        tip.addEventListener('mouseleave', () => scheduleHideOpenxTooltip(180));
        document.body.appendChild(tip);
        dhOpenxTip = tip;
        return tip;
    }

    function positionOpenxTooltip(anchor) {
        const tip = ensureOpenxTooltip();
        if (!tip || !anchor || typeof anchor.getBoundingClientRect !== 'function') return;
        tip.innerHTML = getOpenxHtmlHint();
        tip.hidden = false;
        const rect = anchor.getBoundingClientRect();
        const pad = 10;
        const gap = 8;
        const tw = tip.offsetWidth || 300;
        const th = tip.offsetHeight || 64;
        const left = Math.max(pad, Math.min(rect.left + (rect.width - tw) / 2, window.innerWidth - tw - pad));
        const top = rect.top >= th + gap + pad
            ? rect.top - th - gap
            : Math.min(window.innerHeight - th - pad, rect.bottom + gap);
        tip.style.left = `${Math.round(left)}px`;
        tip.style.top = `${Math.round(Math.max(pad, top))}px`;
    }

    function showOpenxTooltip(anchor) {
        clearTimeout(dhOpenxHideTimer);
        dhOpenxAnchor = anchor || dhOpenxAnchor;
        if (dhOpenxAnchor) positionOpenxTooltip(dhOpenxAnchor);
    }

    function scheduleHideOpenxTooltip(delayMs = 220) {
        clearTimeout(dhOpenxHideTimer);
        dhOpenxHideTimer = setTimeout(() => {
            if (dhOpenxTip) dhOpenxTip.hidden = true;
            dhOpenxAnchor = null;
        }, delayMs);
    }

    function notifyOpenxDesktopRequired(anchor) {
        if (anchor && typeof anchor.getBoundingClientRect === 'function') {
            showOpenxTooltip(anchor);
            clearTimeout(dhOpenxHideTimer);
            dhOpenxHideTimer = setTimeout(() => {
                if (dhOpenxTip) dhOpenxTip.hidden = true;
                dhOpenxAnchor = null;
            }, 4200);
            return;
        }
        if (typeof window.showToast === 'function') {
            window.showToast(getOpenxPlainHint(), 'warning');
        }
    }

    function applyUivDisabledState(root = document) {
        if (!root || typeof root.querySelectorAll !== 'function') return;
        const hint = getOpenxPlainHint();
        const nodes = [];
        if (root.nodeType === 1 && root.matches?.(DH_UIV_DISABLED_SELECTOR)) nodes.push(root);
        root.querySelectorAll(DH_UIV_DISABLED_SELECTOR).forEach((el) => nodes.push(el));
        for (const el of nodes) {
            el.classList.add('is-dh-uiv-disabled');
            el.setAttribute('aria-disabled', 'true');
            el.setAttribute('title', hint);
            if (el.hasAttribute('onclick')) {
                el.dataset.dhBlockedOnclick = el.getAttribute('onclick') || '';
                el.removeAttribute('onclick');
            }
        }
    }

    window.OPENX_DESKTOP_URL = OPENX_DESKTOP_URL;
    window.dhNotifyOpenxDesktop = notifyOpenxDesktopRequired;
    window.dhApplyUivDisabledState = applyUivDisabledState;

    document.addEventListener('mouseover', (event) => {
        const target = event.target?.closest?.(DH_UIV_DISABLED_SELECTOR);
        if (!target) return;
        applyUivDisabledState(target);
        showOpenxTooltip(target);
    }, true);

    document.addEventListener('mouseout', (event) => {
        const target = event.target?.closest?.(DH_UIV_DISABLED_SELECTOR);
        if (!target) return;
        const related = event.relatedTarget;
        if (related && (target.contains(related) || dhOpenxTip?.contains(related))) return;
        scheduleHideOpenxTooltip(220);
    }, true);

    document.addEventListener('focusin', (event) => {
        const target = event.target?.closest?.(DH_UIV_DISABLED_SELECTOR);
        if (target) showOpenxTooltip(target);
    }, true);

    document.addEventListener('focusout', (event) => {
        const target = event.target?.closest?.(DH_UIV_DISABLED_SELECTOR);
        if (target) scheduleHideOpenxTooltip(180);
    }, true);

    const origAnchorClick = (typeof HTMLAnchorElement !== 'undefined' && HTMLAnchorElement.prototype && typeof HTMLAnchorElement.prototype.click === 'function')
        ? HTMLAnchorElement.prototype.click
        : null;

    // ── 全局鉴权流式下载 & 右上角优雅进度横幅 ──
    // 基座网关下原生 <a download> / window.open 无法走 dh-runtime 的 fetch 鉴权头注入，
    // 这里统一拦截站内 /api/ 下载与导出请求，走带鉴权头的 ReadableStream 拉取并实时显示右上角进度条，完成后触发浏览器保存。
    const DH_DL_TRAY_ID = 'dhDownloadTray';
    const DH_DL_STYLE_ID = 'dhDownloadTrayStyles';
    const DH_DL_PATH_RE = /(?:[?&]download=(?:1|true)\b|\/export(?:\?|$)|\/download(?:\/[^/?#]+)?(?:\?|$)|\/update-file(?:\?|$))/i;
    let dhDlSeq = 0;

    function dlEsc(v) {
        return String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    function dlFormatBytes(bytes) {
        const n = Number(bytes) || 0;
        if (n <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
        return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
    }

    function inferExtFromContentType(ct) {
        const t = String(ct || '').toLowerCase();
        if (t.includes('text/csv')) return '.csv';
        if (t.includes('spreadsheetml') || t.includes('ms-excel')) return '.xlsx';
        if (t.includes('application/json')) return '.json';
        if (t.includes('application/zip')) return '.zip';
        if (t.includes('application/pdf')) return '.pdf';
        if (t.includes('text/html')) return '.html';
        if (t.includes('text/plain')) return '.txt';
        if (t.includes('image/png')) return '.png';
        if (t.includes('image/jpeg')) return '.jpg';
        return '';
    }

    function parseDownloadFilename(disposition, url, explicitName, contentType) {
        const raw = String(disposition || '');
        const star = raw.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;\r\n]+)/i);
        if (star && star[1]) {
            try {
                const decoded = decodeURIComponent(star[1].trim().replace(/^["']|["']$/g, ''));
                if (decoded) return decoded;
            } catch (_) { /* ignore */ }
        }
        const plain = raw.match(/filename\s*=\s*"([^"\r\n]+)"/i) || raw.match(/filename\s*=\s*([^;\r\n]+)/i);
        if (plain && plain[1]) {
            const cleaned = plain[1].trim().replace(/^["']|["']$/g, '');
            if (cleaned) return cleaned;
        }
        if (explicitName && String(explicitName).trim()) return String(explicitName).trim();
        try {
            const u = new URL(String(url || ''), window.location.href);
            const qName = u.searchParams.get('filename') || u.searchParams.get('name');
            if (qName && qName.trim()) return qName.trim();
            const base = decodeURIComponent((u.pathname.split('/').pop() || '').trim());
            const ext = inferExtFromContentType(contentType);
            if (base && !/^(?:export|download|raw|update-file)$/i.test(base)) {
                return base.includes('.') || !ext ? base : `${base}${ext}`;
            }
            if (ext) return `export${ext}`;
        } catch (_) { /* ignore */ }
        return 'download';
    }

    function ensureDownloadTrayStyles() {
        if (typeof document.getElementById !== 'function' || document.getElementById(DH_DL_STYLE_ID)) return;
        const head = document.head || document.documentElement;
        if (!head || typeof document.createElement !== 'function') return;
        const style = document.createElement('style');
        style.id = DH_DL_STYLE_ID;
        style.textContent = `
#${DH_DL_TRAY_ID}{position:fixed;top:18px;right:18px;z-index:2147483644;width:min(372px,calc(100vw - 24px));display:flex;flex-direction:column;gap:10px;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.dh-dl-card{pointer-events:auto;display:flex;flex-direction:column;gap:8px;padding:13px 15px;border-radius:14px;background:rgba(255,255,255,.96);border:1px solid rgba(226,232,240,.95);color:#1f2328;box-shadow:0 16px 40px rgba(15,23,42,.13),0 3px 10px rgba(15,23,42,.05);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);animation:dhDlIn .28s cubic-bezier(.16,1,.3,1) both;transition:opacity .26s ease,transform .26s ease}
.dh-dl-card.is-leaving{opacity:0;transform:translateX(28px) scale(.97);pointer-events:none}
@keyframes dhDlIn{from{opacity:0;transform:translateX(32px) scale(.96)}to{opacity:1;transform:none}}
.dh-dl-head{display:flex;align-items:center;gap:10px;min-width:0}
.dh-dl-badge{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;flex:none;background:#f1f5f9;border:1px solid #e2e8f0;color:#0f766e;transition:background .2s,color .2s,border-color .2s}
.dh-dl-badge svg{width:16px;height:16px;display:block}
.dh-dl-card.is-loading .dh-dl-badge svg{animation:dhDlPulse 1.4s ease-in-out infinite}
@keyframes dhDlPulse{0%,100%{transform:translateY(-1px);opacity:.78}50%{transform:translateY(2px);opacity:1}}
.dh-dl-card.is-done .dh-dl-badge{background:#e6fcf5;border-color:#a7f3d0;color:#10a37f}
.dh-dl-card.is-error .dh-dl-badge{background:#fef2f2;border-color:#fecaca;color:#ef4444}
.dh-dl-card.is-cancelled .dh-dl-badge{background:#f8fafc;border-color:#e2e8f0;color:#94a3b8}
.dh-dl-title-wrap{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dh-dl-name{font-size:13px;font-weight:650;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:inherit}
.dh-dl-sub{font-size:11.5px;line-height:1.35;color:#64748b;display:flex;align-items:center;justify-content:space-between;gap:8px;font-variant-numeric:tabular-nums}
.dh-dl-err-msg{color:#ef4444;word-break:break-word;white-space:normal}
.dh-dl-card.is-done .dh-dl-state{color:#10a37f;font-weight:600}
.dh-dl-card.is-error .dh-dl-state{color:#ef4444;font-weight:600}
.dh-dl-actions{display:flex;align-items:center;gap:4px;flex:none}
.dh-dl-btn{border:1px solid #e2e8f0;background:#f8fafc;color:#334155;border-radius:7px;padding:4px 9px;font-size:11.5px;font-weight:600;cursor:pointer;line-height:1.2;transition:background .15s,border-color .15s}
.dh-dl-btn:hover{background:#e2e8f0;color:#0f172a}
.dh-dl-x{width:24px;height:24px;border-radius:7px;border:0;background:transparent;color:#64748b;display:grid;place-items:center;cursor:pointer;font-size:14px;line-height:1;padding:0;transition:background .15s,color .15s}
.dh-dl-x:hover{background:#f1f5f9;color:#0f172a}
.dh-dl-track{position:relative;width:100%;height:5px;border-radius:999px;background:#e2e8f0;overflow:hidden}
.dh-dl-bar{height:100%;width:0%;border-radius:999px;background:linear-gradient(90deg,#10a37f,#06b6d4);transition:width .18s ease-out}
.dh-dl-bar.is-indeterminate{width:42%!important;animation:dhDlIndet 1.25s ease-in-out infinite}
@keyframes dhDlIndet{0%{transform:translateX(-110%)}100%{transform:translateX(260%)}}
.dh-dl-card.is-done .dh-dl-bar{width:100%!important;background:#10a37f;animation:none}
.dh-dl-card.is-error .dh-dl-bar{width:100%!important;background:#ef4444;animation:none}
.dh-dl-card.is-cancelled .dh-dl-bar{background:#94a3b8;animation:none}
:is(html[data-theme="dark"],html[data-platform-theme="dark"]) .dh-dl-card{background:rgba(20,26,38,.95);border-color:rgba(148,163,184,.24);color:#f1f5f9;box-shadow:0 16px 40px rgba(0,0,0,.45)}
:is(html[data-theme="dark"],html[data-platform-theme="dark"]) .dh-dl-badge{background:rgba(255,255,255,.06);border-color:rgba(148,163,184,.22);color:#5eead4}
:is(html[data-theme="dark"],html[data-platform-theme="dark"]) .dh-dl-card.is-done .dh-dl-badge{background:rgba(16,163,127,.18);border-color:rgba(16,163,127,.38);color:#34d399}
:is(html[data-theme="dark"],html[data-platform-theme="dark"]) .dh-dl-card.is-error .dh-dl-badge{background:rgba(239,68,68,.18);border-color:rgba(239,68,68,.38);color:#f87171}
:is(html[data-theme="dark"],html[data-platform-theme="dark"]) .dh-dl-sub{color:#94a3b8}
:is(html[data-theme="dark"],html[data-platform-theme="dark"]) .dh-dl-track{background:rgba(255,255,255,.1)}
:is(html[data-theme="dark"],html[data-platform-theme="dark"]) .dh-dl-btn{background:rgba(255,255,255,.08);border-color:rgba(148,163,184,.24);color:#e2e8f0}
:is(html[data-theme="dark"],html[data-platform-theme="dark"]) .dh-dl-btn:hover{background:rgba(255,255,255,.16);color:#fff}
:is(html[data-theme="dark"],html[data-platform-theme="dark"]) .dh-dl-x{color:#94a3b8}
:is(html[data-theme="dark"],html[data-platform-theme="dark"]) .dh-dl-x:hover{background:rgba(255,255,255,.1);color:#f8fafc}
`;
        head.appendChild(style);
    }

    function ensureDownloadTray() {
        ensureDownloadTrayStyles();
        if (typeof document.getElementById !== 'function') return null;
        let tray = document.getElementById(DH_DL_TRAY_ID);
        if (tray) return tray;
        const host = document.body || document.documentElement;
        if (!host || typeof document.createElement !== 'function') return null;
        tray = document.createElement('div');
        tray.id = DH_DL_TRAY_ID;
        tray.setAttribute('aria-live', 'polite');
        host.appendChild(tray);
        return tray;
    }

    const DL_ICONS = {
        download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
        check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
        error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5m0 3.5h.01"/></svg>',
    };

    function createDownloadCard(initialTitle, { onCancel, onRetry } = {}) {
        const tray = ensureDownloadTray();
        if (!tray) return null;
        while (tray.children.length >= 4) {
            const oldest = tray.firstElementChild;
            if (!oldest) break;
            oldest._cleanup?.();
            oldest.remove();
        }
        const card = document.createElement('div');
        card.className = 'dh-dl-card is-loading';
        card.innerHTML = `
            <div class="dh-dl-head">
                <div class="dh-dl-badge">${DL_ICONS.download}</div>
                <div class="dh-dl-title-wrap">
                    <div class="dh-dl-name" title="${dlEsc(initialTitle)}">${dlEsc(initialTitle)}</div>
                    <div class="dh-dl-sub"><span class="dh-dl-stats"></span><span class="dh-dl-state"></span></div>
                </div>
                <div class="dh-dl-actions">
                    <button type="button" class="dh-dl-btn" data-dh-dl-act="save-again" hidden>${dlEsc(isEnLang() ? 'Save again' : '再次保存')}</button>
                    <button type="button" class="dh-dl-btn" data-dh-dl-act="retry" hidden>${dlEsc(isEnLang() ? 'Retry' : '重试')}</button>
                    <button type="button" class="dh-dl-x" data-dh-dl-act="close" title="${dlEsc(isEnLang() ? 'Close' : '关闭')}" aria-label="${dlEsc(isEnLang() ? 'Close' : '关闭')}">×</button>
                </div>
            </div>
            <div class="dh-dl-track"><div class="dh-dl-bar is-indeterminate"></div></div>
        `;
        tray.appendChild(card);

        const nameEl = card.querySelector('.dh-dl-name');
        const badgeEl = card.querySelector('.dh-dl-badge');
        const statsEl = card.querySelector('.dh-dl-stats');
        const stateEl = card.querySelector('.dh-dl-state');
        const barEl = card.querySelector('.dh-dl-bar');
        const saveAgainBtn = card.querySelector('[data-dh-dl-act="save-again"]');
        const retryBtn = card.querySelector('[data-dh-dl-act="retry"]');
        let autoTimer = null;
        let hovered = false;
        let blobUrlToRevoke = '';
        let saveAgainHandler = null;

        const cleanup = () => {
            clearTimeout(autoTimer);
            if (blobUrlToRevoke) {
                try { URL.revokeObjectURL(blobUrlToRevoke); } catch (_) {}
                blobUrlToRevoke = '';
            }
        };
        card._cleanup = cleanup;

        const dismiss = () => {
            clearTimeout(autoTimer);
            card.classList.add('is-leaving');
            setTimeout(() => { cleanup(); card.remove(); }, 280);
        };

        const scheduleDismiss = (ms = 4500) => {
            clearTimeout(autoTimer);
            autoTimer = setTimeout(() => {
                if (!hovered) dismiss();
                else scheduleDismiss(1800);
            }, ms);
        };

        card.addEventListener('mouseenter', () => { hovered = true; });
        card.addEventListener('mouseleave', () => { hovered = false; });
        card.addEventListener('click', (ev) => {
            const act = ev.target?.closest?.('[data-dh-dl-act]')?.dataset?.dhDlAct;
            if (!act) return;
            if (act === 'close') {
                if (card.classList.contains('is-loading') && typeof onCancel === 'function') onCancel();
                dismiss();
            } else if (act === 'retry' && typeof onRetry === 'function') {
                dismiss();
                onRetry();
            } else if (act === 'save-again' && typeof saveAgainHandler === 'function') {
                saveAgainHandler();
            }
        });

        return {
            setTitle(text) {
                if (!nameEl) return;
                nameEl.textContent = text;
                nameEl.title = text;
            },
            setProgress(received, total) {
                if (total > 0) {
                    const pct = Math.min(100, Math.round((received / total) * 100));
                    barEl.classList.remove('is-indeterminate');
                    barEl.style.width = `${pct}%`;
                    statsEl.textContent = `${pct}% · ${dlFormatBytes(received)} / ${dlFormatBytes(total)}`;
                } else {
                    barEl.classList.add('is-indeterminate');
                    statsEl.textContent = received > 0 ? dlFormatBytes(received) : (isEnLang() ? 'Authorizing…' : '正在鉴权请求…');
                }
                stateEl.textContent = isEnLang() ? 'Downloading…' : '正在下载…';
            },
            setCompleted(filename, size, blobUrl, onSaveAgain) {
                card.classList.remove('is-loading', 'is-error', 'is-cancelled');
                card.classList.add('is-done');
                badgeEl.innerHTML = DL_ICONS.check;
                this.setTitle(filename);
                barEl.classList.remove('is-indeterminate');
                barEl.style.width = '100%';
                statsEl.textContent = `${dlFormatBytes(size)} · ${isEnLang() ? 'Saved' : '已保存'}`;
                stateEl.textContent = isEnLang() ? 'Completed' : '已完成';
                blobUrlToRevoke = blobUrl || '';
                saveAgainHandler = onSaveAgain || null;
                if (saveAgainBtn && saveAgainHandler) saveAgainBtn.hidden = false;
                setTimeout(() => {
                    if (blobUrlToRevoke) {
                        try { URL.revokeObjectURL(blobUrlToRevoke); } catch (_) {}
                        blobUrlToRevoke = '';
                    }
                    if (saveAgainBtn) saveAgainBtn.hidden = true;
                }, 60000);
                scheduleDismiss(4500);
            },
            setError(message) {
                card.classList.remove('is-loading', 'is-done', 'is-cancelled');
                card.classList.add('is-error');
                badgeEl.innerHTML = DL_ICONS.error;
                barEl.classList.remove('is-indeterminate');
                statsEl.classList.add('dh-dl-err-msg');
                statsEl.textContent = message || (isEnLang() ? 'Download failed' : '下载失败');
                stateEl.textContent = isEnLang() ? 'Failed' : '失败';
                if (retryBtn && typeof onRetry === 'function') retryBtn.hidden = false;
            },
            setCancelled() {
                card.classList.remove('is-loading', 'is-done', 'is-error');
                card.classList.add('is-cancelled');
                barEl.classList.remove('is-indeterminate');
                statsEl.textContent = isEnLang() ? 'Download cancelled' : '已取消下载';
                stateEl.textContent = isEnLang() ? 'Cancelled' : '已取消';
                scheduleDismiss(1800);
            },
        };
    }

    function triggerBlobSave(blobUrl, filename) {
        if (typeof document.createElement !== 'function') return;
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = filename || 'download';
        if (link.style) link.style.display = 'none';
        if (link.dataset) link.dataset.dhBypassDownload = '1';
        const host = document.body || document.documentElement;
        host?.appendChild?.(link);
        if (origAnchorClick) origAnchorClick.call(link);
        else link.click?.();
        setTimeout(() => { try { link.remove?.(); } catch (_) {} }, 120);
    }

    async function dhDownload(url, options = {}) {
        const rawUrl = String(url || '').trim();
        if (!rawUrl) return null;
        let absUrl = dhResolveUrl(rawUrl);
        try { absUrl = new URL(absUrl, window.location.href).toString(); } catch (_) { /* keep */ }

        if (!options._localOnly) {
            try {
                let hostWin = null;
                let cur = window;
                while (cur.parent && cur.parent !== cur) {
                    if (typeof cur.parent.dhDownload === 'function') hostWin = cur.parent;
                    cur = cur.parent;
                }
                if (hostWin && hostWin !== window) {
                    return hostWin.dhDownload(absUrl, Object.assign({}, options, { _localOnly: true }));
                }
            } catch (_) { /* cross-origin portal parent; run locally */ }
        }

        const seq = ++dhDlSeq;
        const initialTitle = options.filename || options.label || parseDownloadFilename('', absUrl, '', '');
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        if (options.signal && controller && typeof options.signal.addEventListener === 'function') {
            if (options.signal.aborted) controller.abort();
            else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }

        let cancelled = false;
        const card = createDownloadCard(initialTitle, {
            onCancel: () => {
                cancelled = true;
                try { controller?.abort(); } catch (_) {}
            },
            onRetry: () => { dhDownload(absUrl, Object.assign({}, options, { _localOnly: true })); },
        });
        card?.setProgress(0, 0);

        try {
            const headers = new Headers(options.headers || undefined);
            try {
                const token = localStorage.getItem('tools_token') || sessionStorage.getItem('tools_token');
                if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
            } catch (_) { /* ignore */ }

            const fetchFn = typeof window.fetch === 'function' ? window.fetch : origFetch;
            if (!fetchFn) throw new Error('Fetch unavailable');

            const resp = await fetchFn(absUrl, {
                method: options.method || 'GET',
                headers,
                body: options.body,
                credentials: 'same-origin',
                cache: 'no-store',
                ...(controller ? { signal: controller.signal } : {}),
            });

            if (!resp.ok) {
                let errMsg = `HTTP ${resp.status}`;
                try {
                    const text = await resp.text();
                    const parsed = JSON.parse(text);
                    errMsg = parsed?.error || parsed?.message || errMsg;
                } catch (_) { /* keep status */ }
                throw Object.assign(new Error(errMsg), { status: resp.status });
            }

            const disposition = resp.headers.get('content-disposition') || '';
            const contentType = resp.headers.get('content-type') || 'application/octet-stream';
            const filename = parseDownloadFilename(disposition, absUrl, options.filename, contentType);
            card?.setTitle(filename);

            const totalBytes = Number(resp.headers.get('content-length')) || 0;
            let receivedBytes = 0;
            let blob;

            if (resp.body && typeof resp.body.getReader === 'function' && typeof Blob !== 'undefined') {
                const reader = resp.body.getReader();
                const chunks = [];
                let lastPaint = 0;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value) {
                        chunks.push(value);
                        receivedBytes += value.byteLength || value.length || 0;
                        const now = Date.now();
                        if (now - lastPaint > 48) {
                            lastPaint = now;
                            card?.setProgress(receivedBytes, totalBytes);
                        }
                    }
                }
                card?.setProgress(receivedBytes, totalBytes || receivedBytes);
                blob = new Blob(chunks, { type: contentType });
            } else {
                blob = await resp.blob();
                receivedBytes = blob.size || 0;
            }

            const blobUrl = URL.createObjectURL(blob);
            triggerBlobSave(blobUrl, filename);
            card?.setCompleted(filename, blob.size || receivedBytes, blobUrl, () => triggerBlobSave(blobUrl, filename));
            return { id: seq, filename, size: blob.size || receivedBytes, blob };
        } catch (err) {
            if (cancelled || err?.name === 'AbortError') {
                card?.setCancelled();
                return null;
            }
            card?.setError(err?.message || String(err || '下载失败'));
            throw err;
        }
    }

    dhDownload.saveBlob = function (blob, filename) {
        if (!blob || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
        const name = String(filename || 'download').trim() || 'download';
        const blobUrl = URL.createObjectURL(blob);
        triggerBlobSave(blobUrl, name);
        const card = createDownloadCard(name);
        card?.setCompleted(name, blob.size || 0, blobUrl, () => triggerBlobSave(blobUrl, name));
    };

    function isAuthenticatedDownloadPath(rawOrUrl) {
        try {
            const u = new URL(String(rawOrUrl || ''), window.location.href);
            return DH_DL_PATH_RE.test(`${dhStripBase(u.pathname)}${u.search}`);
        } catch (_) {
            return DH_DL_PATH_RE.test(String(rawOrUrl || ''));
        }
    }

    function isAuthenticatedDownloadAnchor(anchor, rawHref) {
        if (!anchor || !rawHref || rawHref.startsWith('#') || rawHref.startsWith('blob:') || rawHref.startsWith('data:')) return false;
        const resolved = anchor.href || dhResolveUrl(rawHref);
        if (!isApiUrl(resolved)) return false;
        return Boolean(anchor.hasAttribute?.('download') || anchor.dataset?.dhDownload !== undefined || isAuthenticatedDownloadPath(resolved));
    }

    window.dhDownload = dhDownload;

    if (origAnchorClick) {
        HTMLAnchorElement.prototype.click = function () {
            try {
                if (!this.dataset?.dhBypassDownload) {
                    const rawHref = this.getAttribute('href') || '';
                    if (isAuthenticatedDownloadAnchor(this, rawHref)) {
                        const explicitName = this.getAttribute('download') || this.dataset?.filename || '';
                        dhDownload(this.href || dhResolveUrl(rawHref), { filename: explicitName, label: explicitName || (this.textContent || '').trim() }).catch(() => {});
                        return;
                    }
                }
            } catch (_) { /* fallback */ }
            return origAnchorClick.call(this);
        };
    }

    document.addEventListener('click', (event) => {
        const disabledUiv = event.target?.closest?.(DH_UIV_DISABLED_SELECTOR);
        if (disabledUiv && !dhOpenxTip?.contains(event.target)) {
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
            applyUivDisabledState(disabledUiv);
            notifyOpenxDesktopRequired(disabledUiv);
            return;
        }
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
        if (isAuthenticatedDownloadAnchor(anchor, rawHref)) {
            event.preventDefault();
            event.stopPropagation();
            const explicitName = anchor.getAttribute('download') || anchor.dataset?.filename || '';
            const label = explicitName || (anchor.textContent || '').trim() || '';
            dhDownload(anchor.href || dhResolveUrl(rawHref), { filename: explicitName, label }).catch(() => {});
        }
    }, true);

    const origWinOpen = window.open;
    if (typeof origWinOpen === 'function') {
        window.open = function (url, target, features) {
            if (typeof url === 'string' && phase2Check(url)) {
                showPhase2Notice(url);
                return null;
            }
            if (typeof url === 'string' && !url.startsWith('blob:') && !url.startsWith('data:') && isApiUrl(dhResolveUrl(url)) && isAuthenticatedDownloadPath(dhResolveUrl(url))) {
                dhDownload(dhResolveUrl(url)).catch(() => {});
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
    function renderBuiltinDenied(slug) {
        if (!document.body) return;
        document.body.innerHTML = '';
        const box = document.createElement('div');
        box.style.cssText = 'max-width:460px;margin:12vh auto;padding:28px;border-radius:14px;background:#fff;border:1px solid #e3e6eb;box-shadow:0 10px 30px rgba(16,43,71,.08);text-align:center;font:14px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1d2b3a';
        const h1 = document.createElement('h2');
        h1.style.cssText = 'margin:0 0 8px;font-size:18px';
        h1.textContent = '内置工具尚未开放';
        const p = document.createElement('p');
        p.style.cssText = 'margin:0 0 18px;color:#5b6573';
        p.textContent = `工具「${slug}」当前未全员开放，仅超级管理员可使用。`;
        const link = document.createElement('a');
        link.href = dhResolveUrl('/');
        link.style.cssText = 'display:inline-block;padding:8px 16px;border-radius:8px;background:#2f6fae;color:#fff;text-decoration:none;font-weight:600';
        link.textContent = '← 返回首页';
        box.append(h1, p, link);
        document.body.appendChild(box);
    }
    function mountDebugWidgetAssets() {
        if (IS_401_PAGE) return;
        const builtinSlug = (dhStripBase(window.location.pathname || '').match(/^\/builtin-tools\/([a-z0-9_-]+)(?:\/|$)/i) || [])[1]?.toLowerCase() || '';
        const checkMe = () => window.fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null)).then(async (me) => {
            window.DH_ME = me || null;
            if (me && me.username) {
                try {
                    const prevRole = localStorage.getItem('tools_role');
                    const prevSuper = localStorage.getItem('tools_super');
                    localStorage.setItem('tools_user', me.username);
                    if (me.role) localStorage.setItem('tools_role', me.role);
                    if (typeof me.isSuper === 'boolean') localStorage.setItem('tools_super', me.isSuper ? '1' : '0');
                    if (prevRole !== localStorage.getItem('tools_role') || prevSuper !== localStorage.getItem('tools_super')) {
                        window.dispatchEvent(new CustomEvent('tools:authchange'));
                    }
                } catch (_) { /* ignore */ }
            }
            if (me && me.authRequired && !me.identified && !me.memoryMode && !me.openAdmin) {
                redirectTo401();
                return;
            }
            if (builtinSlug && me && !me.isSuper && !me.isAdmin) {
                const accessOk = await window.fetch(`/api/custom-tools/${encodeURIComponent(builtinSlug)}/meta`).then((r) => r.ok).catch(() => false);
                if (!accessOk) {
                    clearBootMask();
                    renderBuiltinDenied(builtinSlug);
                    return;
                }
            }
            clearBootMask();
            if (window !== window.top) return; // Keep widget strictly on top frame to avoid duplicate floating pills
            if (me && me.memoryMode) showMemoryBanner();
            if (me && me.isAdmin) mountDebugWidgetNow();
        }).catch(() => { clearBootMask(); });
        if (!dhPlatformUserSettled && dhPlatformUserPromise) {
            dhPlatformUserPromise.then(checkMe, checkMe);
        } else {
            checkMe();
        }
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

    window.addEventListener('tools:languagechange', () => applyUivDisabledState(document));

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            applyUivDisabledState(document.documentElement);
            new MutationObserver((records) => {
                for (const rec of records) {
                    if (rec.type === 'childList') {
                        rec.addedNodes.forEach((node) => {
                            if (DH_BASE) fixAttributes(node);
                            if (node && node.nodeType === 1) applyUivDisabledState(node);
                        });
                    } else if (DH_BASE) {
                        fixAttributes(rec.target);
                    }
                }
            }).observe(document.documentElement, { subtree: true, childList: true, ...(DH_BASE ? { attributes: true, attributeFilter: ['src', 'href'] } : {}) });
            if (DH_BASE) {
                fixAttributes(document.documentElement);
            }
            mountDebugWidgetAssets();
        }, { once: true });
    } else {
        applyUivDisabledState(document.documentElement);
        mountDebugWidgetAssets();
    }
})();
