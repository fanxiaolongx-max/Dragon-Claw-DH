import { BusinessError } from '../core/errors.js';
import { resolveRequestIdentity } from '../core/identity.js';
import { DEV_COOKIE } from '../core/identity-guard.js';
import { config } from '../config.js';
import { hasAdminMatch, isAuthEnforced, isSameUserId, listAdmins, saveAdmins } from '../core/access.js';
import { pushLog } from '../core/log-ring.js';
import { isMemoryMode } from '../services/system-service.js';
import { pushAdminAlert } from '../services/alert-service.js';
import { recordAudit, recordAuditOnce, listAudit, getLoginStats, clientIp, parseClientInfo } from '../services/audit-service.js';
import { listKnownUsers, rememberUser, userKey } from '../services/share-service.js';
import { listTeams, createTeam, renameTeam, deleteTeam, setMemberTeam, teamOf, setAdminViewing } from '../services/team-service.js';

const LOGIN_WINDOW_MS = 8 * 3600_000;

function publicIdentity(id) {
    return {
        username: id.username,
        displayName: id.displayName,
        role: id.role,
        isAdmin: id.isAdmin,
        isSuper: id.isSuper,
        // 前端按「团队」切分浏览器本地状态、显示「正在查看团队」提示条
        tenantId: id.teamId || 'default',
        homeTenantId: id.viewingTeam ? 'default' : (id.teamId || 'default'),
        viewingTeam: id.viewingTeam || null,
        lang: id.lang,
        source: id.source,
        identified: id.identified,
        devAdmin: Boolean(id.devAdmin),
        teamId: id.teamId || '',
        identityVerified: Boolean(id.verified),
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
        // 共享对话的账号目录：记下用过本应用的人（底座没有员工通讯录）；每人每小时最多写一次库，这里等它写完，
        // 刚进来的人马上就能被搜到
        if (!id.devAdmin) await rememberUser(id).catch(() => {});
        if (id.identified) await Promise.resolve(recordAuditOnce(`login:${id.username}:${parseClientInfo(req).platform}:${clientIp(req)}`, LOGIN_WINDOW_MS, req, { actor: id.username, action: 'login', detail: '基座单点登录' })).catch(() => {});
        const out = publicIdentity(id);
        if (out.teamId) out.teamName = (await listTeams().catch(() => ({ teams: [] }))).teams.find((t) => t.id === out.teamId)?.name || out.teamId;
        return out;
    });

    // ── 账号绑定团队（仅超级管理员；见 core/access.js 的 ADMIN_READS 与默认写权限）──
    fastify.get('/teams', async () => listTeams());
    fastify.post('/teams', async (req) => {
        const me = resolveRequestIdentity(req);
        const team = await createTeam(req.body || {}, me.username);
        await recordAudit(req, { actor: me.username, action: 'team_create', detail: `${team.name}（${team.id}）` });
        return { success: true, team, ...(await listTeams()) };
    });
    fastify.put('/teams/:id', async (req) => {
        const me = resolveRequestIdentity(req);
        const team = await renameTeam(String(req.params.id || ''), req.body?.name);
        await recordAudit(req, { actor: me.username, action: 'team_rename', detail: `${team.id} → ${team.name}` });
        return { success: true, team, ...(await listTeams()) };
    });
    fastify.delete('/teams/:id', async (req) => {
        const me = resolveRequestIdentity(req);
        await deleteTeam(String(req.params.id || ''));
        await recordAudit(req, { actor: me.username, action: 'team_delete', detail: String(req.params.id || '') });
        return { success: true, ...(await listTeams()) };
    });
    fastify.put('/teams/members/:username', async (req) => {
        const me = resolveRequestIdentity(req);
        const moved = await setMemberTeam(req.params.username, req.body?.teamId || '');
        await recordAudit(req, { actor: me.username, action: moved.to ? 'user_team_bind' : 'user_team_unbind', detail: `${moved.username}：${moved.from || '默认团队'} → ${moved.to || '默认团队'}` });
        await pushAdminAlert({ type: 'security', severity: 'info', title: '账号团队已调整', message: `${me.username} 把 ${moved.username} 从「${moved.from || '默认团队'}」移到「${moved.to || '默认团队'}」`, actor: me.username, objectType: 'team' });
        return { success: true, ...moved, ...(await listTeams()) };
    });

    // 底座已完成单点登录：这两个端点只为兼容桌面版前端的调用，不做任何口令校验
    fastify.post('/login', async (req) => {
        const id = resolveRequestIdentity(req);
        return { success: true, username: id.username, role: id.role, tenantId: id.tenantId, isSuper: id.isSuper };
    });
    fastify.post('/logout', async (req, reply) => {
        const id = resolveRequestIdentity(req);
        if (id.identified) await recordAudit(req, { actor: id.username, action: 'logout' });
        // 开发者免登录会话随登出一起清掉
        if (id.devAdmin) reply.header('Set-Cookie', `${DEV_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
        return { success: true };
    });

    // 审计日志（仅管理员，见 core/access.js 的 ADMIN_READS）：分页、按客户端筛选，返回体与主线版一致
    fastify.get('/audit', async (req) => listAudit({ page: req.query?.page, limit: req.query?.limit, platform: req.query?.platform, actor: req.query?.actor, action: req.query?.action }));

    fastify.get('/users', async (req) => {
        const id = resolveRequestIdentity(req);
        return [{ username: id.username, role: id.role, isSuper: id.isSuper, tenantId: 'default', displayName: id.displayName, source: id.source }];
    });

    // 管理员名单（仅管理员；写操作由入口权限钩子拦截非管理员）
    async function buildAdminsView(me) {
        const [{ env, stored, openAdmin }, known, auditStats] = await Promise.all([
            listAdmins(),
            listKnownUsers().catch(() => []),
            getLoginStats().catch(() => null),
        ]);
        const now = new Date();
        const todayStart = auditStats?.todayStart || new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const weekStart = auditStats?.weekStart || (todayStart - 6 * 86400_000);
        const auditLastSeen = new Map();
        if (auditStats?.lastSeenByActor) {
            for (const [actor, ts] of auditStats.lastSeenByActor.entries()) {
                const k = userKey(actor);
                if (ts > (auditLastSeen.get(k) || 0)) auditLastSeen.set(k, ts);
            }
        }
        const map = new Map();
        const upsert = (username, displayName = '', seenAt = 0) => {
            const cleanId = String(username || '').trim();
            if (!cleanId) return;
            const key = cleanId.toLowerCase();
            const prev = map.get(key);
            const fromAudit = auditLastSeen.get(userKey(cleanId)) || 0;
            map.set(key, {
                username: prev?.username || cleanId,
                displayName: String(displayName || prev?.displayName || '').trim(),
                seenAt: Math.max(Number(prev?.seenAt) || 0, Number(seenAt) || 0, fromAudit),
            });
        };
        for (const u of known) upsert(u.username, u.name, u.seenAt);
        if (me?.identified) upsert(me.username, me.displayName, Date.now());
        for (const u of [...env, ...stored]) upsert(u);
        const teamIds = new Map(await Promise.all([...map.values()].map(async (u) => [u.username.toLowerCase(), await teamOf(u.username).catch(() => '')])));
        const users = [...map.values()]
            .map((u) => {
                const isEnvAdmin = hasAdminMatch(env, u.username);
                const isStoredAdmin = hasAdminMatch(stored, u.username);
                return {
                    username: u.username,
                    displayName: u.displayName || u.username,
                    seenAt: u.seenAt || 0,
                    isEnvAdmin,
                    isStoredAdmin,
                    isSuper: isEnvAdmin || isStoredAdmin,
                    isSelf: Boolean(me?.identified && isSameUserId(u.username, me.username)),
                    teamId: teamIds.get(u.username.toLowerCase()) || '',
                };
            })
            .sort((a, b) => (Number(b.isSuper) - Number(a.isSuper)) || (b.seenAt - a.seenAt) || a.username.localeCompare(b.username));
        const todayActiveSet = new Set();
        const weekActiveSet = new Set();
        for (const u of users) {
            const k = userKey(u.username);
            if (u.seenAt >= todayStart) todayActiveSet.add(k);
            if (u.seenAt >= weekStart) weekActiveSet.add(k);
        }
        if (auditStats?.todayActiveActors) {
            for (const a of auditStats.todayActiveActors) todayActiveSet.add(userKey(a));
        }
        if (auditStats?.weekActiveActors) {
            for (const a of auditStats.weekActiveActors) weekActiveSet.add(userKey(a));
        }
        const stats = {
            totalUsers: users.length,
            loggedInUsers: users.filter((u) => u.seenAt > 0).length,
            superAdmins: users.filter((u) => u.isSuper).length,
            todayLogins: auditStats?.todayLogins || 0,
            todayActiveUsers: todayActiveSet.size,
            weekActiveUsers: weekActiveSet.size,
            totalLogins: auditStats?.totalLogins || 0,
        };
        return { env, stored, openAdmin, users, stats };
    }

    fastify.get('/admins', async (req) => buildAdminsView(resolveRequestIdentity(req)));
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
        return { success: true, ...(await buildAdminsView(me)) };
    });
}

// 超级管理员进入某个团队查看 / 排障（与主线版同一个接口，前端共用）：之后按该团队读写工具页面数据，
// 底部提示条可一键返回。只有管理员能调（非 GET 默认要管理员权限，见 core/access.js）。
export async function tenantSwitchRoutes(fastify) {
    fastify.post('/switch', async (req) => {
        const me = resolveRequestIdentity(req);
        if (!me.isAdmin) throw new BusinessError('只有超级管理员可以进入其他团队', 403);
        const raw = String(req.body?.tenantId || '').trim().toLowerCase();
        const target = raw === 'default' ? '' : raw;
        const result = await setAdminViewing(me.username, target);
        await recordAudit(req, { actor: me.username, action: target ? 'team_enter' : 'team_leave', detail: target ? `${result.name}（${target}）` : '返回默认团队' });
        return { success: true, tenantId: target || 'default', viewingTeam: target ? { id: target, name: result.name } : null };
    });
}
