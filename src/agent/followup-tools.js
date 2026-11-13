// 跟进任务工具：参数与主线版频道跟进工具（models/channels/followup-agent.js）一致，只作用于当前用户自己的任务。
import { createFollowup, listFollowups, updateFollowup, closeFollowup, taskSummary } from '../services/followup-service.js';

const ASSIGNEES = {
    type: 'array',
    description: '任务相关人：从消息里提取姓名与工号（如「刘一然 00964704」→ name=刘一然, account=00964704）。填了平台工号的人也会在消息中心收到提醒。',
    items: { type: 'object', properties: { name: { type: 'string' }, account: { type: 'string' } } },
};
const SCHEDULE = {
    urgency: { type: 'string', description: '紧急度 low | normal | high | urgent。没说时按内容判断：影响生产 / 客户、当天必须完成 → urgent；本周内 → high；一般 → normal' },
    scheduleMode: { type: 'string', description: 'auto（默认，按紧急度：紧急每 2 小时、高每天、普通每 2 个工作日、低每 5 个工作日）| interval（固定间隔，需 intervalMinutes）| random（随机间隔）' },
    intervalMinutes: { type: 'integer', description: 'interval 模式的间隔分钟数，例如每天 = 1440' },
    randomMinMinutes: { type: 'integer' },
    randomMaxMinutes: { type: 'integer' },
    allowOffHours: { type: 'boolean', description: '是否允许在非工作日（周五、周六）提醒；紧急任务默认允许' },
    inMinutes: { type: 'integer', description: '多少分钟后首次 / 下次提醒（用户说「2 小时后」填 120）。有相对时长时优先用它' },
    nextRemindAt: { type: 'string', description: '用户指定了具体时刻时填 ISO 8601 时间（带时区偏移）' },
    nextRemindNote: { type: 'string', description: '下次提醒时要跟进的内容，一句话' },
};

const guarded = (fn) => async (args, ctx) => {
    try {
        return await fn(args && typeof args === 'object' ? args : {}, ctx.identity.username);
    } catch (error) {
        return { ok: false, summary: String(error.message).slice(0, 60), content: `错误（${error.code || 'ERROR'}）：${error.message}` };
    }
};
const result = (task, summary, note) => ({ ok: true, summary, content: JSON.stringify({ ok: true, task: taskSummary(task), ...(note ? { note } : {}) }) });

export const FOLLOWUP_TOOLS = [
    {
        name: 'followup_create',
        description: '记录一个需要持续跟进的任务，平台按频率把提醒发到消息中心。用户说「记一下」「帮我跟进」「提醒我」时调用。同名的进行中任务不会重复创建。',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '任务标题，简短明确' },
                detail: { type: 'string', description: '任务详情与要点（Markdown）' },
                assignees: ASSIGNEES,
                dueAt: { type: 'string', description: '截止时间（ISO 8601），没有则省略' },
                ...SCHEDULE,
            },
            required: ['title'],
        },
        run: guarded(async (args, owner) => {
            const { task, existed } = await createFollowup(args, owner);
            return existed ? result(task, `已存在：${task.title}`, '同名任务已存在，未重复创建；如需修改请用 followup_update') : result(task, `已创建：${task.title}`);
        }),
    },
    {
        name: 'followup_list',
        description: '列出当前用户的跟进任务及最近记录。用户问「有哪些待跟进」「进度怎样」时调用。',
        parameters: { type: 'object', properties: { includeClosed: { type: 'boolean', description: '是否包含已完成 / 已取消的任务' } } },
        run: guarded(async (args, owner) => {
            const tasks = await listFollowups(owner, { includeClosed: args.includeClosed === true, limit: 30 });
            const detailed = tasks.slice(0, 10).map((t) => ({ ...taskSummary(t), detail: t.detail.slice(0, 600), recent: (t.events || []).slice(-5).map((e) => `${e.at.slice(0, 16).replace('T', ' ')} ${e.type} ${e.note}`.slice(0, 200)) }));
            return { ok: true, summary: `${tasks.length} 个任务`, content: JSON.stringify({ ok: true, count: tasks.length, tasks: detailed }) };
        }),
    },
    {
        name: 'followup_update',
        description: '更新一个跟进任务：记录进度、改相关人、频率、紧急度、下次提醒时间或内容，暂停（pause=true）或恢复（pause=false）提醒。用户汇报进展但还没完成时调用（填 progress）。',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: '任务 ID（见系统提示里的任务列表）' },
                progress: { type: 'string', description: '本次进展' },
                title: { type: 'string' },
                detail: { type: 'string' },
                assignees: ASSIGNEES,
                dueAt: { type: 'string' },
                pause: { type: 'boolean', description: 'true 暂停提醒，false 恢复提醒' },
                ...SCHEDULE,
            },
            required: ['id'],
        },
        run: guarded(async ({ id, ...patch }, owner) => {
            const task = await updateFollowup(id, patch, owner);
            return result(task, `已更新：${task.title}`);
        }),
    },
    {
        name: 'followup_close',
        description: '关闭一个跟进任务：已完成（status=done）或不再需要（status=cancelled）。用户说「完成了」「搞定」「不用跟了」时调用。',
        parameters: {
            type: 'object',
            properties: { id: { type: 'string' }, status: { type: 'string', description: 'done 或 cancelled，默认 done' }, note: { type: 'string', description: '关闭说明' } },
            required: ['id'],
        },
        run: guarded(async (args, owner) => {
            const task = await closeFollowup(args.id, { status: args.status, note: args.note }, owner);
            return result(task, `已${task.status === 'done' ? '完成' : '取消'}：${task.title}`);
        }),
    },
];
