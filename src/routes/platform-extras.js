// 消息中心、平台标识（Logo）、智能体工具清单的接口。
import { BusinessError } from '../core/errors.js';
import { listAlerts, alertSummary, markAlertsRead, removeAlerts, backfillAlertSummaries } from '../services/alert-service.js';
import { logoStatus, logoImage, saveLogo, resetLogo } from '../services/logo-service.js';
import { toolCatalog, setToolAccess } from '../services/tool-catalog-service.js';
import { runSelect, explorerCatalog, explorerDatabases } from '../agent/tools.js';
import * as dataWatch from '../services/data-watch-service.js';
import * as dataDict from '../services/data-dictionary-service.js';
import * as dataIssues from '../services/data-issue-service.js';

// 消息只属于本人：每个接口都按当前工号取
export async function alertCenterRoutes(fastify) {
    const me = (req) => req.userIdentity.username;
    fastify.addHook('onSend', async (_req, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });
    fastify.get('/summary', async (req) => alertSummary(me(req)));
    fastify.get('/events', async (req) => listAlerts(me(req), { status: String(req.query?.status || ''), type: String(req.query?.type || ''), before: req.query?.before, warningsOnly: req.query?.warnings === '1', limit: req.query?.limit }));
    fastify.put('/events/read', async (req) => markAlertsRead(me(req), Array.isArray(req.body?.ids) ? req.body.ids : []));
    fastify.put('/events/read-all', async (req) => markAlertsRead(me(req)));
    fastify.put('/events/archive-all', async (req) => removeAlerts(me(req)));
    fastify.post('/events/clear-all', async (req) => removeAlerts(me(req)));
    fastify.delete('/events/:id', async (req) => removeAlerts(me(req), req.params.id));
    fastify.post('/ai/backfill', async (req) => backfillAlertSummaries(me(req), { limit: Math.min(Number(req.body?.limit) || 50, 120) }));
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
    // 进入页面时实查：应用库列出库里实际存在的表（敏感表除外），业务库列出平台授权数据源里的表
    fastify.get('/databases', async () => ({ databases: explorerDatabases() }));
    fastify.get('/tables', async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        return explorerCatalog(req.query?.database === 'business' ? 'business' : 'app');
    });
    fastify.post('/query', async (req, reply) => {
        const business = req.body?.database === 'business';
        const source = explorerDatabases().find((d) => d.id === 'business');
        if (business && !source.configured) return reply.code(400).send({ error: '还没有配置业务数据源' });
        const out = await runSelect({ database: business ? source.source : undefined, sql: String(req.body?.sql || ''), limit: req.body?.limit, explorer: true });
        reply.header('Cache-Control', 'no-store');
        if (!out.ok) return reply.code(400).send({ error: out.content });
        return JSON.parse(out.content);
    });

    // ── 数据治理：巡检、收集、表字典、派生表（整个 /db-explorer 只给管理员，见 core/access.js）──
    const actor = (req) => req.userIdentity?.username || '';
    const fileName = (prefix, ext) => `${prefix}-${new Date().toISOString().slice(0, 10)}.${ext}`;
    fastify.register(async (g) => {
        g.addHook('onSend', async (_req, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });
        g.get('/status', async () => dataWatch.status());
        g.get('/settings', async () => dataWatch.getSettings());
        g.put('/settings', async (req) => dataWatch.saveSettings(req.body || {}, actor(req)));
        // 一键体检：check 巡检行数 / collect 收集前 N 行 / all 两样都做；后台执行，进度看 /status
        g.post('/run', async (req, reply) => {
            const kind = ['check', 'collect', 'all'].includes(req.body?.kind) ? req.body.kind : 'all';
            const running = await dataWatch.runningJob();
            if (running) return reply.code(409).send({ error: '已有巡检或收集在进行，请等它完成', running });
            dataWatch.startInBackground(kind, actor(req));
            return reply.code(202).send({ started: kind });
        });
        g.get('/runs', async (req) => ({ items: await dataWatch.listRuns(req.query?.limit) }));
        g.get('/runs/:id', async (req, reply) => (await dataWatch.getRun(req.params.id)) || reply.code(404).send({ error: '没有这轮巡检' }));
        g.get('/collections', async () => ({ items: await dataWatch.listCollections() }));
        g.get('/collections/:id/tables', async (req) => ({ items: await dataWatch.collectionTables(req.params.id) }));
        g.get('/collections/:id/export', async (req, reply) => {
            const head = (await dataWatch.listCollections()).find((c) => c.id === req.params.id);
            if (!head) return reply.code(404).send({ error: '没有这次收集' });
            const tables = await dataWatch.collectionTables(req.params.id, { withRows: true });
            reply.header('Content-Type', 'application/json; charset=utf-8');
            reply.header('Content-Disposition', `attachment; filename="${fileName('business-db-collection', 'json')}"`);
            return JSON.stringify({ collection: head, tables }, null, 1);
        });
        g.get('/catalog', async () => dataDict.catalogView());
        g.get('/tables/:key', async (req) => dataDict.tableDetail(req.params.key));
        g.put('/dictionary/:key', async (req) => dataDict.saveDictionaryEntry(req.params.key, req.body || {}, actor(req)));
        g.post('/dictionary/import', async (req) => dataDict.importDictionary(req.body || {}, { actor: actor(req), mode: req.body?.mode === 'replace' ? 'replace' : 'merge' }));
        // 默认导出 Excel（表标识 / 字典 / 最新体检 / 字段分组上色）；?format=csv 或安装包没有 Excel 组件时退回 CSV
        g.get('/dictionary/export', async (req, reply) => {
            const xlsx = req.query?.format === 'csv' ? null : await dataDict.exportDictionaryXlsx();
            if (xlsx) {
                reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                reply.header('Content-Disposition', `attachment; filename="${fileName('table-dictionary', 'xlsx')}"`);
                return reply.send(xlsx);
            }
            reply.header('Content-Type', 'text/csv; charset=utf-8');
            reply.header('Content-Disposition', `attachment; filename="${fileName('table-dictionary', 'csv')}"`);
            return dataDict.exportDictionaryCsv();
        });
        // 数据源问题跟踪：空表 / 库里没有 / 查询失败，从第一次发现开始计时；解决率、超期
        g.get('/issues', async () => dataIssues.issuesView());
        g.put('/issues/config', async (req) => dataIssues.saveConfig(req.body || {}));
        g.put('/issues/:key', async (req, reply) => (await dataIssues.updateIssue(req.params.key, req.body || {})) || reply.code(404).send({ error: '这张表没有未解决的问题' }));
        g.get('/derived', async () => ({ items: await dataDict.listDerived() }));
        g.post('/derived/preview', async (req) => dataDict.previewDerived(req.body || {}));
        // 批量导入看板 SQL（「看板--指标」+ SQL，多段）；dryRun 只看拆分和改写结果
        g.post('/derived/import', async (req) => dataDict.importBoardSql({ text: String(req.body?.text || ''), dryRun: req.body?.dryRun === true }, actor(req)));
        g.post('/derived', async (req) => dataDict.saveDerived(req.body || {}, actor(req)));
        g.put('/derived/:id', async (req) => dataDict.saveDerived({ ...(req.body || {}), id: req.params.id }, actor(req)));
        g.delete('/derived/:id', async (req, reply) => ((await dataDict.deleteDerived(req.params.id)) ? { success: true } : reply.code(404).send({ error: '派生表不存在' })));
        g.post('/derived/:id/refresh', async (req) => dataDict.refreshDerived(req.params.id, { reason: '手动重算' }));
        g.get('/derived/:id/data', async (req) => dataDict.derivedData(req.params.id, { limit: req.query?.limit, offset: req.query?.offset }));
    }, { prefix: '/governance' });
}
