import fs from 'node:fs';
import path from 'node:path';
import { STATIC_DIR } from '../config.js';
import {
    listCategories,
    addCategory,
    deleteCategory,
    listScripts,
    saveScripts,
    deleteScript,
    moveScriptCategory,
    renameScript,
    exportBackup,
    importBackup,
    getBatchScope,
    saveBatchScope,
    parseFetchSnippet,
    nameScriptWithAi,
    analyzeFetchWithAi,
    saveAutoImportDatasets,
    getAutoImportSession,
} from '../services/uiv-service.js';

export async function uivRoutes(fastify) {
    fastify.get('/scripts', async (_req, reply) => {
        reply.header('X-Data-Source', 'mysql');
        const [scripts, categories] = await Promise.all([listScripts(), listCategories()]);
        return { scripts, categories };
    });

    fastify.post('/scripts', async (req, reply) => {
        const items = req.body;
        const arr = Array.isArray(items) ? items : (Array.isArray(items?.items) ? items.items : null);
        if (!arr || !arr.length) return reply.code(400).send({ error: '参数错误：items 必须为非空数组' });
        const saved = await saveScripts(arr);
        return { success: true, count: saved.length };
    });

    fastify.delete('/scripts/:id', async (req) => {
        await deleteScript(req.params.id);
        return { success: true };
    });

    fastify.patch('/scripts/:id/category', async (req) => moveScriptCategory(req.params.id, req.body?.category));
    fastify.patch('/scripts/:id/rename', async (req) => renameScript(req.params.id, req.body?.name));

    fastify.get('/categories', async () => listCategories());
    fastify.post('/categories', async (req, reply) => {
        const categories = await addCategory(req.body?.name);
        return reply.code(201).send({ categories });
    });
    fastify.delete('/categories/:name', async (req) => ({ categories: await deleteCategory(req.params.name) }));

    fastify.get('/backup', async () => exportBackup());
    fastify.post('/backup', async (req) => importBackup(req.body || {}));

    fastify.get('/batch-scope', async () => getBatchScope());
    fastify.post('/batch-scope', async (req) => saveBatchScope(req.body || {}));

    fastify.get('/extension-download', async (_req, reply) => {
        const filePath = path.join(STATIC_DIR, 'downloads', 'uivision-extension-9.6.1.zip');
        if (!fs.existsSync(filePath)) return reply.code(404).send({ error: '插件安装包未找到' });
        reply.header('Content-Type', 'application/zip');
        reply.header('Content-Disposition', 'attachment; filename="uivision-extension-9.6.1.zip"');
        return reply.send(fs.createReadStream(filePath));
    });

    fastify.post('/run-uivision-macro', async (_req, reply) => {
        return reply.code(501).send({
            code: 'WEB_LOCAL_BROWSER_DISABLED',
            error: '数字人云端 Web 版不支持从服务器拉起本地 Chrome / UI.Vision 跑宏，请在本地浏览器打开页面后使用扩展插件或控制台脚本抓取，再一键自动导入。',
        });
    });
}

export async function uivAiAdapterRoutes(fastify) {
    fastify.post('/parse-fetch', async (req, reply) => {
        try {
            const parsed = parseFetchSnippet(req.body?.source);
            const sensitiveHeaderNames = Object.keys(parsed.headers || {}).filter((k) => /authorization|cookie|token|secret|api[-_]?key|csrf|xsrf/i.test(k));
            return { parsed, sensitiveHeaderNames };
        } catch (err) {
            return reply.code(400).send({ error: err.message || 'Copy as fetch 解析失败' });
        }
    });

    fastify.post('/name-script', async (req) => nameScriptWithAi(req.body || {}));
    fastify.post('/analyze', async (req) => analyzeFetchWithAi(req.body || {}));
}

export async function uivAutoImportRoutes(fastify) {
    fastify.post('/:sessionId/datasets', async (req) => saveAutoImportDatasets(req.params.sessionId, req.body || {}));
    fastify.get('/:sessionId', async (req, reply) => {
        const session = await getAutoImportSession(req.params.sessionId);
        if (!session) return reply.code(404).send({ error: '自动导入会话不存在或已过期' });
        reply.header('Cache-Control', 'no-store');
        return session;
    });
}
