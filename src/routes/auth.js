import { resolveRequestIdentity } from '../core/identity.js';
import { pushLog } from '../core/log-ring.js';

export async function authRoutes(fastify) {
    fastify.get('/me', async (req) => {
        const id = resolveRequestIdentity(req);
        return {
            username: id.username,
            displayName: id.displayName,
            role: id.role,
            isAdmin: id.isAdmin,
            isSuper: id.isSuper,
            tenantId: id.tenantId,
            homeTenantId: id.homeTenantId,
            lang: id.lang,
            source: id.source,
            appId: id.appId,
            appLevel: id.appLevel,
            digitalHumanMode: true,
        };
    });

    fastify.post('/login', async (req) => {
        const id = resolveRequestIdentity(req);
        pushLog({ level: 'INFO', category: 'AUTH', message: 'Digital Human SSO login passthrough', userId: id.username });
        return { success: true, username: id.username, role: id.role, tenantId: id.tenantId, isSuper: true };
    });

    fastify.post('/logout', async () => ({ success: true }));

    fastify.get('/users', async (req) => {
        const id = resolveRequestIdentity(req);
        return [{
            username: id.username,
            role: 'admin',
            isSuper: true,
            tenantId: 'default',
            displayName: id.displayName,
            source: id.source,
        }];
    });
}
