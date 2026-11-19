// 「全员开放」开关（与主线版 /api/distribution 同接口）：超级管理员把技能、插件或工具标为全员开放。
// 状态存在应用库的键值表里，键为 `skill:<id>`、`cap:<id>`、`tool:<slug>`、`page:<id>`（平台原生页面）。
// 开放与否控制非超级管理员（!isSuper && !isAdmin）能否在界面、接口及 AI 对话中看到并调用对应条目；未开放前仅超级管理员可用。
// 用户自己发布的自定义工具本来就有可见范围（visibility），开放 / 关闭直接改它，不另存一份。
import { BusinessError } from '../core/errors.js';
import { isSameUserId } from '../core/access.js';
import { kvGet, kvSet, selectTable, updateRows, sqlVal } from '../dao/scoped.js';
import { grantedSkillIdsForUser } from './share-service.js';

const KEY = 'distribution_shared';
const KINDS = new Set(['skill', 'cap', 'tool', 'page']);

export const isSuperUser = (identity) => Boolean(identity?.isSuper || identity?.isAdmin);

export async function sharedKeys() {
    await ensurePageDefaults();
    const list = await kvGet(KEY, []);
    return new Set(Array.isArray(list) ? list.map(String) : []);
}

// ── 平台原生页面（与主线版 page-distribution.js 同一套页面与接口归属）──
// 升级前这些业务页对所有人开放：第一次读取时一次性记为「全员开放」，之后由超级管理员收回或重新开放。
// 数据探索是基础设施页，锁定为仅超级管理员可用，不能开放。
export const PAGES = Object.freeze([
    { id: 'uivf12', href: '/uivf12', paths: ['/uivf12'], defaultShared: true },
    { id: 'sla', href: '/sla', paths: ['/sla'], defaultShared: true },
    { id: 'report', href: '/report', paths: ['/report'], defaultShared: true },
    { id: 'expedite', href: '/expedite', paths: ['/expedite'], defaultShared: true },
    { id: 'monthly', href: '/monthly', paths: ['/monthly', '/monthly/legacy', '/ai-report'], defaultShared: true },
    { id: 'ai-bi', href: '/ai-bi', paths: ['/ai-bi'], defaultShared: true },
    { id: 'duty-roster', href: '/duty-roster', paths: ['/duty-roster'], defaultShared: true },
    { id: 'bigscreen', href: '/bigscreen', paths: ['/bigscreen'], defaultShared: true },
    { id: 'topic-analysis', href: '/topic-analysis', paths: ['/topic-analysis', '/topical-analysis'], defaultShared: true },
    { id: 'frt', href: '/frt', paths: ['/frt'], defaultShared: true },
    { id: 'requirements', href: '/requirements', paths: ['/requirements'], defaultShared: true },
    { id: 'praudit', href: '/praudit', paths: ['/praudit'], defaultShared: true },
    { id: 'db-explorer', href: '/db-explorer', paths: ['/db-explorer'], defaultShared: false, locked: true },
]);
const PAGE_BY_ID = new Map(PAGES.map((page) => [page.id, page]));
const PAGE_BY_PATH = new Map(PAGES.flatMap((page) => page.paths.map((path) => [path, page])));
const PAGE_SEED_KEY = 'distribution_page_defaults_v1';
let pageSeed = null;

async function ensurePageDefaults() {
    if (!pageSeed) {
        pageSeed = (async () => {
            if ((await kvGet(PAGE_SEED_KEY, false)) === true) return;
            const list = await kvGet(KEY, []);
            const keys = new Set(Array.isArray(list) ? list.map(String) : []);
            for (const page of PAGES) if (page.defaultShared && !page.locked) keys.add(`page:${page.id}`);
            await kvSet(KEY, [...keys].sort());
            await kvSet(PAGE_SEED_KEY, true);
        })().catch((error) => { pageSeed = null; throw error; });
    }
    return pageSeed;
}

