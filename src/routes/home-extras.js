// 首页的友情链接与平台推广接口。读取对所有人开放；保存、探测仅管理员（由 core/access.js 统一拦截），点击上报所有人可用。
import { getFriendLinks, saveFriendLinks, probeFriendLinks, getPromotions, savePromotions, recordPromotionClick, promotionStats } from '../services/home-links-service.js';

const noStore = (fastify) => fastify.addHook('onSend', async (_req, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });

export async function friendLinksRoutes(fastify) {
    noStore(fastify);
    fastify.get('/', async () => getFriendLinks({ refreshIfStale: true }));
    fastify.put('/', async (req) => saveFriendLinks(req.body || {}));
    fastify.post('/probe', async () => probeFriendLinks());
    fastify.post('/:linkId/probe', async (req) => probeFriendLinks(String(req.params.linkId || '')));
}

export async function platformPromotionsRoutes(fastify) {
    noStore(fastify);
    fastify.get('/', async () => getPromotions());
    fastify.put('/', async (req) => savePromotions(req.body || {}));
    fastify.post('/clicks', async (req) => ({ success: true, counted: await recordPromotionClick({ id: req.body?.id, kind: req.body?.kind, username: req.userIdentity.username }) }));
    fastify.get('/stats', async (req, reply) => {
        if (!req.userIdentity.isAdmin) return reply.code(403).send({ code: 'ADMIN_REQUIRED', error: '该功能仅管理员可用' });
        return promotionStats({ days: req.query?.days });
    });
    // 桌面卡片堆是主线版能力
    fastify.get('/desktop', async () => ({ available: false, enabled: false, supported: false, cards: [] }));
}
