import { scopedCheckHealth, isMemoryMode } from '../dao/scoped.js';
import { config } from '../config.js';

export async function healthRoutes(fastify) {
    const handler = async (_req, reply) => {
        const memoryMode = isMemoryMode();
        let dbStatus = { healthy: memoryMode, latencyMs: 0, mode: memoryMode ? 'memory' : 'base-api' };
        if (!memoryMode) {
            try {
                const probe = await scopedCheckHealth();
                dbStatus = { ...probe, mode: 'base-api' };
            } catch (err) {
                dbStatus = { healthy: false, latencyMs: 0, mode: 'base-api', error: err.message };
            }
        }
        return reply.send({
            status: 'ok',
            service: config.appName,
            version: config.appVersion,
            runtime: 'digital-human-web',
            schema: config.appSchema || null,
            datasourceId: config.appDatasourceId || null,
            memoryMode,
            db: dbStatus,
            timestamp: new Date().toISOString(),
        });
    };

    fastify.get('/health', handler);
    fastify.get('/healthz', handler);
    fastify.get('/ping', async () => ({ pong: true, time: Date.now() }));
}
