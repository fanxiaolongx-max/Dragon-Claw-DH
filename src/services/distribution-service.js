// 「全员开放」开关（与主线版 /api/distribution 同接口）：超级管理员把技能、插件或工具标为全员开放。
// 状态存在应用库的键值表里，键为 `skill:<id>`、`cap:<id>`、`tool:<slug>`。
// 开放与否控制非超级管理员（!isSuper && !isAdmin）能否在界面、接口及 AI 对话中看到并调用对应条目；未开放前仅超级管理员可用。
// 用户自己发布的自定义工具本来就有可见范围（visibility），开放 / 关闭直接改它，不另存一份。
import { BusinessError } from '../core/errors.js';
import { isSameUserId } from '../core/access.js';
import { kvGet, kvSet, selectTable, updateRows, sqlVal } from '../dao/scoped.js';

const KEY = 'distribution_shared';
const KINDS = new Set(['skill', 'cap', 'tool']);

export const isSuperUser = (identity) => Boolean(identity?.isSuper || identity?.isAdmin);

export async function sharedKeys() {
    const list = await kvGet(KEY, []);
    return new Set(Array.isArray(list) ? list.map(String) : []);
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
    return isOwnSkill(skillOrId, identity);
}

export async function filterSkillsForUser(items, identity) {
    const keys = await sharedKeys();
    const marked = items.map((item) => ({ ...item, sharedAccess: keys.has(`skill:${item.id}`) }));
    if (isSuperUser(identity)) return marked;
    return marked.filter((item) => item.sharedAccess || isOwnSkill(item, identity));
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
