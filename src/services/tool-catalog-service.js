// 智能体工具清单：设置页里按组展示工具、调用次数，管理员可以整组或单项停用。
// 停用名单与调用统计都存键值表；停用后的工具不会发给模型，下一轮对话生效。
import { kvGet, kvSet } from '../dao/scoped.js';
import { TOOLS } from '../agent/tools.js';

const ACCESS_KEY = 'agent_tool_access';
const STATS_KEY = 'agent_tool_stats';
const CACHE_MS = 15_000;

const GROUPS = [
    { id: 'query', label: '查询与分析', labelEn: 'Query & analysis', note: '只读，不会改动数据', kindLabel: '只读',
        tools: ['list_databases', 'database_schema', 'query_database', 'read_database_table', 'get_report_overview', 'query_data', 'calculate', 'read_file', 'view_image'] },
    { id: 'netcare', label: 'NetCare 数据探查', labelEn: 'NetCare data', note: '只读查询平台授权的业务数据源', kindLabel: '只读',
        tools: ['netcare_tables', 'netcare_describe', 'netcare_query', 'netcare_sql'] },
    { id: 'platform', label: '平台能力', labelEn: 'Platform', note: '技能、自定义工具、抓取脚本', kindLabel: '平台',
        tools: ['find_platform_tools', 'read_tool_guide', 'read_skill', 'save_skill', 'publish_html_tool', 'list_uiv_scripts', 'read_uiv_script', 'save_uiv_script'] },
    { id: 'write', label: '写入与通知', labelEn: 'Writes & notifications', note: '仅管理员可用，每次执行前都要在对话里确认', kindLabel: '需确认',
        tools: ['insert_database_row', 'update_database_rows', 'delete_database_rows', 'send_notification', 'move_uiv_script', 'delete_uiv_script'] },
    { id: 'assist', label: '对话辅助', labelEn: 'Conversation helpers', note: '任务清单、提问、记忆', kindLabel: '辅助',
        tools: ['update_plan', 'ask_user', 'memory'] },
    { id: 'followup', label: '跟进任务', labelEn: 'Follow-ups', note: '只读写本人的跟进任务，提醒发到消息中心', kindLabel: '个人',
        tools: ['followup_create', 'followup_list', 'followup_update', 'followup_close'] },
];
const groupOfTool = new Map(GROUPS.flatMap((g) => g.tools.map((name) => [name, g.id])));

let cache = { at: 0, access: null };
async function loadAccess() {
    if (cache.access && Date.now() - cache.at < CACHE_MS) return cache.access;
    const raw = (await kvGet(ACCESS_KEY, null).catch(() => null)) || {};
    cache = { at: Date.now(), access: { groups: raw.groups || {}, tools: raw.tools || {} } };
    return cache.access;
}

const isOn = (access, name) => access.tools[name] !== false && access.groups[groupOfTool.get(name) || 'other'] !== false;

/** 本轮对话可用的工具（已去掉被停用的） */
export async function enabledTools() {
    const access = await loadAccess();
    return TOOLS.filter((t) => isOn(access, t.name));
}

export async function setToolAccess({ scope, id, enabled }) {
    const access = await loadAccess();
    const bucket = scope === 'group' ? access.groups : access.tools;
    const known = scope === 'group' ? GROUPS.some((g) => g.id === id) || id === 'other' : TOOLS.some((t) => t.name === id);
    if (!known) return null;
    if (enabled === false) bucket[id] = false; else delete bucket[id];
    await kvSet(ACCESS_KEY, access);
    cache = { at: Date.now(), access };
    return access;
}

/** 一轮对话结束后记一次调用统计：calls 为 [{ name, ok }] */
export async function recordToolCalls(calls = []) {
    if (!calls.length) return;
    try {
        const stats = (await kvGet(STATS_KEY, null)) || {};
        const now = new Date().toISOString();
        for (const { name, ok } of calls) {
            const item = (stats[name] ||= { calls: 0, failures: 0, lastUsedAt: '' });
            item.calls += 1;
            if (!ok) item.failures += 1;
            item.lastUsedAt = now;
        }
        await kvSet(STATS_KEY, stats);
    } catch { /* 统计失败不影响对话 */ }
}

// 工具说明大约占多少 token：中文按 1.5 字符一个估算
const tokensOf = (tool) => Math.ceil((tool.description.length + JSON.stringify(tool.parameters || {}).length) / 1.6);

export async function toolCatalog({ manage = false, language = 'zh' } = {}) {
    const access = await loadAccess();
    const stats = (await kvGet(STATS_KEY, null).catch(() => null)) || {};
    const en = language === 'en';
    const row = (tool, kindLabel) => ({
        name: tool.name,
        kindLabel,
        summary: String(tool.description || '').split(/[。\n]/)[0].slice(0, 90),
        tokens: tokensOf(tool),
        calls: Number(stats[tool.name]?.calls) || 0,
        failures: Number(stats[tool.name]?.failures) || 0,
        lastUsedAt: stats[tool.name]?.lastUsedAt ? String(stats[tool.name].lastUsedAt).replace('T', ' ').slice(0, 16) : '',
        enabled: access.tools[tool.name] !== false,
    });
    const groups = GROUPS.map((g) => ({
        id: g.id,
        label: en ? g.labelEn : g.label,
        note: g.note,
        mode: 'always',
        enabled: access.groups[g.id] !== false,
        tools: g.tools.map((name) => TOOLS.find((t) => t.name === name)).filter(Boolean).map((t) => row(t, g.kindLabel)),
    }));
    const rest = TOOLS.filter((t) => !groupOfTool.has(t.name));
    if (rest.length) groups.push({ id: 'other', label: en ? 'Other' : '其他', note: '', mode: 'always', enabled: access.groups.other !== false, tools: rest.map((t) => row(t, '其他')) });
    return { manage, groups };
}
