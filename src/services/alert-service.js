// 消息中心：给个人或全体管理员留一条站内消息（定时任务结果、对话里执行的写操作、模型故障、权限变更）。
// 每人一份，存键值表 alerts:<工号>，最多保留 200 条；读改写不是原子的，并发下偶尔少一条，可以接受。
import crypto from 'node:crypto';
import { kvGet, kvSet } from '../dao/scoped.js';
import { listAdmins } from '../core/access.js';
import { pushLog } from '../core/log-ring.js';
import { enqueueAlertAnalysis, registerAlertStore } from './alert-ai-service.js';

const MAX_ITEMS = 200;
const DEDUPE_MS = 10 * 60 * 1000;
const TYPES = new Set(['system', 'config', 'security', 'user_action']);
const SEVERITIES = new Set(['info', 'warn', 'error', 'critical']);
const keyOf = (user) => `alerts:${String(user || '').trim().toLowerCase()}`;
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

async function load(user) {
    const stored = await kvGet(keyOf(user), null);
    return Array.isArray(stored?.items) ? stored.items : [];
}
const save = (user, items) => kvSet(keyOf(user), { items: items.slice(0, MAX_ITEMS) });

function buildEvent(input) {
    return {
        id: crypto.randomUUID(),
        event_type: TYPES.has(input.type) ? input.type : 'system',
        severity: SEVERITIES.has(input.severity) ? input.severity : 'info',
        title: clip(input.title, 120),
        message: clip(input.message, 1200),
        source: clip(input.source, 200),
        actor: clip(input.actor, 80),
        object_type: clip(input.objectType, 40),
        object_id: clip(input.objectId, 80),
        detail: input.detail && typeof input.detail === 'object' ? input.detail : null,
        // 同一条消息发给多人时各存一份，用它关联（AI 摘要一次生成、各份一起写回）
        group_id: crypto.randomUUID(),
        status: 'unread',
        created_at: new Date().toISOString(),
    };
}

/** 给一个或多个用户留言。失败只记日志，不影响主流程。 */
export async function pushAlert(users, input) {
    const targets = [...new Set((Array.isArray(users) ? users : [users]).map((u) => String(u || '').trim().toLowerCase()).filter((u) => u && u !== 'anonymous'))];
    const event = buildEvent(input || {});
    if (!event.title) return 0;
    let sent = 0;
    const delivered = [];
    for (const user of targets) {
        try {
            const items = await load(user);
            // 同一标题 10 分钟内不重复提醒（模型连续失败、任务反复报同一个错）
            const dup = items.find((x) => x.title === event.title && x.status === 'unread' && Date.now() - Date.parse(x.created_at) < DEDUPE_MS);
            if (dup) continue;
            await save(user, [{ ...event, id: crypto.randomUUID() }, ...items]);
            sent += 1;
            delivered.push(user);
        } catch (error) {
            pushLog({ level: 'WARN', category: 'ALERT', message: `消息写入失败：${error.message}`, userId: user });
        }
    }
    enqueueAlertAnalysis(event, delivered);
    return sent;
}

/** 按 group_id 改某人的那一份消息（AI 摘要写回用） */
async function updateByGroup(user, groupId, patch) {
    const items = await load(user);
    const item = items.find((x) => x.group_id === groupId);
    if (!item) return false;
    Object.assign(item, patch);
    await save(user, items);
    return true;
}
registerAlertStore({ update: updateByGroup });

export async function pushAdminAlert(input) {
    try {
        const { env, stored } = await listAdmins();
        return await pushAlert([...env, ...stored], input);
    } catch {
        return 0;
    }
}

export async function listAlerts(user, { status = '', type = '', limit = 120 } = {}) {
    let items = await load(user);
    if (status === 'unread') items = items.filter((x) => x.status === 'unread');
    if (TYPES.has(type)) items = items.filter((x) => x.event_type === type);
    return { events: items.slice(0, Math.min(Math.max(Number(limit) || 120, 1), MAX_ITEMS)) };
}

export async function alertSummary(user) {
    const items = await load(user);
    const unread = items.filter((x) => x.status === 'unread');
    const count = (list, pick) => list.reduce((acc, x) => { acc[pick(x)] = (acc[pick(x)] || 0) + 1; return acc; }, {});
    return {
        total: items.length,
        unread: unread.length,
        critical: unread.filter((x) => x.severity === 'critical').length,
        warnOrAbove: unread.filter((x) => ['warn', 'error', 'critical'].includes(x.severity)).length,
        byType: count(unread, (x) => x.event_type),
        bySeverity: count(unread, (x) => x.severity),
    };
}

export async function markAlertsRead(user, ids = null) {
    const items = await load(user);
    const wanted = Array.isArray(ids) ? new Set(ids.map(String)) : null;
    let changed = 0;
    for (const item of items) {
        if (item.status === 'unread' && (!wanted || wanted.has(item.id))) { item.status = 'read'; changed += 1; }
    }
    if (changed) await save(user, items);
    return { success: true, changed };
}

export async function removeAlerts(user, id = null) {
    const items = await load(user);
    const next = id ? items.filter((x) => x.id !== String(id)) : [];
    if (next.length !== items.length) await save(user, next);
    return { success: true, removed: items.length - next.length };
}

/** 补做 AI 摘要：本人还没有摘要的警告及以上消息重新排队（最多 limit 条） */
export async function backfillAlertSummaries(user, { limit = 50 } = {}) {
    const items = await load(user);
    let queued = 0;
    for (const item of items) {
        if (queued >= limit) break;
        if (item.ai_summary) continue;
        if (!item.group_id) { item.group_id = crypto.randomUUID(); await save(user, items); }
        if (enqueueAlertAnalysis(item, [user])) queued += 1;
    }
    return { success: true, queued };
}
