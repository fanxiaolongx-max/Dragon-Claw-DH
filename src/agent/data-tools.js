// 对话里查“平台自己的数据”的两组只读工具：
// - read_page_config：各页面保存在键值表里的配置（一键催办通讯录、报表看板配置、导入设置、月报模板等）。
//   只开放白名单里的键，并跟着页面权限走（页面没对你开放就读不到）；登录、管理员名单、模型配置、记忆、对话列表、
//   技能文件等键永远不开放。值里凡是键名像密码 / 令牌 / 密钥的字段一律隐藏。
// - search_my_conversations / read_my_conversation：当前账号自己的历史对话（自己发起的 + 已加入且仍有效的共享对话）。
//   会话号不是自己的直接拒绝；只返回问题和回答正文，不带工具细节和附件内容。
// 所有工具结果交给模型前还会再过一遍 redact.js 的统一脱敏。
import { selectTable, kvGet, sqlVal, teamScopedKey, currentTeam } from '../dao/scoped.js';
import { canAccessAnyPage } from '../services/distribution-service.js';
import { getSession, listMessages } from '../services/ai-service.js';
import { memberSessionIds } from '../services/share-service.js';
import { redactText } from './redact.js';

const isPrivileged = (identity) => Boolean(identity?.isSuper || identity?.isAdmin);

// ── 页面配置 ──
export const PAGE_CONFIGS = [
    { key: 'expedite_notify_directory', page: 'expedite', label: '一键催办：催办通讯录（责任人 → 工号 / 邮箱）' },
    { prefix: 'report_config:', page: 'report', label: '报表看板：看板配置（每个看板一份）' },
    { key: 'yuxiang_template_mapping', page: 'report', label: '报表看板：导出模板的字段映射' },
    { key: 'import_settings', page: 'sla', label: '数据导入：导入设置' },
    { key: 'sla_copied_fields', page: 'sla', label: '数据导入：复制字段与规则模板' },
    { key: 'sla_fast_mapping_templates', page: 'sla', label: '数据导入：快速映射模板' },
    { key: 'sla_metric_rule_changes', page: 'sla', label: '数据导入：指标规则修改记录' },
    { key: 'source_categories_map', page: 'sla', label: '数据导入：来源文件分类映射' },
    { key: 'source_presentations_map', page: 'sla', label: '数据导入：来源展示映射' },
    { key: 'monthly_default_template', page: 'monthly', label: '月报：默认模板' },
    { key: 'monthly_quick_metrics_map', page: 'monthly', label: '月报：快捷指标映射' },
    { key: 'ai_report_default_id', page: 'monthly', label: '月报：默认 AI 月报' },
    { key: 'topic_customer_mapping', page: 'topic-analysis', label: '专题分析：客户映射' },
    { key: 'uiv_batch_scope', page: 'uivf12', label: '数据抓取：批量执行范围' },
    { key: 'nav_settings', label: '平台导航布局' },
    { key: 'friend_links_config', label: '首页友情链接' },
    { key: 'platform_promotions_config', label: '首页推广位' },
    { key: 'distribution_shared', admin: true, label: '全员开放名单（页面 / 技能 / 工具），仅管理员' },
    { key: 'agent_tool_access', admin: true, label: 'AI 工具停用设置，仅管理员' },
    { key: 'sla_audit_log', admin: true, label: '数据导入操作日志，仅管理员' },
];
const SECRET_KEY = /(?:password|passwd|pwd|secret|token|cookie|authorization|credential|private.?key|api.?key|密码|口令|密钥)/i;
const CONFIG_CHARS = 20_000;

const specFor = (key) => PAGE_CONFIGS.find((c) => (c.key ? c.key === key : key.startsWith(c.prefix) && key.length > c.prefix.length));

async function canRead(spec, identity) {
    if (!spec) return false;
    if (isPrivileged(identity)) return true;
    if (spec.admin) return false;
    return spec.page ? canAccessAnyPage([spec.page], identity) : true;
}

