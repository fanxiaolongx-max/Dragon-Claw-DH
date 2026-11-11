// API 基址（规范 §12.2）：按当前页面路径拼接，不写死 /api、不用 location.origin、不用 <base href>。
//   本地：  /                                   → /api
//   平台：  /digital-human/dh/{UUID}/           → /digital-human/dh/{UUID}/api
//   子页面：/digital-human/dh/{UUID}/sla        → /digital-human/dh/{UUID}/api（由 dh-runtime.js 识别应用根）
// 新写的页面直接用 window.api；从桌面版同步来的页面经 js/shared/dh-runtime.js 自动改写到同一个基址。
(function () {
    function apiBase() {
        if (typeof window.DH_BASE === 'string') return window.DH_BASE + '/api';
        var p = window.location.pathname;
        var dir = p.endsWith('/') ? p : p.substring(0, p.lastIndexOf('/') + 1);
        return dir + 'api';
    }
    var API_BASE = apiBase();

    async function apiFetch(path, options) {
        var resp = await fetch(API_BASE + path, options);
        var body = await resp.json().catch(function () { return null; });
        if (!resp.ok) throw new Error((body && (body.error || body.message)) || ('HTTP ' + resp.status));
        return body;
    }

    window.api = {
        base: API_BASE,
        get: function (p) { return apiFetch(p); },
        post: function (p, body) {
            return apiFetch(p, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body || {}),
            });
        },
    };
})();
