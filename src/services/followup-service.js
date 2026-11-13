// 跟进任务：用户在对话里说「记一下 / 帮我跟进 / 提醒我」时，智能体用 followup_* 工具保存任务，平台按频率提醒。
// 移植自主线版的频道跟进任务（models/channels/channel-followups-repository.js）。基座 Web 版没有微信 / WeLink 频道，所以：
//   - 任务属于在对话里创建它的人（owner），只有本人能看、能改、能关；
//   - 到点后提醒发到消息中心：发给创建人，以及相关人里填了平台工号的人；
//   - 提醒时间规则（埃及工作日、按紧急度的间隔、紧急任务可在非工作日提醒）与主线版一致，见 agent/schedule/followup-schedule.js。
// 任务存统一记录表：分组列 = 创建人，周期列 = 状态，排序键 = 下次提醒时间（到期扫描时不用读正文）。
import crypto from 'node:crypto';
import { listRecords, getRecord, putRecord } from './record-store.js';
import { pushAlert } from './alert-service.js';
import { pushLog } from '../core/log-ring.js';
import * as schedule from '../agent/schedule/followup-schedule.js';

const KIND = 'followup';
const STATUSES = ['open', 'paused', 'done', 'cancelled'];
const URGENCY_LABEL = { low: '低', normal: '普通', high: '高', urgent: '紧急' };
const STATUS_LABEL = { open: '跟进中', paused: '已暂停', done: '已完成', cancelled: '已取消' };
const DEFAULT_MAX_REMINDERS = 30;
const MAX_ASSIGNEES = 10;
const calendar = schedule.DEFAULT_CALENDAR;
const clip = (value, max) => String(value ?? '').trim().slice(0, max);
const fail = (message, code = 'FOLLOWUP_ERROR') => Object.assign(new Error(message), { code });

function normalizeAssignees(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list : [])
        .map((item) => (typeof item === 'string' ? { name: item } : item || {}))
        .map((item) => ({ name: clip(item.name, 60).replace(/^@+/, ''), account: clip(item.account, 80) }))
        .filter((item) => item.name || item.account)
        .filter((item) => {
            const key = (item.account || item.name).toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, MAX_ASSIGNEES);
}

function normalizeSchedule(input = {}, current = {}) {
    const urgency = schedule.URGENCIES.includes(input.urgency) ? input.urgency : (current.urgency || 'normal');
    const scheduleMode = schedule.MODES.includes(input.scheduleMode) ? input.scheduleMode : (current.scheduleMode || 'auto');
    const int = (value, fallback) => (value === undefined ? fallback : (Number(value) > 0 ? Math.round(Number(value)) : null));
    const intervalMinutes = int(input.intervalMinutes, current.intervalMinutes ?? null);
    const allowOffHours = input.allowOffHours === undefined ? (current.allowOffHours ?? null) : (input.allowOffHours == null ? null : Boolean(input.allowOffHours));
    return {
        urgency,
        scheduleMode: scheduleMode === 'interval' && !intervalMinutes ? 'auto' : scheduleMode,
        intervalMinutes: intervalMinutes ? Math.min(Math.max(intervalMinutes, 15), 60 * 24 * 30) : null,
        randomMinMinutes: int(input.randomMinMinutes, current.randomMinMinutes ?? null),
        randomMaxMinutes: int(input.randomMaxMinutes, current.randomMaxMinutes ?? null),
        allowOffHours,
    };
}

// 「2026-11-14 15:00」这种没带时区的按工作日历的时区理解
function parseDate(value) {
    if (!value) return null;
    const str = String(value).trim();
    const naive = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2})?$/.exec(str);
    if (naive) {
        const [, y, m, d, hh, mm] = naive;
        return schedule.fromZone(Number(y), Number(m), Number(d), Number(hh) * 60 + Number(mm), calendar.timezone).toISOString();
    }
    const date = new Date(str);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function parseFuture(value, from = new Date()) {
    const iso = parseDate(value);
    return iso && new Date(iso) > from ? new Date(iso) : null;
}
function firstReminder(input, plan, from = new Date()) {
    const inMinutes = Number(input.inMinutes);
    if (Number.isFinite(inMinutes) && inMinutes > 0) return new Date(from.getTime() + Math.round(inMinutes) * 60000);
    return parseFuture(input.firstRemindAt || input.nextRemindAt, from) || schedule.nextReminder(plan, from, calendar);
}

const describe = (task) => ({ ...task, frequency: schedule.describeInterval(task) });
async function store(task) {
    await putRecord(KIND, {
        id: task.id, group: task.owner, name: task.title, period: task.status,
        // 排序键 = 下次提醒时间；没有下次提醒的排在最后
        sortKey: task.status === 'open' && task.nextRemindAt ? task.nextRemindAt : '9999',
        payload: task, updatedBy: task.owner, createdAt: Date.parse(task.createdAt) || 0,
    });
    return describe(task);
}
function addEvent(task, type, actor, note = '') {
    task.events = [...(task.events || []), { type, actor, note: clip(note, 1000), at: new Date().toISOString() }].slice(-50);
}

