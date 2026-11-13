// 写操作审批：智能体要改数据、发通知、删脚本时先在对话里弹出确认卡，用户点「允许」才执行。
// 卡片上选「本次会话不再询问」后，这个人在这个对话里再用同一个工具就直接执行（与主线版的「总是允许」一致）。
// 应用是单进程（规范 WORKERS=1），待审批的请求和「不再询问」的记录都放在内存里；重启后恢复为逐次询问。
// 超时或连接断开按拒绝处理。
import crypto from 'node:crypto';

const pending = new Map();
const TIMEOUT_MS = 5 * 60_000;
// 「本次会话不再询问」：工号 + 对话 → 工具名集合；只保留最近 500 个对话
const alwaysAllowed = new Map();
const MAX_SESSIONS = 500;
const sessionKey = (owner, sessionId) => (owner && sessionId ? `${owner}\n${sessionId}` : '');
export const isAlwaysAllowed = (owner, sessionId, tool) => Boolean(alwaysAllowed.get(sessionKey(owner, sessionId))?.has(tool));
function rememberAlways(owner, sessionId, tool) {
    const key = sessionKey(owner, sessionId);
    if (!key || !tool) return;
    const set = alwaysAllowed.get(key) || new Set();
    set.add(tool);
    alwaysAllowed.delete(key);
    alwaysAllowed.set(key, set);
    if (alwaysAllowed.size > MAX_SESSIONS) alwaysAllowed.delete(alwaysAllowed.keys().next().value);
}

export function requestApproval({ owner, sessionId = '', callId, tool, preview, emit, signal }) {
    // 用户已在本对话里选过「不再询问」：直接放行，界面上仍留一行记录
    if (isAlwaysAllowed(owner, sessionId, tool)) {
        emit({ type: 'approval_result', id: '', callId, decision: 'allow', auto: true });
        return Promise.resolve('allow');
    }
    const id = `apv_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    return new Promise((resolve) => {
        const finish = (decision) => {
            const item = pending.get(id);
            if (!item) return;
            pending.delete(id);
            clearTimeout(item.timer);
            clearInterval(item.keepalive);
            signal?.removeEventListener?.('abort', onAbort);
            const allowed = decision === 'allow' || decision === 'always';
            if (decision === 'always') rememberAlways(owner, sessionId, tool);
            emit({ type: 'approval_result', id, callId, decision: allowed ? (decision === 'always' ? 'always' : 'allow') : 'deny' });
            resolve(allowed ? 'allow' : decision);
        };
        const onAbort = () => finish('aborted');
        pending.set(id, {
            owner,
            finish,
            timer: setTimeout(() => finish('timeout'), TIMEOUT_MS),
            // 等待期间每 15 秒发一行状态，防止网关把空闲的流式连接断掉
            keepalive: setInterval(() => emit({ type: 'status', status: '等待你确认…' }), 15_000),
        });
        signal?.addEventListener?.('abort', onAbort, { once: true });
        // 没有对话标识（不保存记录的临时对话）时没法记住「不再询问」，就不提供这个按钮
        emit({ type: 'approval', id, callId, tool, preview, ...(sessionKey(owner, sessionId) ? {} : { noAlways: true }) });
    });
}

/** 用户点了按钮。只有发起这次对话的本人能批。返回 false 表示不存在或无权。 */
export function decideApproval(id, owner, decision) {
    const item = pending.get(String(id));
    if (!item || item.owner !== owner) return false;
    item.finish(decision === 'allow' || decision === 'always' ? decision : 'deny');
    return true;
}
