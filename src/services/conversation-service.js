// 长对话的上下文管理：较早的消息压缩成摘要（存在会话的 summary 字段），新对话用模型起标题。
import { pushLog } from '../core/log-ring.js';
import { getSession, saveSession, listMessages, callAiCompletion } from './ai-service.js';

// 粗估 token：中文大约 1 字 1 token，英文约 4 字符 1 token，这里按 1 字符 0.6 token 偏保守估算
export const estimateTokens = (text) => Math.ceil(String(text || '').length * 0.6);
const SUMMARY_EVERY = 6; // 窗口外累计 6 条未压缩的消息再压一次，避免每轮都多调一次模型
const clip = (t, n) => (t.length > n ? `${t.slice(0, n)}…` : t);

async function summarize({ settings, previous, messages }) {
    const transcript = messages.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${clip(String(m.content || ''), 3000)}`).join('\n\n').slice(-40_000);
    const res = await callAiCompletion({
        profileId: settings.id,
        maxTokens: 1200,
        messages: [
            { role: 'system', content: '你负责压缩对话记录。把下面的对话整理成要点摘要，供后续对话继续使用。必须保留：用户的目标和要求、已经确认的事实与数字（原样保留精度）、做过的决定、生成过的文件或工具名称、还没完成的事项、用户表达过的偏好。去掉寒暄和重复内容。用简体中文分条列出，不超过 800 字。只输出摘要。' },
            { role: 'user', content: `${previous ? `【已有摘要】\n${previous}\n\n` : ''}【需要并入摘要的对话】\n${transcript}` },
        ],
    });
    if (!res.ok || !String(res.text || '').trim()) throw new Error(res.error || '模型没有返回摘要');
    return String(res.text).trim();
}

/**
 * 根据会话的存储记录与前端带来的最近若干条消息，算出本轮要给模型的上下文：
 *   - 前端窗口之外、还没压缩的旧消息：不多时原样带上；攒够一批就压缩进摘要
 *   - 前端窗口本身超出预算时，从最早的开始挪出去（它们同样进入摘要）
 */
export async function prepareContext({ sessionId, history, settings, emit }) {
    const session = sessionId ? await getSession(sessionId) : null;
    if (!session) return { history, summary: '' };
    const budget = Math.floor((Number(settings.contextWindowTokens) || 64000) * 0.55);
    let kept = [...history];
    while (kept.length > 1 && estimateTokens(kept.map((m) => m.content).join('')) > budget) kept.shift();

    const stored = await listMessages(sessionId);
    const older = stored.slice(0, Math.max(0, stored.length - kept.length)).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content || '') }));
    const meta = session.metadata || {};
    const done = Math.min(Number(meta.summarizedCount) || 0, older.length);
    let summary = String(session.summary || '');
    let pending = older.slice(done);

    const pendingTokens = estimateTokens(pending.map((m) => m.content).join(''));
    const keptTokens = estimateTokens(kept.map((m) => m.content).join(''));
    if (pending.length >= SUMMARY_EVERY || (pending.length && pendingTokens + keptTokens > budget)) {
        const beforeTokens = estimateTokens(summary) + pendingTokens + keptTokens;
        emit({ type: 'compaction', phase: 'start' });
        try {
            summary = await summarize({ settings, previous: summary, messages: pending });
            await saveSession({ id: sessionId, summary, metadata: { ...meta, summarizedCount: older.length } });
            emit({ type: 'compaction', phase: 'done', summarized: pending.length, beforeTokens, afterTokens: estimateTokens(summary) + keptTokens });
            pending = [];
        } catch (error) {
            emit({ type: 'compaction', phase: 'failed', error: String(error.message).slice(0, 120) });
            pushLog({ level: 'WARN', category: 'AI', message: `对话压缩失败：${error.message}` });
            // 压缩失败：尽量原样带上能放下的旧消息
            while (pending.length && estimateTokens(pending.map((m) => m.content).join('')) + keptTokens > budget) pending.shift();
        }
    }
    return { history: [...pending, ...kept], summary };
}

/** 手动压缩（/compact）：除最近 2 条外全部并入摘要 */
export async function compactSession({ sessionId, settings }) {
    const session = await getSession(sessionId);
    if (!session) return { performed: false };
    const stored = await listMessages(sessionId);
    const older = stored.slice(0, Math.max(0, stored.length - 2)).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content || '') }));
    const meta = session.metadata || {};
    const done = Math.min(Number(meta.summarizedCount) || 0, older.length);
    const pending = older.slice(done);
    if (pending.length < 2) return { performed: false, summary: session.summary || '' };
    const beforeTokens = estimateTokens(session.summary) + estimateTokens(older.map((m) => m.content).join(''));
    const summary = await summarize({ settings, previous: session.summary || '', messages: pending });
    await saveSession({ id: sessionId, summary, metadata: { ...meta, summarizedCount: older.length } });
    return { performed: true, summarized: pending.length, summary, beforeTokens, afterTokens: estimateTokens(summary) };
}

/** 用模型给新对话起一个短标题；失败返回空串 */
export async function generateTitle({ settings, text }) {
    const res = await callAiCompletion({
        profileId: settings.id,
        maxTokens: 40,
        messages: [
            { role: 'system', content: '用不超过 16 个字概括用户这句话要做的事，作为对话标题。只输出标题本身，不要标点、引号和解释。' },
            { role: 'user', content: clip(String(text || ''), 1000) },
        ],
    }).catch(() => null);
    return String(res?.ok ? res.text : '').replace(/["“”「」『』《》。.!！]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
}