export async function getFollowup(id) {
    const record = /^fu_[0-9a-f]{16}$/.test(String(id || '')) ? await getRecord(KIND, String(id)) : null;
    return record ? describe(record.payload) : null;
}
async function ownTask(id, owner) {
    const task = await getFollowup(id);
    if (!task || task.owner !== owner) throw fail(`你的跟进任务里没有 ${id}`, 'FOLLOWUP_NOT_FOUND');
    return task;
}

export async function listFollowups(owner, { includeClosed = false, limit = 50 } = {}) {
    const records = await listRecords(KIND, { group: owner, withPayload: true, limit: 500 });
    const order = { open: 0, paused: 1, done: 2, cancelled: 3 };
    return records.map((r) => describe(r.payload))
        .filter((t) => includeClosed || t.status === 'open' || t.status === 'paused')
        .sort((a, b) => order[a.status] - order[b.status] || String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit);
}

export async function createFollowup(input, owner) {
    const title = clip(input.title, 200);
    if (!title) throw fail('跟进任务需要标题', 'FOLLOWUP_TITLE_REQUIRED');
    const existing = (await listFollowups(owner)).find((t) => t.title === title);
    if (existing) return { task: existing, existed: true };
    const plan = normalizeSchedule(input);
    const now = new Date();
    const task = {
        id: `fu_${crypto.randomBytes(8).toString('hex')}`, owner, title, detail: clip(input.detail, 6000),
        assignees: normalizeAssignees(input.assignees), ...plan,
        nextRemindAt: firstReminder(input, plan, now).toISOString(), nextRemindNote: clip(input.nextRemindNote, 500),
        dueAt: parseDate(input.dueAt), progress: '', status: 'open', remindCount: 0,
        maxReminders: Number.isInteger(Number(input.maxReminders)) && Number(input.maxReminders) > 0 ? Math.min(Number(input.maxReminders), 500) : DEFAULT_MAX_REMINDERS,
        createdAt: now.toISOString(), updatedAt: now.toISOString(), events: [],
    };
    addEvent(task, 'created', owner, title);
    return { task: await store(task), existed: false };
}

export async function updateFollowup(id, patch, owner) {
    const task = await ownTask(id, owner);
    const changed = [];
    if (patch.title !== undefined && clip(patch.title, 200)) { task.title = clip(patch.title, 200); changed.push('标题'); }
    if (patch.detail !== undefined) { task.detail = clip(patch.detail, 6000); changed.push('详情'); }
    if (patch.assignees !== undefined) { task.assignees = normalizeAssignees(patch.assignees); changed.push('相关人'); }
    if (patch.nextRemindNote !== undefined) task.nextRemindNote = clip(patch.nextRemindNote, 500);
    if (patch.dueAt !== undefined) { task.dueAt = parseDate(patch.dueAt); changed.push('截止时间'); }
    if (patch.progress !== undefined && clip(patch.progress, 2000)) task.progress = clip(patch.progress, 2000);
    if (['urgency', 'scheduleMode', 'intervalMinutes', 'randomMinMinutes', 'randomMaxMinutes', 'allowOffHours'].some((k) => patch[k] !== undefined)) {
        Object.assign(task, normalizeSchedule(patch, task));
        if (task.status === 'open') task.nextRemindAt = schedule.nextReminder(task, new Date(), calendar).toISOString();
        changed.push('频率');
    }
    // 先处理暂停 / 恢复，再应用用户指定的提醒时间（恢复时同时说了「1 分钟后提醒」以后者为准）
    if (patch.pause === true && task.status === 'open') { task.status = 'paused'; task.nextRemindAt = null; changed.push('暂停'); }
    if (patch.pause === false && task.status === 'paused') { task.status = 'open'; task.nextRemindAt = schedule.nextReminder(task, new Date(), calendar).toISOString(); changed.push('恢复'); }
    if (task.status === 'open' && (Number(patch.inMinutes) > 0 || parseFuture(patch.nextRemindAt))) {
        task.nextRemindAt = firstReminder({ inMinutes: patch.inMinutes, firstRemindAt: patch.nextRemindAt }, task).toISOString();
        changed.push('下次提醒');
    }
    task.updatedAt = new Date().toISOString();
    addEvent(task, patch.progress && !changed.length ? 'progress' : 'updated', owner, patch.progress ? `进度：${clip(patch.progress, 300)}` : `更新了${changed.join('、') || '任务'}`);
    return store(task);
}

export async function closeFollowup(id, { status = 'done', note = '' } = {}, owner) {
    const task = await ownTask(id, owner);
    task.status = status === 'cancelled' ? 'cancelled' : 'done';
    Object.assign(task, { nextRemindAt: null, closedAt: new Date().toISOString(), closeNote: clip(note, 2000), updatedAt: new Date().toISOString() });
    addEvent(task, task.status, owner, note);
    return store(task);
}

