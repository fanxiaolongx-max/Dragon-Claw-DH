// 定时任务（/schedule）：到点以创建者身份让智能体执行一次指令，结果写进对话。
// 多实例与重启安全：执行前用“带旧 next_run_at 的条件更新”抢占，只有抢到的实例执行。
import crypto from 'node:crypto';
import { BusinessError, NotFoundError } from '../core/errors.js';
import { pushLog } from '../core/log-ring.js';
import { resolveAdmin } from '../core/access.js';
import { selectTable, insertRow, updateRows, sqlVal, parseJsonCol } from '../dao/scoped.js';
import * as parser from '../agent/schedule/parser.js';
import { runAgent } from '../agent/loop.js';
import { listProfiles, getSession, saveSession, appendMessage, getAutoSwitch } from './ai-service.js';

const MAX_ACTIVE_PER_USER = 20;
const RUN_TIMEOUT_MS = 5 * 60_000;
const TICK_MS = 30_000;
const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);

function toItem(row) {
    const item = {
        id: row.id,
        instruction: row.instruction || '',
        kind: row.kind,
        rule: parseJsonCol(row.rule_json, null),
        timezone: row.timezone || '',
        sessionId: row.session_id || '',
        status: row.status,
        nextRunAt: iso(row.next_run_at),
        lastRunAt: iso(row.last_run_at),
        lastStatus: row.last_status || '',
        lastError: row.last_error || '',
        lastReply: row.last_reply || '',
        targets: [],
        lastPush: null,
        runCount: Number(row.run_count) || 0,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
    };
    try { item.description = parser.describe(item); } catch { item.description = ''; }
    return item;
}

async function rowsOf(owner) {
    return selectTable('agent_schedules', {
        whereSql: `\`owner_id\` = ${sqlVal(owner)}`,
        orderBySql: '`updated_at` DESC',
        limit: 200,
        memFilter: (r) => r.owner_id === owner,
        memSort: (a, b) => (b.updated_at || 0) - (a.updated_at || 0),
    });
}

export async function listSchedules(owner, { since = '' } = {}) {
    const rows = await rowsOf(owner);
    const weekAgo = Date.now() - 7 * 86_400_000;
    const sinceMs = since ? Date.parse(since) : 0;
    const order = { running: 0, active: 1 };
    const items = (sinceMs
        ? rows.filter((r) => Number(r.last_run_at) > sinceMs).sort((a, b) => b.last_run_at - a.last_run_at).slice(0, 20)
        : rows.filter((r) => ['active', 'running'].includes(r.status) || Number(r.updated_at) > weekAgo)
            .sort((a, b) => ((order[a.status] ?? 2) - (order[b.status] ?? 2)) || ((a.status === 'active' ? Number(a.next_run_at) - Number(b.next_run_at) : 0)) || (b.updated_at - a.updated_at))
            .slice(0, 60)
    ).map(toItem);
    return { items, active: rows.filter((r) => ['active', 'running'].includes(r.status)).length, serverTime: new Date().toISOString() };
}

export async function createSchedule({ owner, text, sessionId = '', timezone = '', modelId = '' }) {
    if (!owner || owner === 'anonymous') throw new BusinessError('需要先登录数字人门户才能创建定时任务', 401);
    let parsed;
    try {
        parsed = parser.parse(String(text || '').replace(/^\s*\/schedule\s*/i, ''), { timezone: timezone || undefined });
    } catch (error) {
        throw new BusinessError(error.message || '没认出时间');
    }
    const rows = await rowsOf(owner);
    if (rows.filter((r) => r.status === 'active').length >= MAX_ACTIVE_PER_USER) throw new BusinessError(`最多同时保留 ${MAX_ACTIVE_PER_USER} 个定时任务，请先取消一些`);
    const next = parsed.kind === 'once' ? parsed.runAt : parser.nextRecurring(parsed.rule, new Date(), parsed.timezone);
    if (!next) throw new BusinessError('按这个规则找不到下一次执行时间');
    let sid = String(sessionId || '').slice(0, 120);
    if (sid) {
        const session = await getSession(sid).catch(() => null);
        if (!session || session.owner !== owner) sid = ''; // 只绑定本人的对话；否则到点时新开一段
    }
    const id = `dcs_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
    const now = Date.now();
    await insertRow('agent_schedules', {
        id,
        owner_id: owner,
        instruction: parsed.instruction.slice(0, 4000),
        kind: parsed.kind,
        rule_json: parsed.rule ? JSON.stringify(parsed.rule) : null,
        timezone: parsed.timezone || '',
        session_id: sid,
        model_id: String(modelId || '').slice(0, 120),
        status: 'active',
        next_run_at: next.getTime(),
        run_count: 0,
        created_at: now,
        updated_at: now,
    });
    return toItem((await rowsOf(owner)).find((r) => r.id === id));
}

export async function cancelSchedule(id, owner) {
    const row = (await rowsOf(owner)).find((r) => r.id === String(id));
    if (!row) throw new NotFoundError('定时任务不存在');
    if (row.status !== 'active') throw new BusinessError('该任务已结束，无需取消');
    await updateRows('agent_schedules', { status: 'cancelled', next_run_at: null, updated_at: Date.now() }, {
        whereSql: `\`id\` = ${sqlVal(row.id)} AND \`owner_id\` = ${sqlVal(owner)} AND \`status\` = 'active'`,
        memFilter: (r) => r.id === row.id && r.owner_id === owner && r.status === 'active',
    });
    return toItem({ ...row, status: 'cancelled', next_run_at: null, updated_at: Date.now() });
}

