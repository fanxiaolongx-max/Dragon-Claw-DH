export function parseCookies(cookieHeader) {
    const map = {};
    const raw = String(cookieHeader || '');
    if (!raw) return map;
    for (const part of raw.split(';')) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        const key = part.slice(0, idx).trim();
        let val = part.slice(idx + 1).trim();
        if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
            val = val.slice(1, -1);
        }
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
    const src = cookieLang || headerLang;
    if (src.startsWith('en')) return 'en-US';
    return 'zh-CN';
}

export function resolveRequestIdentity(req) {
    const headers = req?.headers || {};
    const cookies = parseCookies(headers.cookie);
    const cookieUser = String(cookies.iLearningXUserName || '').trim();
    const headerUser = String(headers['x-user-id'] || headers['x-emp-no'] || headers['x-user-name'] || '').trim();
    const userId = cookieUser || headerUser || 'dh-guest';
    const lang = detectLanguage(cookies, headers);

    return {
        id: userId,
        username: userId,
        displayName: String(headers['x-user-name'] || cookieUser || userId),
        role: 'admin',
        isAdmin: true,
        isSuper: true,
        tenantId: 'default',
        homeTenantId: 'default',
        source: cookieUser ? 'cookie:iLearningXUserName' : (headerUser ? 'header' : 'anonymous-local'),
        lang,
        cookiesPresent: Object.keys(cookies),
        appId: String(headers['x-app-id'] || ''),
        appLevel: String(headers['x-app-level'] || ''),
    };
}
