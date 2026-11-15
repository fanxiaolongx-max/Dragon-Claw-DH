// AI BI 看板的保存与读取；对话生成布局走 /api/ai-report/bi/plan（与格子编译共用数据概况）。
import { BusinessError } from '../core/errors.js';
import { resolveRequestIdentity } from '../core/identity.js';
import { listBoards, readBoard, saveBoard, removeBoard } from '../services/ai-bi-service.js';

export async function aiBiRoutes(fastify) {
    fastify.get('/boards', async () => listBoards());
    fastify.get('/boards/:id', async (req, reply) => { reply.header('Cache-Control', 'no-store'); return readBoard(req.params.id); });
    fastify.post('/boards', async (req) => saveBoard(req.body || {}, resolveRequestIdentity(req).username));
    fastify.delete('/boards/:id', async (req) => {
        if (!resolveRequestIdentity(req).isAdmin) throw new BusinessError('只有管理员可以删除看板', 403);
        return removeBoard(req.params.id);
    });
}
