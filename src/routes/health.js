import { checkDataHealth as scopedCheckHealth, isMemoryMode } from '../services/system-service.js';
import { config } from '../config.js';
import { ok } from '../core/response.js';

// 底座每 10s 探活、连续 3 次失败就重启应用（规范 §9）。探活绝不能因为基座抖动而失败或变慢：
// 基座探测结果缓存 10s、后台刷新；应用进程活着就返回 status=ok，基座状况单独放在 base_api / data_mode 里。
const TTL_MS = 10_000;
let probe = { at: 0, healthy: null, latencyMs: 0, error: '' };
let refreshing = null;

function refresh() {
    if (refreshing) return refreshing;
    refreshing = scopedCheckHealth()
        .then((r) => { probe = { at: Date.now(), healthy: Boolean(r.healthy), latencyMs: r.latencyMs || 0, error: '' }; })
        .catch((err) => { probe = { at: Date.now(), healthy: false, latencyMs: 0, error: err.message }; })
        .finally(() => { refreshing = null; });
    return refreshing;
}

export async function healthHandler() {
    const memoryMode = isMemoryMode();
    if (!memoryMode) {
        if (probe.healthy === null) await Promise.race([refresh(), new Promise((r) => setTimeout(r, 2500))]);
        else if (Date.now() - probe.at > TTL_MS) refresh();
    }
    const baseOk = memoryMode ? false : probe.healthy === true;
    const data = {
        status: 'ok',
        runtime: 'node',
        base_api: memoryMode ? 'memory' : (baseOk ? 'ok' : 'fail'),
        app_region: config.appRegion,
        data_mode: memoryMode ? 'memory' : (baseOk ? 'online' : 'degraded'),
        service: config.appName,
        version: config.appVersion,
        base_latency_ms: probe.latencyMs,
        base_error: probe.error || undefined,
    };
    // 顶层 status 兼容样例包的 /health 判定方式；data 兼容规范的 {code,data:{status}}
    return { ...ok(data), status: 'ok' };
}

export async function healthRoutes(fastify) {
    fastify.get('/healthz', healthHandler);
    fastify.get('/health', healthHandler);
    fastify.get('/ping', async () => ({ pong: true, time: Date.now() }));
}