function contextNote(item, firedAt) {
    const when = firedAt.toLocaleString('zh-CN', { timeZone: item.timezone || undefined, hour12: false });
    return [
        `【定时任务】这条消息是用户之前用 /schedule 预约的指令，于 ${when}${item.timezone ? `（${item.timezone}）` : ''} 自动执行${item.kind === 'recurring' ? `（${item.description}）` : ''}。`,
        '用户此刻可能不在线，请直接完成指令并给出结果；如果指令是提醒，就用醒目的一句话提醒用户。不要反问确认，也不要再创建新的定时任务。',
    ].join('\n');
}

async function execute(row, firedAt) {
    const item = toItem(row);
    const next = row.kind === 'recurring' ? parser.nextRecurring(item.rule, firedAt, item.timezone) : null;
    // 抢占：只有把 next_run_at 从旧值改掉的那个实例才执行
    const claimed = await updateRows('agent_schedules', {
        next_run_at: next ? next.getTime() : null,
        status: row.kind === 'once' ? 'running' : 'active',
        updated_at: Date.now(),
    }, {
        whereSql: `\`id\` = ${sqlVal(row.id)} AND \`status\` = 'active' AND \`next_run_at\` = ${Number(row.next_run_at)}`,
        memFilter: (r) => r.id === row.id && r.status === 'active' && Number(r.next_run_at) === Number(row.next_run_at),
    });
    if (!claimed) return { skipped: true };

    let sessionId = item.sessionId;
    const finish = async (patch) => updateRows('agent_schedules', { ...patch, session_id: sessionId || '', last_run_at: Date.now(), run_count: (Number(row.run_count) || 0) + 1, updated_at: Date.now() }, {
        whereSql: `\`id\` = ${sqlVal(row.id)}`,
        memFilter: (r) => r.id === row.id,
    });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), RUN_TIMEOUT_MS);
    try {
        const profiles = await listProfiles();
        const settings = profiles.find((p) => p.id === row.model_id && p.apiKey) || profiles.find((p) => p.isActive) || profiles[0];
        if (!settings?.apiKey) throw new Error('还没有配置模型，定时任务无法执行');
        const identity = { username: row.owner_id, displayName: row.owner_id, identified: true, isAdmin: false, source: 'schedule' };
        identity.isAdmin = await resolveAdmin(identity).catch(() => false);
        if (sessionId) {
            const session = await getSession(sessionId).catch(() => null);
            if (!session || session.owner !== row.owner_id) sessionId = '';
        }
        if (!sessionId) {
            sessionId = (await saveSession({ ownerId: row.owner_id, title: `⏰ ${item.instruction.slice(0, 30)}`, metadata: { pagePath: '/', scheduleId: row.id } })).id;
        }
        await appendMessage(sessionId, 'user', `⏰ 定时任务：${item.instruction}`);
        const res = await runAgent({
            settings,
            identity,
            history: [{ role: 'user', content: `${contextNote(item, firedAt)}\n\n${item.instruction}` }],
            signal: abort.signal,
            profiles,
            autoSwitch: await getAutoSwitch(),
            secrets: profiles.map((p) => p.apiKey).filter(Boolean),
            unattended: true,
        });
        await appendMessage(sessionId, 'model', res.text, { modelName: res.model?.model || settings.model, ...(res.events.length ? { events: res.events } : {}) });
        await finish({ last_status: 'ok', last_error: '', last_reply: res.text.slice(0, 600), status: row.kind === 'once' ? 'done' : 'active' });
        pushLog({ level: 'INFO', category: 'SCHEDULE', userId: row.owner_id, message: `定时任务 ${row.id} 执行完成` });
        return { ran: true };
    } catch (error) {
        const message = abort.signal.aborted ? '执行超时（5 分钟）' : String(error.message || error);
        await finish({ last_status: 'failed', last_error: message.slice(0, 500), status: row.kind === 'once' ? 'failed' : 'active' }).catch(() => {});
        pushLog({ level: 'WARN', category: 'SCHEDULE', userId: row.owner_id, message: `定时任务 ${row.id} 执行失败：${message}` });
        return { failed: true, error: message };
    } finally {
        clearTimeout(timer);
    }
}

/** 执行所有到期的任务（每次最多 5 个，避免一次占用太久） */
export async function runDueSchedules(now = new Date()) {
    const due = await selectTable('agent_schedules', {
        whereSql: `\`status\` = 'active' AND \`next_run_at\` IS NOT NULL AND \`next_run_at\` <= ${now.getTime()}`,
        orderBySql: '`next_run_at` ASC',
        limit: 5,
        memFilter: (r) => r.status === 'active' && r.next_run_at != null && Number(r.next_run_at) <= now.getTime(),
        memSort: (a, b) => a.next_run_at - b.next_run_at,
    });
    const results = [];
    for (const row of due) results.push(await execute(row, now));
    return results;
}

let timer = null;
let running = false;
let lastErrorLogAt = 0;
export function startScheduler() {
    if (timer) return;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await runDueSchedules();
        } catch (error) {
            // 基座不可用时每 10 分钟最多记一条，避免刷屏
            if (Date.now() - lastErrorLogAt > 600_000) {
                lastErrorLogAt = Date.now();
                pushLog({ level: 'WARN', category: 'SCHEDULE', message: `检查到期的定时任务失败：${error.message}` });
            }
        } finally {
            running = false;
        }
    };
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
    setTimeout(tick, 10_000).unref?.();
}
export function stopScheduler() {
    if (timer) clearInterval(timer);
    timer = null;
}
