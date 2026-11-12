// 写操作审批：智能体要改数据、发通知、删脚本时先在对话里弹出确认卡，用户点「允许」才执行。
// 应用是单进程（规范 WORKERS=1），待审批的请求放在内存里；超时或连接断开按拒绝处理。
import crypto from 'node:crypto';

const pending = new Map();
const TIMEOUT_MS = 5 * 60_000;

export function requestApproval({ owner, callId, tool, preview, emit, signal }) {
    const id = `apv_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    return new Promise((resolve) => {
        const finish = (decision) => {
            const item = pending.get(id);
            if (!item) return;
            pending.delete(id);
            clearTimeout(item.timer);
            clearInterval(item.keepalive);
            signal?.removeEventListener?.('abort', onAbort);
            emit({ type: 'approval_result', id, callId, decision: decision === 'allow' ? 'allow' : 'deny' });
            resolve(decision);
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
        emit({ type: 'approval', id, callId, tool, preview, noAlways: true });
    });
}

/** 用户点了按钮。只有发起这次对话的本人能批。返回 false 表示不存在或无权。 */
export function decideApproval(id, owner, decision) {
    const item = pending.get(String(id));
    if (!item || item.owner !== owner) return false;
    item.finish(decision === 'allow' ? 'allow' : 'deny');
    return true;
}
