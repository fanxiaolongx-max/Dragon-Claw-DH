// 内置浏览器收藏（与主线版 browser-bookmarks-repository 一致）：每人一份，存在键值表里，最多 200 条。
// 只收 HTTP / HTTPS，保存前去掉地址里的账号口令和 token、签名这类参数。
import { BusinessError } from '../core/errors.js';
import { kvGet, kvSet } from '../dao/scoped.js';

const MAX_ITEMS = 200;
const keyOf = (username) => `browser_bookmarks:${String(username || '')}`;

export function savedUrl(value) {
    try {
        const url = new URL(String(value || ''));
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        url.username = ''; url.password = '';
        for (const key of [...url.searchParams.keys()]) {
            if (/token|password|secret|authorization|api.?key|signature|^code$|^state$/i.test(key)) url.searchParams.delete(key);
        }
        if (/token|password|secret|authorization|api.?key|signature/i.test(url.hash)) url.hash = '';
        return url.toString();
    } catch { return null; }
}

export async function listBookmarks(username) {
    const items = await kvGet(keyOf(username), []);
    return Array.isArray(items) ? items : [];
}

export async function updateBookmark(username, { url, title, remove = false } = {}) {
    const safe = savedUrl(url);
    if (!safe) throw new BusinessError('只能收藏 HTTP 或 HTTPS 网页', 400);
    const items = (await listBookmarks(username)).filter((item) => item.url !== safe);
    if (!remove) items.unshift({ url: safe, title: String(title || safe).slice(0, 500) });
    const next = items.slice(0, MAX_ITEMS);
    await kvSet(keyOf(username), next);
    return next;
}
