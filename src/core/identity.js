// 身份只来自底座网关注入的 Cookie / 请求头；本服务不自建登录（红线 R2）。
// 是否管理员由 core/access.js 在请求入口统一判定后写回 req.userIdentity。
export function parseCookies(cookieHeader) {
    const map = {};
    const raw = String(cookieHeader || '');
    if (!raw) return map;
    for (const part of raw.split(';')) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        const key = part.slice(0, idx).trim();
        let val = part.slice(idx + 1).trim();
        if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
        try {
            map[key] = decodeURIComponent(val);
        } catch {
            map[key] = val;
        }
    }
    return map;
}

function detectLanguage(cookies, headers) {
    const cookieLang = String(cookies.current_lang || cookies.lang || cookies.locale || '').trim().toLowerCase();
    const headerLang = String(headers?.['x-lang'] || headers?.['accept-language'] || '').trim().toLowerCase();
    return (cookieLang || headerLang).startsWith('en') ? 'en-US' : 'zh-CN';
}

export const GUEST_ID = 'dh-guest';

/** 只解析“是谁”，不含权限。 */
export function parseIdentity(req) {
    const headers = req?.headers || {};
    const cookies = parseCookies(headers.cookie);
    const cookieUser = String(cookies.iLearningXUserName || '').trim();
    const headerUser = String(headers['x-user-id'] || headers['x-emp-no'] || headers['x-user-name'] || '').trim();
    const userId = (cookieUser || headerUser || GUEST_ID).slice(0, 120);
    return {
        id: userId,
        username: userId,
        displayName: String(headers['x-user-name'] || cookieUser || userId).slice(0, 120),
        identified: Boolean(cookieUser || headerUser),
        role: 'user',
        isAdmin: false,
        isSuper: false,
        tenantId: 'default',
        homeTenantId: 'default',
        source: cookieUser ? 'cookie:iLearningXUserName' : (headerUser ? 'header' : 'anonymous'),
        lang: detectLanguage(cookies, headers),
        cookiesPresent: Object.keys(cookies),
        appId: String(headers['x-app-id'] || ''),
        appLevel: String(headers['x-app-level'] || ''),
    };
}

/** 路由里统一用它取当前用户：优先返回入口钩子已判定权限的身份。 */
export function resolveRequestIdentity(req) {
    return req?.userIdentity || parseIdentity(req);
}
