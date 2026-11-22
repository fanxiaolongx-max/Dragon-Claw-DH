// 共享对话接口（与主线版 /api/shared-conversations 同一套，前端共用 shared-conversations.js）。
// 所有操作都只作用于当前识别出的工号：自己能访问的对话、自己收到的邀请、自己的常用群组。
import { resolveRequestIdentity } from '../core/identity.js';
import { BusinessError } from '../core/errors.js';
import * as share from '../services/share-service.js';

export async function sharedConversationRoutes(fastify) {
    const resolveMe = (req) => {
        const id = resolveRequestIdentity(req);
        if (!id.identified && !id.isAdmin) throw new BusinessError('未识别到工号，请从数字人平台进入后再使用共享对话', 401);
        return id;
    };
    const me = (req) => resolveMe(req).username;
    fastify.addHook('onSend', async (_req, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });

    fastify.get('/accounts', async (req) => ({ items: await share.accounts(me(req), req.query?.q) }));
    fastify.get('/recent', async (req) => share.recent(me(req)));
    fastify.get('/groups', async (req) => ({ items: await share.listGroups(me(req)) }));
    fastify.post('/groups', async (req) => ({ item: await share.saveGroup(me(req), req.body || {}) }));
    fastify.put('/groups/:id', async (req) => ({ item: await share.saveGroup(me(req), { ...(req.body || {}), id: req.params.id }) }));
    fastify.delete('/groups/:id', async (req) => { await share.deleteGroup(me(req), req.params.id); return { ok: true }; });

    fastify.get('/inbox', async (req) => {
        const id = resolveMe(req);
        return {
            items: await share.inbox(id.username),
            skillRequests: await share.inboxSkillRequests(id),
        };
    });
    fastify.post('/invites/:shareId/respond', async (req) => share.respond({ user: me(req), shareId: req.params.shareId, action: String(req.body?.action || '') }));
    fastify.post('/link/:token', async (req) => share.joinByLink({ user: me(req), token: req.params.token }));

    fastify.get('/mine', async (req) => ({ items: await share.listMine(me(req)) }));
    fastify.get('/session/:sessionId', async (req) => {
        const id = resolveMe(req);
        return { share: await share.shareForSession({ user: id.username, sessionId: req.params.sessionId, identity: id }) };
    });
    fastify.post('/session/:sessionId/skill-requests', async (req) => {
        const id = resolveMe(req);
        return share.requestSkillShare({
            identity: id,
            sessionId: req.params.sessionId,
            skillId: req.body?.skillId,
            linkBase: req.body?.linkBase,
        });
    });
    fastify.post('/skill-requests/:requestId/respond', async (req) => {
        const id = resolveMe(req);
        return share.respondSkillRequest({
            identity: id,
            requestId: req.params.requestId,
            action: String(req.body?.action || ''),
            note: String(req.body?.note || ''),
        });
    });
    fastify.post('/session/:sessionId/prepare', async (req) => {
        const user = me(req);
        await share.ensureShare({ user, sessionId: req.params.sessionId, title: req.body?.title });
        return { share: await share.shareForSession({ user, sessionId: req.params.sessionId }) };
    });
    fastify.post('/session/:sessionId/invite', async (req) => share.invite({
        user: me(req), sessionId: req.params.sessionId, title: req.body?.title,
        usernames: req.body?.usernames, groupIds: req.body?.groupIds, linkBase: req.body?.linkBase,
    }));
    fastify.post('/session/:sessionId/sync', async (req) => ({ result: await share.markRead({ user: me(req), sessionId: req.params.sessionId }) }));
    fastify.get('/session/:sessionId/live', async (req, reply) => {
        const sessionId = req.params.sessionId;
        const user = me(req);
        const access = await share.sessionAccess(sessionId, user);
        if (!access) return reply.code(404).send({ error: '会话不存在或无权访问' });

        reply.raw.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        const current = share.getLiveStream(sessionId);
        if (current) {
            reply.raw.write(`${JSON.stringify({
                type: 'catchup',
                by: current.by,
                name: current.name,
                question: current.question,
                text: current.fullText,
                events: current.events,
                startedAt: current.startedAt,
            })}\n`);
        } else {
            reply.raw.write(`${JSON.stringify({ type: 'idle' })}\n`);
        }

        let timer = null;
        let unsubscribe = () => {};
        const close = () => {
            clearInterval(timer);
            unsubscribe();
            if (!reply.raw.writableEnded) reply.raw.end();
        };
        const send = (event) => {
            if (reply.raw.destroyed || reply.raw.writableEnded) return close();
            reply.raw.write(`${JSON.stringify(event)}\n`);
            // 被移出共享 / 共享停止：告诉前端别再重连，并立刻断开
            if (event.type === 'revoked') close();
        };
        unsubscribe = share.subscribeSharedEvents(sessionId, send, user);
        timer = setInterval(() => send({ type: 'ping' }), 15000);
        req.raw.on('close', close);
        return reply;
    });
    fastify.post('/session/:sessionId/leave', async (req) => share.leave({ user: me(req), sessionId: req.params.sessionId }));
    fastify.post('/session/:sessionId/remove', async (req) => ({ share: await share.removeMember({ user: me(req), sessionId: req.params.sessionId, target: String(req.body?.username || '') }) }));
}
