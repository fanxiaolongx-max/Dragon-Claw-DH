import { BusinessError } from '../core/errors.js';
import { resolveRequestIdentity } from '../core/identity.js';
import { hasAdminMatch, listAdmins, saveAdmins } from '../core/access.js';
import { pushLog } from '../core/log-ring.js';
import { isMemoryMode } from '../services/system-service.js';
import { pushAdminAlert } from '../services/alert-service.js';

function publicIdentity(id) {
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
        identified: id.identified,
        appId: id.appId,
        appLevel: id.appLevel,
        digitalHumanMode: true,
        memoryMode: isMemoryMode(),
    };
}

export async function authRoutes(fastify) {
    fastify.get('/me', async (req) => publicIdentity(resolveRequestIdentity(req)));

    // 底座已完成单点登录：这两个端点只为兼容桌面版前端的调用，不做任何口令校验
    fastify.post('/login', async (req) => {
        const id = resolveRequestIdentity(req);
        return { success: true, username: id.username, role: id.role, tenantId: id.tenantId, isSuper: id.isSuper };
    });
    fastify.post('/logout', async () => ({ success: true }));

    fastify.get('/users', async (req) => {
        const id = resolveRequestIdentity(req);
        return [{ username: id.username, role: id.role, isSuper: id.isSuper, tenantId: 'default', displayName: id.displayName, source: id.source }];
    });

    // 管理员名单（仅管理员；写操作由入口权限钩子拦截非管理员）
    fastify.get('/admins', async () => listAdmins());
    fastify.put('/admins', async (req) => {
        const me = resolveRequestIdentity(req);
        const users = Array.isArray(req.body?.users) ? req.body.users : [];
        const next = users.map((u) => String(u || '').trim().toLowerCase()).filter(Boolean);
        if (me.identified && !hasAdminMatch(next, me.username)) {
            const { env } = await listAdmins();
            if (!hasAdminMatch(env, me.username)) throw new BusinessError('不能把自己移出管理员名单', 400);
        }
        const stored = await saveAdmins(next);
        pushLog({ level: 'WARN', category: 'AUTH', message: `管理员名单已更新（${stored.length} 人）`, userId: me.username });
        await pushAdminAlert({ type: 'security', severity: 'warn', title: '管理员名单已更新', message: `${me.username} 把管理员名单改为：${stored.join('、') || '（空）'}`, actor: me.username, objectType: 'admins' });
        return { success: true, stored };
    });
}
