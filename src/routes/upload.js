import { resolveRequestIdentity } from '../core/identity.js';
import {
    listUploadHistory,
    addUploadHistory,
    clearUploadHistory,
    getImportSettings,
    saveImportSettings,
    createBatch,
    saveFile,
    getFile,
    saveSheets,
    getSheet,
    getSheetEditor,
    updateSheet,
    setFileCategory,
    getSheetPresentation,
    saveSheetPresentation,
    saveQuickMetrics,
    getSourceCatalog,
    getSourceRangeCounts,
    searchImportSources,
    getArchivedSnapshot,
    getSection,
    getMetricTable,
    listLogos,
    saveLogo,
    getLogo,
    listPresets,
    savePreset,
    deletePreset,
    getDefaultTemplate,
    saveDefaultTemplate,
    listMonthlyDocuments,
    getMonthlyDocument,
    saveMonthlyDocument,
    deleteMonthlyDocuments,
    listDrafts,
    readDraft,
    saveDraft,
    removeDraft,
    cleanupDrafts,
} from '../services/upload-service.js';

export async function uploadRoutes(fastify) {
    fastify.get('/history', async (req, reply) => {
        reply.header('X-Data-Source', 'mysql');
        return listUploadHistory({ tool: req.query?.tool, limit: req.query?.limit });
    });

    fastify.post('/history', async (req) => {
        const item = await addUploadHistory(req.body || {});
        return { success: true, item };
    });

    fastify.delete('/history', async (req) => clearUploadHistory({ tool: req.query?.tool }));

    fastify.get('/import-settings', async (_req, reply) => {
        reply.header('Cache-Control', 'no-store');
        return getImportSettings();
    });
    fastify.put('/import-settings', async (req) => saveImportSettings(req.body || {}));

    fastify.post('/source-batches', async (req) => createBatch(req.body || {}));

    fastify.post('/source-batches/:id/files', async (req, reply) => {
        const filePart = await req.file();
        if (!filePart) return reply.code(400).send({ error: 'Missing original file' });
        const buffer = await filePart.toBuffer();
        const fields = filePart.fields || {};
        const originalName = fields.originalName?.value || filePart.filename;
        const kind = fields.kind?.value === 'structured' ? 'structured' : 'original';
        return saveFile(req.params.id, { buffer, originalName, filename: filePart.filename }, kind);
    });

    fastify.put('/source-files/:id/sheets', async (req) => {
        await saveSheets(req.params.id, req.body?.sheets, req.body?.parseError);
        return { success: true };
    });

    fastify.put('/source-files/:id/category', async (req) => setFileCategory(req.params.id, req.body?.category));

    fastify.get('/source-files/:id/download', async (req, reply) => {
        const file = await getFile(req.params.id, true);
        if (!file) return reply.code(404).send({ error: 'Source file not found' });
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
        return reply.send(file.original_blob);
    });

    fastify.get('/source-search', async (req) => searchImportSources(req.query || {}));

    fastify.get('/source-range-counts', async (req) => getSourceRangeCounts(Number(req.query?.days || 0), String(req.query?.period || '')));

    fastify.get('/source-catalog', async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        const days = req.query?.days === undefined ? 0 : Number(req.query.days);
        const cat = await getSourceCatalog({ days, stage: req.query?.stage });
        cat.diagnostics = { ...cat.diagnostics, days };
        return cat;
    });

    fastify.get('/source-sheets/:id/editor', async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        const state = await getSheetEditor(req.params.id);
        return { ...state, editable: true, canCreateMetric: true, readOnlyReason: '' };
    });
    fastify.put('/source-sheets/:id/editor', async (req) => updateSheet(req.params.id, req.body || {}));
    fastify.post('/source-sheets/:id/quick-metrics', async (req) => saveQuickMetrics(req.params.id, req.body || {}));
    fastify.get('/source-sheets/:id/presentation', async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        return { ...(await getSheetPresentation(req.params.id)), canWrite: true };
    });
    fastify.put('/source-sheets/:id/presentation', async (req) => saveSheetPresentation(req.params.id, req.body || {}));

    fastify.get('/source-sheets/:id', async (req, reply) => {
        const sheet = await getSheet(req.params.id);
        if (!sheet) return reply.code(404).send({ error: 'Worksheet not found' });
        return sheet;
    });

    fastify.get('/source-snapshots/:id', async (req, reply) => {
        const snap = await getArchivedSnapshot(req.params.id);
        if (!snap) return reply.code(404).send({ error: 'Import snapshot not found' });
        return snap;
    });
    fastify.get('/source-snapshots/:id/sections/:key', async (req, reply) => {
        const sec = await getSection(req.params.id, req.params.key);
        if (!sec) return reply.code(404).send({ error: 'Extracted source section not found' });
        return sec;
    });
    fastify.get('/source-snapshots/:id/metrics/:key/rows', async (req, reply) => {
        const tbl = await getMetricTable(req.params.id, req.params.key);
        if (!tbl) return reply.code(404).send({ error: 'Metric source table not found' });
        return tbl;
    });

    fastify.get('/monthly-logos', async () => listLogos());
    fastify.post('/monthly-logos', async (req, reply) => {
        const filePart = await req.file();
        if (!filePart) return reply.code(400).send({ error: 'Missing image file' });
        const buffer = await filePart.toBuffer();
        return saveLogo({ buffer, originalname: filePart.filename, mimetype: filePart.mimetype });
    });
    fastify.get('/monthly-logos/:id/image', async (req, reply) => {
        const logo = await getLogo(req.params.id);
        if (!logo) return reply.code(404).send({ error: 'Logo not found' });
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.type(logo.mime || 'image/png');
        return reply.send(logo.image_blob);
    });

    for (const [slug, type] of [
        ['monthly-mapping-presets', 'mapping'],
        ['monthly-data-format-presets', 'dataFormat'],
        ['monthly-component-presets', 'component'],
    ]) {
        fastify.get(`/${slug}`, async () => listPresets(type));
        fastify.post(`/${slug}`, async (req) => savePreset(type, req.body || {}));
        fastify.put(`/${slug}/:id`, async (req) => savePreset(type, req.body || {}, req.params.id));
        fastify.delete(`/${slug}/:id`, async (req) => deletePreset(type, req.params.id));
    }

    fastify.get('/monthly-default-template', async () => getDefaultTemplate());
    fastify.put('/monthly-default-template', async (req) => saveDefaultTemplate(req.body || {}));
    fastify.post('/monthly-default-template/sync-repository', async (_req, reply) => (
        reply.code(403).send({ error: '数字人云端部署模式不支持写入源码仓库模板' })
    ));

    fastify.get('/monthly-documents', async () => listMonthlyDocuments());
    fastify.get('/monthly-documents/:id', async (req, reply) => {
        const doc = await getMonthlyDocument(req.params.id);
        if (!doc) return reply.code(404).send({ error: 'Monthly document not found' });
        return doc;
    });
    fastify.post('/monthly-documents', async (req) => {
        const headerRevision = req.headers['x-monthly-base-revision'];
        const expectedRevision = headerRevision === 'missing' ? null : (headerRevision ?? req.body?.expectedRevision);
        return saveMonthlyDocument(req.body || {}, { expectedRevision });
    });
    fastify.delete('/monthly-documents', async (req, reply) => {
        if (req.body?.confirmed !== true) return reply.code(400).send({ error: 'Confirm monthly report deletion' });
        return deleteMonthlyDocuments(req.body.ids || []);
    });

    const ownerOf = (req) => resolveRequestIdentity(req).username;
    fastify.get('/monthly-drafts', async (req) => listDrafts(ownerOf(req), { archived: req.query?.archived === '1' }));
    fastify.post('/monthly-drafts/cleanup', async (req) => cleanupDrafts(ownerOf(req), req.body || {}));
    fastify.get('/monthly-drafts/:id', async (req) => readDraft(ownerOf(req), req.params.id));
    fastify.put('/monthly-drafts/:id', async (req) => saveDraft(ownerOf(req), req.params.id, req.body || {}));
    fastify.delete('/monthly-drafts/:id', async (req) => removeDraft(ownerOf(req), req.params.id));
}
