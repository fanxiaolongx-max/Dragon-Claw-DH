import { resolveRequestIdentity } from '../core/identity.js';
import {
    listMonthlySnapshots,
    getMonthlySnapshot,
    saveMonthlySnapshot,
    renameMonthlySnapshot,
    deleteMonthlySnapshot,
    exportReportMsgBuffer,
    listAiReports,
    readAiReport,
    saveAiReport,
    deleteAiReport,
    getAiReportTemplate,
    listAiReportSources,
    listAiReportMetrics,
    listAiReportDatasets,
    describeAiReportSheet,
    runAiReportData,
    listAiReportImages,
    saveAiReportImage,
    readAiReportImage,
    proposeAiReportImageDeletion,
    changeAiReportImageDeletion,
    aiReportCellChat,
    aiReportCellPrompt,
    aiReportCellTextEdit,
    aiReportCellGist,
    aiReportCellCompile,
    aiReportOverallChat,
    aiReportOverallPrompt,
    aiReportOverallTheme,
    aiReportChapterChat,
    aiReportChapterPrompt,
    aiReportCellRestyle,
    aiReportCellNarrative,
    aiReportTemplateField,
    aiReportTemplateFieldChat,
    aiReportTemplateFieldPrompt,
    aiReportImageChat,
    aiReportImageGenerate,
    aiReportDebugExplain,
} from '../services/monthly-service.js';

export async function monthlySnapshotsRoutes(fastify) {
    fastify.get('/', async (req) => {
        const { toolKey, topicKey, month, full } = req.query || {};
        const items = await listMonthlySnapshots({
            toolKey,
            topicKey,
            month,
            includePayload: full === '1' || full === 'true',
        });
        return { success: true, items };
    });

    fastify.get('/:id', async (req, reply) => {
        const item = await getMonthlySnapshot(req.params.id);
        if (!item) return reply.code(404).send({ error: '未找到指定快照', code: 'SNAPSHOT_NOT_FOUND' });
        return { success: true, item };
    });

    fastify.post('/', async (req, reply) => {
        const identity = resolveRequestIdentity(req);
        const item = await saveMonthlySnapshot(req.body || {}, identity.username);
        return reply.code(201).send({ success: true, item });
    });

    fastify.put('/:id', async (req, reply) => {
        const item = await renameMonthlySnapshot(req.params.id, req.body?.name);
        if (!item) return reply.code(404).send({ error: '未找到指定快照' });
        return { success: true, item };
    });

    fastify.delete('/:id', async (req, reply) => {
        const deleted = await deleteMonthlySnapshot(req.params.id);
        if (!deleted) return reply.code(404).send({ error: '未找到指定快照或删除失败' });
        return { success: true };
    });
}

export async function reportMsgRoutes(fastify) {
    fastify.post('/export', async (req, reply) => {
        const { buffer, headers } = await exportReportMsgBuffer(req.body || {});
        reply.header('Content-Type', 'application/vnd.ms-outlook');
        reply.header('Content-Length', buffer.length);
        for (const [k, v] of Object.entries(headers)) reply.header(k, v);
        reply.header('Access-Control-Expose-Headers', Object.keys(headers).join(', '));
        return reply.send(buffer);
    });
}

export async function aiReportRoutes(fastify) {
    const userOf = (req) => resolveRequestIdentity(req).username;

    fastify.get('/documents', async () => listAiReports());
    fastify.get('/documents/:id', async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        return readAiReport(req.params.id);
    });
    fastify.post('/documents', async (req) => saveAiReport(req.body || {}, userOf(req)));
    fastify.delete('/documents/:id', async (req) => deleteAiReport(req.params.id));

    fastify.get('/template', async (req) => getAiReportTemplate(req.query?.month));
    fastify.get('/sources', async (req) => listAiReportSources(req.query?.month));
    fastify.get('/sources/sheets/:sheetId', async (req) => describeAiReportSheet(req.params.sheetId));
    fastify.get('/metrics', async (req) => listAiReportMetrics(req.query?.month));
    fastify.get('/datasets', async (req) => listAiReportDatasets(req.query?.month));
    fastify.post('/run-data', async (req) => runAiReportData(req.body || {}));

    fastify.post('/cell/chat', async (req) => aiReportCellChat(req.body || {}));
    fastify.post('/cell/prompt', async (req) => aiReportCellPrompt(req.body || {}));
    fastify.post('/cell/text-edit', async (req) => aiReportCellTextEdit(req.body || {}));
    fastify.post('/cell/gist', async (req) => aiReportCellGist(req.body || {}));
    fastify.post('/cell/compile', async (req) => aiReportCellCompile(req.body || {}));
    fastify.post('/cell/restyle', async (req) => aiReportCellRestyle(req.body || {}));
    fastify.post('/cell/narrative', async (req) => aiReportCellNarrative(req.body || {}));

    fastify.post('/report/chat', async (req) => aiReportOverallChat(req.body || {}));
    fastify.post('/report/prompt', async (req) => aiReportOverallPrompt(req.body || {}));
    fastify.post('/report/theme', async (req) => aiReportOverallTheme(req.body || {}));

    fastify.post('/chapter/chat', async (req) => aiReportChapterChat(req.body || {}));
    fastify.post('/chapter/prompt', async (req) => aiReportChapterPrompt(req.body || {}));

    fastify.post('/template/field', async (req) => aiReportTemplateField(req.body || {}));
    fastify.post('/template/field/chat', async (req) => aiReportTemplateFieldChat(req.body || {}));
    fastify.post('/template/field/prompt', async (req) => aiReportTemplateFieldPrompt(req.body || {}));

    fastify.get('/images', async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        return listAiReportImages({ page: req.query?.page, pageSize: req.query?.page_size });
    });
    fastify.post('/images', async (req, reply) => {
        const filePart = await req.file();
        if (!filePart) return reply.code(400).send({ error: '没有收到图片' });
        const bytes = await filePart.toBuffer();
        return saveAiReportImage({ bytes, name: filePart.filename || '上传的图片', source: 'upload', user: userOf(req) });
    });
    fastify.get('/images/:id', async (req, reply) => {
        const img = await readAiReportImage(req.params.id);
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Cache-Control', 'private, max-age=31536000, immutable');
        if (img.mime === 'image/svg+xml') {
            reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
        }
        reply.type(img.mime);
        return reply.send(img.bytes);
    });
    fastify.post('/image-deletions', async (req) => proposeAiReportImageDeletion(req.body?.ids || [], userOf(req)));
    for (const op of ['confirm', 'cancel', 'restore']) {
        fastify.post(`/image-deletions/:id/${op}`, async (req, reply) => {
            if (op === 'confirm' && req.body?.confirmed !== true) {
                return reply.code(400).send({ error: '需要明确确认这份图片删除清单' });
            }
            return changeAiReportImageDeletion(req.params.id, userOf(req), op);
        });
    }

    fastify.post('/image/chat', async (req) => aiReportImageChat(req.body || {}));
    fastify.post('/image/generate', async (req) => aiReportImageGenerate(req.body || {}, userOf(req)));
    fastify.post('/debug/explain', async (req) => aiReportDebugExplain(req.body || {}));
}
