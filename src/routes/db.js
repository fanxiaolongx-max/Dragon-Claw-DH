import {
    saveManualAdjustAttachment,
    getReportAsset,
    saveReportDashboard,
    listReportSnapshots,
    getLatestFailing,
    getFailingBySnapshotId,
    getDashboardConfig,
    setDashboardConfig,
    getMonthlyReportData,
    getMetricCountTrends,
    getExpiringWarningTrends,
    getMetricItemTrend,
    listBigscreenOwners,
    saveBigscreenOwners,
    exportReportDataBackupZip,
    importReportDataBackupZip,
    sendExpediteNotification,
} from '../services/report-service.js';

export async function dbRoutes(fastify) {
    fastify.get('/images/:filename', async (req, reply) => {
        const asset = await getReportAsset(req.params.filename);
        if (!asset) return reply.code(404).send({ error: 'Asset not found' });
        reply.header('Content-Type', asset.mimeType);
        reply.header('X-Content-Type-Options', 'nosniff');
        return reply.send(asset.buffer);
    });

    fastify.post('/manual-adjust-attachments', async (req, reply) => {
        const filePart = await req.file();
        if (!filePart) return reply.code(400).send({ error: '请选择需要上传的附件' });
        const buffer = await filePart.toBuffer();
        return saveManualAdjustAttachment({
            buffer,
            originalname: filePart.filename,
            mimetype: filePart.mimetype,
        });
    });

    fastify.post('/save', async (req) => saveReportDashboard(req.body || {}));

    fastify.get('/snapshots', async (_req, reply) => {
        reply.header('X-Data-Source', 'mysql');
        return listReportSnapshots();
    });

    fastify.get('/report-data-backup/export', async (_req, reply) => {
        const { buffer, manifest } = await exportReportDataBackupZip();
        const date = new Date().toISOString().replace(/[:.]/g, '-');
        reply.header('Content-Type', 'application/zip');
        reply.header('Content-Disposition', `attachment; filename="tools-report-data-${date}.zip"`);
        reply.header('Cache-Control', 'no-store');
        reply.header('X-Backup-Counts', Buffer.from(JSON.stringify(manifest.counts)).toString('base64'));
        return reply.send(buffer);
    });

    fastify.post('/report-data-backup/import', async (req, reply) => {
        const filePart = await req.file();
        if (!filePart) return reply.code(400).send({ error: '请选择报表数据备份包' });
        const buffer = await filePart.toBuffer();
        const mode = filePart.fields?.mode?.value === 'replace' ? 'replace' : 'merge';
        const confirmText = filePart.fields?.confirmationText?.value || '';
        if (mode === 'replace' && confirmText !== '确认清空恢复') {
            return reply.code(400).send({ error: '清空恢复前必须输入“确认清空恢复”' });
        }
        return importReportDataBackupZip(buffer, { mode });
    });

    fastify.get('/latest_failing', async () => getLatestFailing());

    fastify.get('/failing/:snapshot_id', async (req) => getFailingBySnapshotId(req.params.snapshot_id, req.query?.month));

    fastify.get('/config/:key', async (req, reply) => {
        reply.header('X-Data-Source', 'mysql');
        return getDashboardConfig(req.params.key);
    });

    fastify.post('/config/:key', async (req) => setDashboardConfig(req.params.key, req.body));

    fastify.get('/monthly_report_data', async (req, reply) => {
        reply.header('X-Data-Source', 'mysql');
        return getMonthlyReportData({ startDate: req.query?.startDate, endDate: req.query?.endDate });
    });

    fastify.get('/metric_count_trends', async (req) => getMetricCountTrends(req.query?.days));
    fastify.get('/expiring_warning_trends', async (req) => getExpiringWarningTrends(req.query?.days));
    fastify.get('/metric_item_trend', async (req) => getMetricItemTrend(req.query || {}));

    fastify.get('/bigscreen_owners', async () => listBigscreenOwners());
    fastify.post('/bigscreen_owners', async (req) => saveBigscreenOwners(req.body?.items || []));
}

export async function expediteRoutes(fastify) {
    fastify.post('/notify', async (req) => sendExpediteNotification(req.body || {}));
}
