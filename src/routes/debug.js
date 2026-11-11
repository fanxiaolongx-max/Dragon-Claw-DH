import { config, endpoints } from '../config.js';
import { resolveRequestIdentity, parseCookies } from '../core/identity.js';
import { listLogs, clearLogs, subscribeLogs, pushLog } from '../core/log-ring.js';
import { debugProbeAction, isMemoryMode } from '../dao/scoped.js';
import { sendExpediteNotification } from '../services/report-service.js';

function maskVal(val) {
    const s = String(val || '');
    if (!s) return '(未配置)';
    if (s.length <= 12) return s;
    return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

export async function debugRoutes(fastify) {
    fastify.get('/summary', async (req) => {
        const identity = resolveRequestIdentity(req);
        const cookies = parseCookies(req.headers.cookie);
        const rawHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
            if (/authorization|cookie|token|secret/i.test(k)) {
                rawHeaders[k] = v ? `[REDACTED len=${String(v).length}]` : '';
            } else {
                rawHeaders[k] = v;
            }
        }
        return {
            service: config.appName,
            version: config.appVersion,
            nodeVersion: process.version,
            pid: process.pid,
            uptimeSec: Math.round(process.uptime()),
            memoryMode: isMemoryMode(),
            identity,
            cookies: Object.fromEntries(Object.entries(cookies).map(([k, v]) => (
                /token|session|auth|secret/i.test(k) ? [k, `[REDACTED len=${String(v).length}]`] : [k, v]
            ))),
            headers: rawHeaders,
            urlContext: {
                rawUrl: `${req.raw._dhRawPath || req.raw.url}${req.raw._dhRawSearch || ''}`,
                routerUrl: req.url,
                xForwardedPrefix: req.headers['x-forwarded-prefix'] || '',
                xForwardedHost: req.headers['x-forwarded-host'] || '',
            },
            env: {
                NODE_ENV: config.nodeEnv,
                PORT: config.port,
                APP_UUID: config.appUuid || '(未配置)',
                APP_SCHEMA: config.appSchema || '(未配置)',
                APP_LEVEL: config.appLevel,
                APP_REGION: config.appRegion || '(未配置)',
                APP_DATASOURCE_ID: config.appDatasourceId,
                APP_DATASOURCE_NAME: config.appDatasourceName || '(未配置)',
                APP_CACHE_DATASOURCE_ID: config.appCacheDatasourceId,
                APP_CACHE_DATASOURCE_NAME: config.appCacheDatasourceName || '(未配置)',
                BUSINESS_DATASOURCE_ID: config.businessDatasourceId,
                HTTP_VERIFY_SSL: config.httpVerifySsl,
                HTTP_TIMEOUT_MS: config.httpTimeoutMs,
                LOCAL_DEV_MEMORY: isMemoryMode(),
                ENDPOINTS: {
                    query: maskVal(endpoints.query),
                    execute: maskVal(endpoints.execute),
                    datasources: maskVal(endpoints.datasources),
                    repOffices: maskVal(endpoints.repOffices),
                    appMenus: maskVal(endpoints.appMenus),
                    cacheQuery: maskVal(endpoints.cacheQuery),
                    cacheExecute: maskVal(endpoints.cacheExecute),
                    notify: maskVal(endpoints.notify),
                },
            },
        };
    });

    fastify.get('/logs', async (req) => {
        const { limit = 200, level = '', category = '', q = '', sinceId = 0 } = req.query || {};
        return { items: listLogs({ limit, level, category, q, sinceId }) };
    });

    fastify.post('/logs/clear', async () => {
        clearLogs();
        pushLog({ level: 'INFO', category: 'DEBUG', message: '调试日志环形缓冲区已清空' });
        return { success: true };
    });

    fastify.get('/logs/stream', async (req, reply) => {
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        const sendEvent = (item) => {
            if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                reply.raw.write(`data: ${JSON.stringify(item)}\n\n`);
            }
        };
        for (const item of listLogs({ limit: 80 })) {
            sendEvent(item);
        }
        const unsubscribe = subscribeLogs(sendEvent);
        const timer = setInterval(() => {
            if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                reply.raw.write(': keepalive\n\n');
            }
        }, 15_000);
        req.raw.on('close', () => {
            clearInterval(timer);
            unsubscribe();
        });
        return reply;
    });

    fastify.post('/test/:action', async (req) => {
        const started = Date.now();
        const identity = resolveRequestIdentity(req);
        const result = await debugProbeAction(req.params.action, {
            ...(req.body && typeof req.body === 'object' ? req.body : {}),
            userId: identity.username,
        });
        return {
            action: req.params.action,
            durationMs: Date.now() - started,
            memoryMode: isMemoryMode(),
            result,
        };
    });

    fastify.post('/notify-test', async (req) => {
        const started = Date.now();
        const raw = req.body && typeof req.body === 'object' ? req.body : {};
        const customPayload = raw.payload || (raw.module_type || raw.msg_type ? raw : null);
        const result = await sendExpediteNotification({ ...raw, payload: customPayload });
        return {
            action: 'notify-test',
            durationMs: Date.now() - started,
            result,
        };
    });
}
