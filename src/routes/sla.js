import { resolveRequestIdentity } from '../core/identity.js';
import {
    expandCompressedSnapshot,
    getAuditLog,
    listCategories,
    replaceCategories,
    collectCategoryCascadeImpact,
    deleteCategoryCascade,
    listGroups,
    replaceGroups,
    getTargets,
    replaceTargets,
    patchTarget,
    getPrefsObject,
    getPrefItem,
    upsertPrefItem,
    patchPrefsBulk,
    listSnapshots,
    getLatestSnapshot,
    addSnapshot,
    updateSnapshot,
    deleteSnapshot,
    previewDeleteSnapshot,
    cleanupRedundantSnapshots,
    getCopiedFields,
    recordCopiedField,
    deleteCopiedField,
    getFastMappingTemplates,
    saveFastMappingTemplates,
    renameMetricKey,
    readYuxiangTemplateMapping,
    saveYuxiangTemplateMapping,
    exportYuxiangBuffer,
} from '../services/sla-service.js';

export async function slaRoutes(fastify) {
    fastify.get('/categories', async () => listCategories());
    fastify.put('/categories', async (req) => ({
        success: true,
        categories: await replaceCategories(Array.isArray(req.body) ? req.body : (req.body?.categories || [])),
    }));
    fastify.get('/categories/:name/cascade-impact', async (req) => collectCategoryCascadeImpact(req.params.name));
    fastify.delete('/categories/:name/cascade', async (req) => deleteCategoryCascade(req.params.name));

    fastify.get('/groups', async () => listGroups());
    fastify.put('/groups', async (req) => ({
        success: true,
        groups: await replaceGroups(Array.isArray(req.body) ? req.body : (req.body?.groups || [])),
    }));

    fastify.get('/targets', async () => ({ items: await getTargets() }));
    fastify.put('/targets', async (req) => {
        const raw = req.body?.items || req.body || {};
        return { success: true, items: await replaceTargets(raw) };
    });
    fastify.patch('/targets/:targetKey', async (req) => ({
        success: true,
        target: await patchTarget(decodeURIComponent(req.params.targetKey), req.body || {}),
    }));

    fastify.get('/snapshots/latest', async () => ({ snapshot: await getLatestSnapshot() }));
    fastify.get('/snapshots', async (req) => listSnapshots({ view: req.query?.view === 'summary' ? 'summary' : 'full' }));
    fastify.post('/snapshot', async (req) => {
        const snapshot = expandCompressedSnapshot(req.body || {});
        const saved = await addSnapshot(snapshot);
        return { success: true, snapshot: saved, id: saved.id };
    });
    fastify.get('/snapshots/:id/delete-preview', async (req) => previewDeleteSnapshot(req.params.id));
    fastify.delete('/snapshots/:id', async (req) => {
        await deleteSnapshot(req.params.id);
        return { success: true };
    });
    fastify.put('/snapshots/:id', async (req) => ({
        success: true,
        snapshot: await updateSnapshot(req.params.id, expandCompressedSnapshot(req.body || {})),
    }));
    fastify.post('/snapshots/cleanup-redundant', async (req) => cleanupRedundantSnapshots(req.body || {}));

    fastify.get('/prefs/:schemaHash', async (req) => ({
        schemaHash: req.params.schemaHash,
        prefs: await getPrefItem(req.params.schemaHash),
    }));
    fastify.put('/prefs/:schemaHash', async (req) => ({
        success: true,
        prefs: await upsertPrefItem(req.params.schemaHash, req.body?.prefs ?? req.body),
    }));

    fastify.get('/copied-fields', async (req) => ({
        fields: await getCopiedFields(req.query?.tableType || ''),
    }));
    fastify.post('/copied-fields', async (req) => {
        await recordCopiedField(req.body?.tableType || 'default', req.body?.fieldName);
        return { success: true };
    });
    fastify.delete('/copied-fields', async (req) => {
        await deleteCopiedField(req.query?.tableType || req.body?.tableType || 'default', req.query?.fieldName || req.body?.fieldName || '');
        return { success: true };
    });

    fastify.get('/config', async () => {
        const [categories, groups, targets, prefs, copiedFields] = await Promise.all([
            listCategories(),
            listGroups(),
            getTargets(),
            getPrefsObject(),
            getCopiedFields(),
        ]);
        return { categories, groups, targets, prefs, copiedFields };
    });
    fastify.post('/config', async (req) => {
        const body = req.body || {};
        if (Array.isArray(body.categories)) await replaceCategories(body.categories);
        if (Array.isArray(body.groups)) await replaceGroups(body.groups);
        if (body.targets && typeof body.targets === 'object') await replaceTargets(body.targets);
        if (body.prefs && typeof body.prefs === 'object') await patchPrefsBulk(body.prefs);
        return { success: true };
    });
    fastify.patch('/config/prefs', async (req) => ({
        success: true,
        prefs: await patchPrefsBulk((req.body && req.body.updates) ? req.body.updates : (req.body || {})),
    }));

    fastify.get('/audit-log', async () => ({ items: await getAuditLog() }));
    fastify.get('/rule-templates/fast-mapping', async () => await getFastMappingTemplates());
    fastify.put('/rule-templates/fast-mapping', async (req) => await saveFastMappingTemplates(req.body || {}));

    fastify.post('/rename-metric', async (req) => {
        const identity = resolveRequestIdentity(req);
        return renameMetricKey(req.body?.oldKey, req.body?.newKey, identity.username);
    });

    fastify.post('/preview-yuxiang', async (req) => {
        const buf = await exportYuxiangBuffer(req.body || {});
        return { success: true, size: buf.length, base64: buf.toString('base64') };
    });
    fastify.post('/export-yuxiang', async (req, reply) => {
        const buf = await exportYuxiangBuffer(req.body || {});
        const fname = encodeURIComponent(req.body?.filename || '每月赛马-分网络-导出.xlsx');
        reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        reply.header('Content-Disposition', `attachment; filename*=UTF-8''${fname}`);
        return reply.send(buf);
    });
    fastify.get('/template-mapping', async () => readYuxiangTemplateMapping());
    fastify.post('/template-mapping', async (req) => saveYuxiangTemplateMapping(req.body || {}));
}