// ── 到期提醒（由定时任务的调度器顺带调用）──
const assigneeText = (list) => (list || []).map((a) => `${a.name || a.account}${a.account && a.name ? `(${a.account})` : ''}`).join('、') || '未指定';
export function reminderText(task) {
    const lines = [`第 ${task.remindCount} 次提醒 · 紧急度 ${URGENCY_LABEL[task.urgency] || task.urgency} · 相关人 ${assigneeText(task.assignees)}`];
    if (task.nextRemindNote) lines.push(`本次要跟进：${task.nextRemindNote}`);
    if (task.progress) lines.push(`上次进展：${task.progress}`);
    if (task.dueAt) lines.push(`截止：${schedule.describeNow(new Date(task.dueAt), calendar)}`);
    lines.push('在对话里说「某某任务完成了」或「暂停跟进」即可更新。');
    return lines.join('\n');
}

/** 把到期的跟进任务提醒发到消息中心，并推算下一次提醒；每次最多处理 20 个 */
export async function remindDueFollowups(now = new Date()) {
    const nowIso = now.toISOString();
    // 排序键是下次提醒时间：升序取最前面的就是最早到期的
    const due = (await listRecords(KIND, { limit: 1000 }))
        .filter((r) => r.period === 'open' && r.sortKey && r.sortKey !== '9999' && r.sortKey <= nowIso)
        .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
        .slice(0, 20);
    let sent = 0;
    for (const meta of due) {
        const record = await getRecord(KIND, meta.id);
        const task = record?.payload;
        if (!task || task.status !== 'open' || task.nextRemindAt !== meta.sortKey) continue; // 别的实例已经处理过
        task.remindCount += 1;
        task.lastRemindedAt = nowIso;
        const limitReached = task.remindCount >= task.maxReminders;
        const targets = [task.owner, ...task.assignees.map((a) => a.account).filter(Boolean)];
        await pushAlert(targets, {
            type: 'user_action', severity: task.urgency === 'urgent' ? 'warn' : 'info',
            title: `跟进提醒：${task.title}`, message: reminderText(task), actor: 'followup', objectType: 'followup', objectId: task.id,
        });
        addEvent(task, 'reminded', 'system', `第 ${task.remindCount} 次提醒已发到消息中心`);
        if (limitReached) {
            Object.assign(task, { status: 'paused', nextRemindAt: null });
            addEvent(task, 'limit', 'system', `已达到提醒上限（${task.remindCount} 次），自动暂停；在对话里说「恢复跟进」即可继续`);
        } else {
            task.nextRemindAt = schedule.nextReminder(task, now, calendar).toISOString();
        }
        task.updatedAt = nowIso;
        await store(task);
        sent += 1;
    }
    if (sent) pushLog({ level: 'INFO', category: 'FOLLOWUP', message: `发出 ${sent} 条跟进提醒` });
    return sent;
}

// ── 给模型看的文字 ──
export function taskSummary(task) {
    return {
        id: task.id, title: task.title, status: STATUS_LABEL[task.status], urgency: URGENCY_LABEL[task.urgency], assignees: assigneeText(task.assignees),
        frequency: task.frequency, nextRemindAt: task.status === 'open' && task.nextRemindAt ? schedule.describeNow(new Date(task.nextRemindAt), calendar) : null,
        nextRemindNote: task.nextRemindNote || null, progress: task.progress || null, remindCount: task.remindCount,
    };
}

export async function followupPrompt(owner) {
    const tasks = await listFollowups(owner, { limit: 20 }).catch(() => []);
    const now = new Date();
    return [
        `当前时间：${schedule.describeNow(now, calendar)}；ISO 参考：${schedule.formatZoneIso(now, calendar.timezone)}。工作日历：周日至周四 ${calendar.workStart}–${calendar.workEnd}；紧急任务也会在周五 / 周六 ${calendar.urgentStart}–${calendar.urgentEnd} 提醒。`,
        '用户说「记一下 / 帮我跟进 / 提醒我 / 遗留任务」时必须调用 followup_create 真正保存，不要只在回复里写「已记录」。相对时长（「2 小时后」）填 inMinutes；没说频率时按紧急度（scheduleMode=auto）。',
        '提醒会出现在用户的消息中心（左下角铃铛）；相关人填了平台工号的也会收到。不要承诺通过邮件、微信或 WeLink 提醒。',
        '用户汇报进展用 followup_update 记 progress；说完成或不用跟了用 followup_close。有多个任务而用户没说是哪个时先问。',
        tasks.length ? `这位用户进行中的跟进任务：\n${tasks.map((t) => `- [${t.id}] ${t.title}｜${STATUS_LABEL[t.status]}｜${t.frequency}｜下次提醒 ${t.nextRemindAt ? schedule.describeNow(new Date(t.nextRemindAt), calendar) : '—'}`).join('\n')}` : '这位用户目前没有进行中的跟进任务。',
    ].join('\n');
}