/** 页面路径（/sla、/sla.html、带查询参数）或 page:<id> → 页面 ID；不是平台页面返回 null */
export function normalizePageId(input) {
    let clean = String(input || '').trim().toLowerCase();
    if (clean.startsWith('page:')) clean = clean.slice(5);
    if (PAGE_BY_ID.has(clean)) return clean;
    clean = clean.split(/[?#]/, 1)[0].replace(/\.html$/, '').replace(/\/+$/, '') || '/';
    return PAGE_BY_PATH.get(clean)?.id || null;
}

export async function canAccessPage(idOrPath, identity, keys = null) {
    const page = PAGE_BY_ID.get(normalizePageId(idOrPath) || '');
    if (!page || isSuperUser(identity)) return true;
    if (page.locked) return false;
    return (keys || (await sharedKeys())).has(`page:${page.id}`);
}

/** 页面的默认开放状态（未读到开放名单时用） */
export function pageSharedByDefault(idOrPath) {
    const page = PAGE_BY_ID.get(normalizePageId(idOrPath) || '');
    return !page || Boolean(page.defaultShared && !page.locked);
}

export async function canAccessAnyPage(ids, identity) {
    if (isSuperUser(identity)) return true;
    const keys = await sharedKeys();
    for (const id of ids) if (await canAccessPage(id, identity, keys)) return true;
    return false;
}

/** 抓取脚本：数据抓取页开放给全员时全部可用，否则只能用单独开放的浮窗插件里的脚本 */
export async function canAccessAllUivScripts(identity) {
    return canAccessPage('uivf12', identity);
}

export async function listPages(identity) {
    const keys = await sharedKeys();
    const superUser = isSuperUser(identity);
    return PAGES.map((page) => ({
        id: page.id,
        href: page.href,
        sharedAccess: !page.locked && keys.has(`page:${page.id}`),
        locked: Boolean(page.locked),
        visible: superUser || (!page.locked && keys.has(`page:${page.id}`)),
    }));
}

export async function setPageAccess(idOrPath, sharedAccess) {
    const page = PAGE_BY_ID.get(normalizePageId(idOrPath) || '');
    if (!page) throw new BusinessError('平台工具不存在', 404);
    if (page.locked) throw new BusinessError('该系统工具仅超级管理员可用，不能开放给全员', 403);
    await setShared('page', page.id, Boolean(sharedAccess));
    return { id: page.id, href: page.href, sharedAccess: Boolean(sharedAccess), locked: false };
}

// 接口归属哪些页面：任一页面开放即可调用（与主线版 API_PAGE_RULES 一致；
// 会议考勤、操作激励等内置工具的接口由内置工具开关管理，不在这里）
const API_PAGE_RULES = [
    { pattern: /^\/db-explorer(?:\/|$)/, pages: ['db-explorer'] },
    { pattern: /^\/frt(?:\/|$)/, pages: ['frt'] },
    { pattern: /^\/praudit(?:\/|$)/, pages: ['praudit'] },
    { pattern: /^\/ai-bi(?:\/|$)/, pages: ['ai-bi'] },
    { pattern: /^\/duty-roster(?:\/|$)/, pages: ['duty-roster'] },
    { pattern: /^\/expedite(?:\/|$)/, pages: ['expedite'] },
    { pattern: /^\/uiv-ai-adapter(?:\/|$)/, pages: ['uivf12'] },
    { pattern: /^\/uiv\/(?:extension-download|backup|run-uivision-macro|uivision-runner)(?:\/|$)/, pages: ['uivf12'] },
    { pattern: /^\/uiv\/(?:scripts|categories|batch-scope)(?:\/|$)/, check: (identity, _apiPath, method) => (method === 'GET' ? true : canAccessPage('uivf12', identity)) },
    { pattern: /^\/upload(?:\/|$)/, pages: ['sla', 'monthly'] },
    { pattern: /^\/sla\/(?:snapshot|snapshots\/cleanup-redundant|rule-templates|copied-fields|template-mapping)(?:\/|$)/, pages: ['sla'] },
    { pattern: /^\/sla\/(?:export-yuxiang|preview-yuxiang|rename-metric)(?:\/|$)/, pages: ['sla', 'report'] },
    { pattern: /^\/sla(?:\/|$)/, pages: ['sla', 'report', 'expedite', 'monthly', 'bigscreen', 'uivf12'] },
    { pattern: /^\/db\/(?:latest_failing|failing)(?:\/|$)/, pages: ['expedite'] },
    { pattern: /^\/db\/(?:expiring_warning_trends|metric_count_trends|metric_item_trend|manual-adjust-attachments|config\/report_snapshot_filter)(?:\/|$)/, pages: ['report'] },
    { pattern: /^\/db\/(?:bigscreen_owners|config\/bigscreen_)/, pages: ['bigscreen'] },
    { pattern: /^\/db\/(?:monthly_report_data|config\/monthly_report_titles)(?:\/|$)/, pages: ['monthly', 'report', 'bigscreen'] },
    { pattern: /^\/db\/save(?:\/|$)/, pages: ['sla', 'report'] },
    { pattern: /^\/db(?:\/|$)/, pages: ['report', 'expedite', 'monthly', 'bigscreen', 'sla'] },
    { pattern: /^\/(?:monthly-snapshots|report-msg)(?:\/|$)/, pages: ['monthly'] },
    { pattern: /^\/ai-report\/bi\/plan(?:\/|$)/, pages: ['ai-bi', 'monthly'] },
    { pattern: /^\/ai-report\/(?:cell|run-data)(?:\/|$)/, pages: ['monthly', 'ai-bi'] },
    { pattern: /^\/ai-report(?:\/|$)/, pages: ['monthly'] },
    { pattern: /^\/topic-snapshots(?:\/|$)/, pages: ['topic-analysis', 'uivf12'] },
    {
        pattern: /^\/requirements(?:\/|$)/,
        check: (identity, apiPath, method) => {
            if (/^\/requirements\/(?:skill-publications|catalog-updates|transport-key|uploads)(?:\/|$)/.test(apiPath)) return true;
            if (/^\/requirements\/[^/]+\/(?:approve-skill|approve-update|update-file)$/.test(apiPath)) return true;
            if (method === 'GET' && /^\/requirements\/[^/]+$/.test(apiPath)) return true;
            return canAccessPage('requirements', identity);
        },
    },
];

export async function canAccessApi(apiPath, method, identity) {
    if (isSuperUser(identity)) return true;
    const clean = String(apiPath || '').split(/[?#]/, 1)[0];
    for (const rule of API_PAGE_RULES) {
        if (!rule.pattern.test(clean)) continue;
        if (rule.check) return rule.check(identity, clean, String(method || 'GET').toUpperCase());
        return canAccessAnyPage(rule.pages, identity);
    }
    return true;
}

export async function isShared(kind, id) {
    if (!KINDS.has(kind) || !id) return false;
    return (await sharedKeys()).has(`${kind}:${id}`);
}

export async function isAnyShared(kind, ids = []) {
    if (!KINDS.has(kind) || !ids.length) return false;
    const keys = await sharedKeys();
    return ids.some((id) => Boolean(id) && keys.has(`${kind}:${id}`));
}

export async function setShared(kind, id, sharedAccess) {
    if (!KINDS.has(kind) || typeof id !== 'string' || !id || id.length > 350 || typeof sharedAccess !== 'boolean') {
        throw new BusinessError('开放设置无效', 400);
    }
    const keys = await sharedKeys();
    const key = `${kind}:${id}`;
    if (sharedAccess) keys.add(key); else keys.delete(key);
    await kvSet(KEY, [...keys].sort());
    return sharedAccess;
}

/** 给列表里的每一项标上 sharedAccess */
export async function withShared(kind, items, idOf = (item) => item.id) {
    const keys = await sharedKeys();
    return items.map((item) => ({ ...item, sharedAccess: keys.has(`${kind}:${idOf(item)}`) }));
}

const isOwnSkill = (skill, identity) => Boolean(
    skill && typeof skill === 'object' && !skill.builtIn
    && skill.createdBy && identity?.username && isSameUserId(skill.createdBy, identity.username),
);

export async function canAccessSkill(skillOrId, identity, keys = null) {
    if (isSuperUser(identity)) return true;
    const id = typeof skillOrId === 'string' ? skillOrId.toLowerCase() : String(skillOrId?.id || '').toLowerCase();
    if (!id) return false;
    const set = keys || (await sharedKeys());
    if (set.has(`skill:${id}`)) return true;
    if (isOwnSkill(skillOrId, identity)) return true;
    const granted = await grantedSkillIdsForUser(identity).catch(() => new Set());
    return granted.has(id);
}

export async function filterSkillsForUser(items, identity) {
    const [keys, granted] = await Promise.all([
        sharedKeys(),
        isSuperUser(identity) ? Promise.resolve(new Set()) : grantedSkillIdsForUser(identity).catch(() => new Set()),
    ]);
    const marked = items.map((item) => {
        const sharedAccess = keys.has(`skill:${item.id}`);
        const sharedViaConversation = !sharedAccess && granted.has(String(item.id || '').toLowerCase());
        return { ...item, sharedAccess, ...(sharedViaConversation ? { sharedViaConversation: true } : {}) };
    });
    if (isSuperUser(identity)) return marked;
    return marked.filter((item) => item.sharedAccess || item.sharedViaConversation || isOwnSkill(item, identity));
}

export async function filterCapabilitiesForUser(groups, identity) {
    const keys = await sharedKeys();
    const admin = isSuperUser(identity);
    const out = [];
    for (const group of groups || []) {
        const items = (group.items || [])
            .map((item) => ({ ...item, sharedAccess: keys.has(`cap:${item.id}`) }))
            .filter((item) => admin || item.sharedAccess);
        if (items.length) out.push({ ...group, count: items.length, items });
    }
    return out;
}

export async function filterUivScriptsForUser(scripts, identity, originResolver) {
    if (isSuperUser(identity)) return scripts;
    const keys = await sharedKeys();
    if (await canAccessPage('uivf12', identity, keys)) return scripts;
    return (scripts || []).filter((script) => {
        const origin = originResolver(script);
        return Boolean(origin && keys.has(`cap:float:${origin}`));
    });
}

/** 自定义工具：内置工具记在开关表里；用户发布的工具改可见范围（public = 全员可见） */
export async function setToolShared(slug, sharedAccess, { builtIn }) {
    if (builtIn) return setShared('tool', slug, sharedAccess);
    const key = String(slug || '').toLowerCase();
    const rows = await selectTable('custom_tools', { columns: ['slug'], whereSql: `\`slug\` = ${sqlVal(key)}`, limit: 1, memFilter: (r) => r.slug === key });
    if (!rows.length) throw new BusinessError('工具不存在', 404);
    await updateRows('custom_tools', { visibility: sharedAccess ? 'public' : 'private', updated_at: Date.now() }, { whereSql: `\`slug\` = ${sqlVal(key)}`, memFilter: (r) => r.slug === key });
    return sharedAccess;
}
