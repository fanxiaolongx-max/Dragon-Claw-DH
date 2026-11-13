// 消息中心的 AI 一句话摘要：警告及以上的消息入库后，在后台让模型用一句话说清「出了什么事、影响什么、要不要处理」，
// 写回消息的 ai_summary（前端的消息列表已经会优先显示它）。做法沿用主线版 models/alert-ai-analyzer.js：
//   - 限流：每分钟最多 3 次、每小时最多 30 次，排队最多 300 条；
//   - 模型没配置、调用失败或写得不如原文清楚时，不写摘要，界面照常显示原文；
//   - 只在进程内排队，重启后未处理的不补（消息本身不受影响）。
// 基座 Web 版的消息是每人一份，同一条消息发给多人时用 group_id 关联，摘要一次生成、各份一起写回。
import { pushLog } from '../core/log-ring.js';
import { redactText } from '../agent/redact.js';
import { kvGet, kvSet } from '../dao/scoped.js';

export const ALERT_AI_COUNT_KEY = 'alert_ai_analyzed_count';

const MAX_PER_MINUTE = 3;
const MAX_PER_HOUR = 30;
const MAX_QUEUE = 300;
const ANALYZE = new Set(['warn', 'error', 'critical']);
const queue = [];
const hits = [];
let processing = false;
let hooks = null;

/** 由 alert-service 注册读写函数（避免两个模块互相引用） */
export function registerAlertStore(store) { hooks = store; }

function rateDelay(now = Date.now()) {
    while (hits.length && hits[0] <= now - 3_600_000) hits.shift();
    const lastMinute = hits.filter((t) => t > now - 60_000);
    if (lastMinute.length >= MAX_PER_MINUTE) return lastMinute[0] + 60_000 - now + 500;
    if (hits.length >= MAX_PER_HOUR) return hits[0] + 3_600_000 - now + 500;
    return 0;
}

const clean = (text) => String(text || '').replace(/^```(?:text|markdown)?\s*/i, '').replace(/\s*```$/i, '').replace(/\s+/g, ' ').trim().slice(0, 180);
// 太短、像代码、只有一个词的回答不如原文
const weak = (text) => !text || text.length < 8 || /[`{}[\]]/.test(text) || /^(admin|管理员|system|系统)$/i.test(text);

export function enqueueAlertAnalysis(event, users) {
    if (!event?.group_id || !ANALYZE.has(event.severity) || !users.length) return false;
    if (queue.some((item) => item.event.group_id === event.group_id)) return false;
    if (queue.length >= MAX_QUEUE) return false;
    queue.push({ event, users });
    setTimeout(processQueue, 100).unref?.();
    return true;
}

async function summarize(event) {
    const { callAiCompletion } = await import('./ai-service.js');
    const prompt = `你是 Dragon Claw 消息中心的值班分析助手。根据下面这条站内消息，用中文写一句话总结，最多 55 个汉字。
要求：直接说出了什么事、影响什么、需不需要人处理；不要寒暄、不要项目符号；不要复述口令、令牌或长段原文。
如果写不出比标题更清楚的话，就只输出标题。

标题：${event.title}
级别：${event.severity}
类型：${event.event_type}
来源：${event.actor || ''} ${event.object_type || ''} ${event.object_id || ''}
内容：
${redactText(String(event.message || '')).slice(0, 2000)}
${event.detail ? `详情：${redactText(JSON.stringify(event.detail)).slice(0, 2000)}` : ''}`;
    const out = await callAiCompletion({ messages: [{ role: 'user', content: prompt }], maxTokens: 120 });
    if (!out.ok) throw new Error(out.error || '模型调用失败');
    return clean(out.text);
}

async function processQueue() {
    if (processing || !hooks) return;
    processing = true;
    try {
        while (queue.length) {
            const delay = rateDelay();
            if (delay > 0) {
                setTimeout(processQueue, delay).unref?.();
                return;
            }
            const { event, users } = queue.shift();
            hits.push(Date.now());
            let summary = '';
            try {
                summary = await summarize(event);
            } catch (error) {
                pushLog({ level: 'WARN', category: 'ALERT', message: `消息 AI 摘要失败，界面显示原文：${error.message}` });
                continue;
            }
            if (weak(summary) || summary === event.title) continue;
            for (const user of users) {
                await hooks.update(user, event.group_id, { ai_summary: summary, ai_status: 'done', ai_analyzed_at: new Date().toISOString() }).catch(() => {});
            }
            // 首页效能看板的「AI 分析告警」计数
            await kvSet(ALERT_AI_COUNT_KEY, (Number(await kvGet(ALERT_AI_COUNT_KEY, 0).catch(() => 0)) || 0) + 1).catch(() => {});
        }
    } finally {
        processing = false;
    }
}

/** 测试用：等队列处理完 */
export async function drainAlertAnalysis() {
    for (let i = 0; i < 100 && (queue.length || processing); i += 1) {
        await processQueue();
        await new Promise((r) => setTimeout(r, 20));
    }
}
export const alertAnalysisQueueLength = () => queue.length;