function maskSecrets(value, depth = 0) {
    if (depth > 20 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => maskSecrets(v, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && v !== '' && v != null ? '[已隐藏]' : maskSecrets(v, depth + 1)]));
}

function pick(value, path) {
    let cur = value;
    for (const part of String(path || '').split(/[.[\]]/).filter(Boolean)) {
        if (cur == null || typeof cur !== 'object') return { missing: part };
        cur = cur[/^\d+$/.test(part) && Array.isArray(cur) ? Number(part) : part];
    }
    return { value: cur };
}

function outline(value) {
    if (Array.isArray(value)) return `数组，${value.length} 项`;
    if (value && typeof value === 'object') return `对象，字段：${Object.keys(value).slice(0, 40).join('、')}`;
    return typeof value;
}

async function listConfigs(identity) {
    const keys = PAGE_CONFIGS.filter((c) => c.key).map((c) => c.key);
    const prefixes = PAGE_CONFIGS.filter((c) => c.prefix).map((c) => c.prefix);
    // 工具页面的配置在非默认团队下存成 team:<团队>:<键>：按实际键名查，列出时还原成原键名
    const realKeys = keys.map(teamScopedKey);
    const realPrefixes = prefixes.map((p) => ({ raw: p, real: teamScopedKey(p) }));
    const rows = await selectTable('sys_kv_store', {
        columns: ['kv_key', 'updated_at'],
        whereSql: `(\`kv_key\` IN (${realKeys.map(sqlVal).join(', ')})${realPrefixes.map((p) => ` OR \`kv_key\` LIKE ${sqlVal(`${p.real}%`)}`).join('')})`,
        limit: 500,
        memFilter: (r) => realKeys.includes(r.kv_key) || realPrefixes.some((p) => String(r.kv_key).startsWith(p.real)),
    });
    const team = currentTeam();
    const out = [];
    for (const row of rows) {
        const shown = team && String(row.kv_key).startsWith(`team:${team}:`) ? String(row.kv_key).slice(`team:${team}:`.length) : String(row.kv_key);
        // 默认团队查原键时，带 team: 前缀的键不会被 IN / LIKE 命中；非默认团队只认本团队前缀
        if (team && shown === String(row.kv_key) && realKeys.length && !realKeys.includes(row.kv_key)) continue;
        row.kv_key = shown;
        const spec = specFor(String(row.kv_key));
        if (!(await canRead(spec, identity))) continue;
        out.push({ key: row.kv_key, page: spec.page || '', label: spec.label, updatedAt: row.updated_at ? new Date(Number(row.updated_at)).toISOString() : '' });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
}

const fail = (message, summary = message) => ({ ok: false, summary: String(summary).slice(0, 60), content: message });

export const PAGE_CONFIG_TOOLS = [
    {
        name: 'read_page_config',
        description: '读取平台各页面保存的配置（不在业务表里、SQL 查不到的那部分）：一键催办通讯录、报表看板配置、数据导入设置与映射模板、月报默认模板、专题分析客户映射、导航与首页配置等。不传 key 列出你能读的配置；传 key 读内容。内容大时先看返回的结构，再用 path 取子字段（如 "assignments" 或 "items.0"），数组可用 offset / limit 分页。只读，键名像密码 / 令牌的字段会隐藏。',
        parameters: {
            type: 'object',
            properties: {
                key: { type: 'string', description: '配置键，取自不传 key 时的列表' },
                path: { type: 'string', description: '可选：只取某个子字段，点号分隔，如 roster 或 items.0.name' },
                offset: { type: 'integer', description: '结果是数组时从第几项开始，默认 0' },
                limit: { type: 'integer', description: '结果是数组时最多取几项，默认 100，上限 500' },
            },
        },
        async run(args, ctx) {
            const identity = ctx?.identity;
            const key = String(args.key || '').trim();
            if (!key) {
                const items = await listConfigs(identity);
                return { ok: true, summary: `${items.length} 项配置`, content: JSON.stringify({ configs: items, note: items.length ? '用 key 读取具体内容' : '暂时没有你能读取的页面配置' }) };
            }
            const spec = specFor(key);
            if (!spec) return fail(`配置 ${key} 不开放读取。不传 key 可以看到能读的配置；业务数据请用 query_database。`, '配置不开放');
            if (!(await canRead(spec, identity))) return fail(spec.admin ? `配置 ${key} 仅管理员可读。` : `配置 ${key} 所属页面没有对你开放。`, '没有权限');
            const raw = await kvGet(key, undefined);
            if (raw === undefined) return { ok: true, summary: `${spec.label} · 尚未配置`, content: JSON.stringify({ key, label: spec.label, empty: true, note: '这个页面还没有保存过这项配置' }) };
            const picked = pick(maskSecrets(raw), args.path);
            if (picked.missing) return fail(`路径 ${args.path} 不存在（在「${picked.missing}」处找不到）。整体结构：${outline(raw)}`, '路径不存在');
            let value = picked.value;
            let page = null;
            if (Array.isArray(value)) {
                const offset = Math.max(0, Math.floor(Number(args.offset)) || 0);
                const limit = Math.max(1, Math.min(Number(args.limit) || 100, 500));
                page = { total: value.length, offset, nextOffset: offset + limit < value.length ? offset + limit : null };
                value = value.slice(offset, offset + limit);
            }
            let text = JSON.stringify(value);
            const truncated = text.length > CONFIG_CHARS;
            if (truncated) text = `${text.slice(0, CONFIG_CHARS)}…`;
            return {
                ok: true,
                summary: `${spec.label}${args.path ? ` / ${args.path}` : ''}${page ? ` · ${page.total} 项` : ''}${truncated ? '（已截断）' : ''}`,
                content: JSON.stringify({
                    key, label: spec.label, path: args.path || '', structure: outline(picked.value), ...(page || {}),
                    ...(truncated ? { note: `内容超过 ${CONFIG_CHARS} 字符已截断：请用 path 取子字段，数组用 offset / limit 分页` } : {}),
                    value: truncated ? text : value,
                }),
            };
        },
    },
];

// ── 我的历史对话 ──
const SNIPPET_RADIUS = 80;
const MESSAGE_CHARS = 3000;
const PAGE_BUDGET = 24_000;
const MAX_SESSIONS_SCANNED = 500;

const terms = (q) => [...new Set(String(q || '').toLowerCase().split(/\s+/).map((w) => w.trim()).filter(Boolean))].slice(0, 8);
const dayStart = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? Date.parse(`${s}T00:00:00`) : null);
const iso = (ms) => (Number(ms) ? new Date(Number(ms)).toISOString() : '');
const roleOf = (r) => (r === 'user' ? 'user' : 'assistant');

function snippet(content, words) {
    const text = String(content || '').replace(/\s+/g, ' ');
    const lower = text.toLowerCase();
    const hit = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, hit - SNIPPET_RADIUS);
    return `${start ? '…' : ''}${text.slice(start, hit + SNIPPET_RADIUS * 2)}${hit + SNIPPET_RADIUS * 2 < text.length ? '…' : ''}`;
}

function requireUser(identity) {
    if (!identity?.username || identity.identified === false) {
        throw Object.assign(new Error('没有识别到登录账号，不能查历史对话'), { code: 'FORBIDDEN' });
    }
    return String(identity.username);
}

/** 我能看的会话：自己发起的 + 已加入的共享对话，按最近更新排序 */
async function mySessions(user) {
    const own = await selectTable('ai_chat_sessions', {
        columns: ['id', 'title', 'archived', 'created_at', 'updated_at'],
        whereSql: `\`owner_id\` = ${sqlVal(user)}`,
        orderBySql: '`updated_at` DESC',
        limit: MAX_SESSIONS_SCANNED,
        memFilter: (r) => r.owner_id === user,
        memSort: (a, b) => (b.updated_at || 0) - (a.updated_at || 0),
    });
    const list = own.map((r) => ({ id: r.id, title: r.title, archived: Boolean(Number(r.archived)), createdAt: Number(r.created_at) || 0, updatedAt: Number(r.updated_at) || 0, shared: false }));
    const seen = new Set(list.map((s) => s.id));
    for (const id of (await memberSessionIds(user).catch(() => [])).slice(0, 100)) {
        if (seen.has(id)) continue;
        const s = await getSession(id);
        if (s) list.push({ id: s.id, title: s.title, archived: s.archived, createdAt: Number(s.createdAt) || 0, updatedAt: Number(s.updatedAt) || 0, shared: true });
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function searchMine(args, identity, secrets) {
    const user = requireUser(identity);
    const words = terms(args.query);
    const limit = Math.max(1, Math.min(Number(args.limit) || 10, 30));
    const offset = Math.max(0, Number(args.offset) || 0);
    const since = dayStart(args.since);
    const until = dayStart(args.until);
    let sessions = (await mySessions(user)).filter((s) => (since == null || s.updatedAt >= since) && (until == null || s.createdAt < until + 86_400_000));
    const hitsBySession = new Map();
    if (words.length && sessions.length) {
        const ids = sessions.map((s) => s.id);
        const like = words.map((w) => `LOCATE(${sqlVal(w)}, LOWER(\`content\`)) > 0`).join(' OR ');
        const rows = await selectTable('ai_chat_messages', {
            columns: ['id', 'session_id', 'role', 'content', 'created_at'],
            // 分片存放的长消息在库里只是一个标记，取出来拼回后再按关键词过滤
            whereSql: `\`session_id\` IN (${ids.map(sqlVal).join(', ')}) AND \`role\` IN ('user', 'model') AND (${like} OR \`content\` LIKE '@@dh-chunk:%')`,
            orderBySql: '`id` ASC',
            limit: 2000,
            memFilter: (r) => ids.includes(r.session_id) && ['user', 'model'].includes(r.role),
            memSort: (a, b) => a.id - b.id,
        });
        for (const row of rows) {
            const lower = String(row.content || '').toLowerCase();
            if (!words.some((w) => lower.includes(w))) continue;
            if (!hitsBySession.has(row.session_id)) hitsBySession.set(row.session_id, []);
            hitsBySession.get(row.session_id).push(row);
        }
        sessions = sessions.filter((s) => {
            const text = `${s.title} ${(hitsBySession.get(s.id) || []).map((r) => r.content).join(' ')}`.toLowerCase();
            return words.every((w) => text.includes(w));
        });
    }
    const page = sessions.slice(offset, offset + limit);
    const items = page.map((s) => ({
        sessionId: s.id,
        title: redactText(s.title || '', { secrets }),
        createdAt: iso(s.createdAt),
        updatedAt: iso(s.updatedAt),
        ...(s.shared ? { shared: true } : {}),
        ...(s.archived ? { archived: true } : {}),
        ...(words.length ? { matches: (hitsBySession.get(s.id) || []).slice(0, 3).map((r) => ({ messageId: String(r.id), role: roleOf(r.role), at: iso(r.created_at), text: redactText(snippet(r.content, words), { secrets }) })) } : {}),
    }));
    const hasMore = offset + limit < sessions.length;
    return { sessions: items, hasMore, nextOffset: hasMore ? offset + limit : null, ...(items.length ? {} : { note: words.length ? '没有找到含这些关键词的对话，可以换个说法或少用几个词' : '还没有历史对话' }) };
}

async function readMine(args, identity, secrets, currentSessionId) {
    const user = requireUser(identity);
    const sessionId = String(args.sessionId || '').trim();
    if (!sessionId) throw Object.assign(new Error('缺少 sessionId'), { code: 'BAD_REQUEST' });
    const session = await getSession(sessionId);
    const allowed = session && (session.owner === user || (await memberSessionIds(user).catch(() => [])).includes(sessionId));
    if (!allowed) throw Object.assign(new Error('只能查看你自己的对话'), { code: 'FORBIDDEN' });
    const words = terms(args.query);
    const limit = Math.max(1, Math.min(Number(args.limit) || 20, 50));
    let rows = (await listMessages(sessionId)).filter((m) => m.role === 'user' || m.role === 'model');
    if (words.length) rows = rows.filter((m) => { const lower = String(m.content || '').toLowerCase(); return words.every((w) => lower.includes(w)); });
    const total = rows.length;
    const cursor = args.before ? rows.findIndex((m) => String(m.id) === String(args.before)) : rows.length;
    const end = cursor < 0 ? rows.length : cursor;
    const slice = rows.slice(Math.max(0, end - limit), end);
    let hasMore = end - limit > 0;
    let budget = PAGE_BUDGET;
    const messages = [];
    for (const m of [...slice].reverse()) {
        let text = redactText(String(m.content || ''), { secrets });
        const max = Math.max(200, Math.min(MESSAGE_CHARS, budget));
        if (text.length > max) text = `${text.slice(0, max)}…（已截断，共 ${text.length} 字）`;
        budget -= text.length;
        messages.unshift({ messageId: String(m.id), role: roleOf(m.role), at: iso(m.created_at), ...(m.author && m.author !== user ? { author: m.author } : {}), text });
        if (budget <= 0) { hasMore = true; break; }
    }
    return {
        sessionId,
        title: redactText(session.title || '', { secrets }),
        isCurrentConversation: sessionId === currentSessionId,
        ...(session.owner !== user ? { shared: true } : {}),
        totalMessages: total,
        messages,
        hasMore,
        before: hasMore && messages.length ? messages[0].messageId : null,
    };
}

const guarded = (fn, summarize) => async (args, ctx) => {
    try {
        const result = await fn(args && typeof args === 'object' ? args : {}, ctx?.identity, ctx?.secrets || [], ctx?.sessionId || '');
        return { ok: true, summary: summarize(result), content: JSON.stringify(result) };
    } catch (error) {
        return { ok: false, summary: String(error.message).slice(0, 60), content: `错误（${error.code || 'ERROR'}）：${error.message}` };
    }
};

export const HISTORY_TOOLS = [
    {
        name: 'search_my_conversations',
        description: '搜索当前用户自己的历史 AI 对话（自己发起的，以及已加入的共享对话）。用户问“我之前问过 / 聊过……”“上次那个结论是什么”“找一下以前关于 X 的对话”时用。query 为关键词（空格分隔，全部命中才算），不传则按最近更新列出会话；可用 since / until（YYYY-MM-DD）限定时间。返回会话 id、标题、时间和命中的片段，需要全文再用 read_my_conversation。',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '关键词，空格分隔；不传则列出最近的会话' },
                since: { type: 'string', description: '起始日期 YYYY-MM-DD，可选' },
                until: { type: 'string', description: '截止日期 YYYY-MM-DD（含当天），可选' },
                limit: { type: 'integer', description: '最多返回几个会话，默认 10，上限 30' },
                offset: { type: 'integer', description: '翻页偏移，默认 0' },
            },
        },
        run: guarded((args, identity, secrets) => searchMine(args, identity, secrets), (r) => (r.sessions.length ? `找到 ${r.sessions.length} 个对话${r.hasMore ? '（还有更多）' : ''}` : '没有找到')),
    },
    {
        name: 'read_my_conversation',
        description: '读取当前用户自己的某个历史对话的消息（问题与回答正文，不含工具细节）。sessionId 取自 search_my_conversations。默认返回最近 20 条；继续往前翻传上一页返回的 before；传 query 时只返回含关键词的消息。',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                query: { type: 'string', description: '只看含这些关键词的消息（空格分隔，全部命中），可选' },
                limit: { type: 'integer', description: '条数，默认 20，上限 50' },
                before: { type: 'string', description: '翻页游标：上一页返回的 before' },
            },
            required: ['sessionId'],
        },
        run: guarded(readMine, (r) => `${r.title || '对话'} · ${r.messages.length} 条${r.hasMore ? '（还有更早的）' : ''}`),
    },
];
