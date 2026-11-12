// 消息中心、平台标识（Logo）、智能体工具清单的接口。
import { BusinessError } from '../core/errors.js';
import { listAlerts, alertSummary, markAlertsRead, removeAlerts } from '../services/alert-service.js';
import { logoStatus, logoImage, saveLogo, resetLogo } from '../services/logo-service.js';
import { toolCatalog, setToolAccess } from '../services/tool-catalog-service.js';
import { runSelect, tableCatalog } from '../agent/tools.js';

// 消息只属于本人：每个接口都按当前工号取
export async function alertCenterRoutes(fastify) {
    const me = (req) => req.userIdentity.username;
    fastify.addHook('onSend', async (_req, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });
    fastify.get('/summary', async (req) => alertSummary(me(req)));
    fastify.get('/events', async (req) => listAlerts(me(req), { status: String(req.query?.status || ''), type: String(req.query?.type || ''), limit: req.query?.limit }));
    fastify.put('/events/read', async (req) => markAlertsRead(me(req), Array.isArray(req.body?.ids) ? req.body.ids : []));
    fastify.put('/events/read-all', async (req) => markAlertsRead(me(req)));
    fastify.put('/events/archive-all', async (req) => removeAlerts(me(req)));
    fastify.post('/events/clear-all', async (req) => removeAlerts(me(req)));
    fastify.delete('/events/:id', async (req) => removeAlerts(me(req), req.params.id));
}

export async function platformLogoRoutes(fastify) {
    fastify.get('/status', async (_req, reply) => {
        reply.header('Cache-Control', 'no-store');
        return logoStatus();
    });
    fastify.get('/image', async (_req, reply) => sendLogo(reply));
    // 上传（仅管理员，由入口权限钩子拦截）：前端已把图片统一转成 PNG
    fastify.post('/upload', async (req, reply) => {
        if (typeof req.parts !== 'function') return reply.code(501).send({ ok: false, error: '当前安装包未包含文件上传组件（精简包），请改用完整包' });
        let buffer = null;
        for await (const part of req.parts()) {
            if (part.type === 'file' && !buffer) buffer = await part.toBuffer();
        }
        if (!buffer) throw new BusinessError('没有收到图片');
        return saveLogo(buffer, req.userIdentity.username);
    });
    fastify.delete('/', async () => resetLogo());
    fastify.get('/download-bundle', async (_req, reply) => reply.code(404).send({ error: 'Web 版不提供运营物料包，请在桌面版里生成' }));
    fastify.post('/download-bundle', async (_req, reply) => reply.code(404).send({ error: 'Web 版不提供运营物料包，请在桌面版里生成' }));
}

/** 页面里写死的 assets/logo.png：有自定义图标时返回自定义的，否则返回包里自带的 */
export async function sendLogo(reply) {
    const logo = await logoImage();
    if (!logo) return reply.code(404).send({ error: 'logo not found' });
    reply.header('Cache-Control', logo.custom ? 'no-cache' : 'public, max-age=3600');
    return reply.type('image/png').send(logo.buffer);
}

// 设置页「智能体工具」：Web 版没有 MCP 服务、危险命令规则和工具说明生成，只提供工具清单与开关
export async function agentToolsRoutes(fastify) {
    fastify.get('/catalog', async (req) => toolCatalog({ manage: Boolean(req.userIdentity.isAdmin), language: req.userIdentity.lang === 'en' ? 'en' : 'zh' }));
    fastify.patch('/catalog/access', async (req) => {
        const scope = req.body?.scope === 'group' ? 'group' : 'tool';
        const saved = await setToolAccess({ scope, id: String(req.body?.id || ''), enabled: req.body?.enabled !== false });
        if (!saved) throw new BusinessError('没有这个工具或分组', 404);
        return { success: true };
    });
    fastify.get('/servers', async () => ({ servers: [], manage: false }));
    fastify.get('/danger-rules', async () => ({ categories: [], rules: [] }));
    fastify.get('/tool-guides', async () => ({ items: [], total: 0, ready: 0, stale: 0, missing: 0 }));
}

// 数据探索页：只读查询业务表，与对话里的查库工具共用同一套守卫（只允许 SELECT、只允许业务表、最多 500 行）
export async function dbExplorerRoutes(fastify) {
    fastify.get('/tables', async () => ({ tables: tableCatalog() }));
    fastify.post('/query', async (req, reply) => {
        const out = await runSelect({ sql: String(req.body?.sql || ''), limit: req.body?.limit });
        reply.header('Cache-Control', 'no-store');
        if (!out.ok) return reply.code(400).send({ error: out.content });
        return JSON.parse(out.content);
    });
}
