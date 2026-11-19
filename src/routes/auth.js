import { BusinessError } from '../core/errors.js';
import { resolveRequestIdentity } from '../core/identity.js';
import { config } from '../config.js';
import { hasAdminMatch, isAuthEnforced, listAdmins, saveAdmins } from '../core/access.js';
import { pushLog } from '../core/log-ring.js';
import { isMemoryMode } from '../services/system-service.js';
import { pushAdminAlert } from '../services/alert-service.js';
import { recordAudit, recordAuditOnce, listAudit, clientIp, parseClientInfo } from '../services/audit-service.js';
import { rememberUser } from '../services/share-service.js';

const LOGIN_WINDOW_MS = 8 * 3600_000;

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
        openAdmin: Boolean(config.openAdmin),
        authRequired: isAuthEnforced(),
    };
}

export async function authRoutes(fastify) {
    fastify.get('/me', async (req) => {
        const id = resolveRequestIdentity(req);
        // 登录由基座完成，这里把「同一账号 + 客户端 + IP 在 8 小时内首次进入」记为一次登录
        // 共享对话的账号目录：记下用过本应用的人（底座没有员工通讯录）
        rememberUser(id).catch(() => {});
        if (id.identified) recordAuditOnce(`login:${id.username}:${parseClientInfo(req).platform}:${clientIp(req)}`, LOGIN_WINDOW_MS, req, { actor: id.username, action: 'login', detail: '基座单点登录' });
        return publicIdentity(id);
    });

    // 底座已完成单点登录：这两个端点只为兼容桌面版前端的调用，不做任何口令校验
    fastify.post('/login', async (req) => {
        const id = resolveRequestIdentity(req);
        return { success: true, username: id.username, role: id.role, tenantId: id.tenantId, isSuper: id.isSuper };
    });
    fastify.post('/logout', async (req) => {
        const id = resolveRequestIdentity(req);
        if (id.identified) await recordAudit(req, { actor: id.username, action: 'logout' });
        return { success: true };
    });

    // 审计日志（仅管理员，见 core/access.js 的 ADMIN_READS）：分页、按客户端筛选，返回体与主线版一致
    fastify.get('/audit', async (req) => listAudit({ page: req.query?.page, limit: req.query?.limit, platform: req.query?.platform, actor: req.query?.actor, action: req.query?.action }));

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
        await recordAudit(req, { actor: me.username, action: 'admins_update', detail: stored.join('、') || '（空）' });
        await pushAdminAlert({ type: 'security', severity: 'warn', title: '管理员名单已更新', message: `${me.username} 把管理员名单改为：${stored.join('、') || '（空）'}`, actor: me.username, objectType: 'admins' });
        return { success: true, stored };
    });
}
