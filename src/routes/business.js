// 业务页面接口：专题分析、值班表、FRT 核算、PR 稽查。数据都存统一记录表（services/record-store.js）。
// 读对所有人开放；写默认仅管理员（值班表例外，见 core/access.js）。
import { BusinessError } from '../core/errors.js';
import { listFrtSnapshots, addFrtSnapshot, deleteFrtSnapshot } from '../services/business/frt-service.js';
import { listPrauditConfigs, savePrauditConfig, deletePrauditConfig } from '../services/business/praudit-service.js';
import {
    EGYPT_WEEKDAYS, parseMonth, calculateEgyptWeeks, getSampleDutyRoster, listDutyRosters, listDutyPeople, defaultMonth, recentDutyRosters, getDutyRoster, saveDutyRoster,
} from '../services/business/duty-roster-service.js';
import {
    saveTopicSnapshot, listTopicSnapshots, getTopicSnapshot, getLatestTopicSnapshot, getTopicSeries, getEosMonthlyReport, getTopicMonthlyReport,
    deleteTopicSnapshot, getTopicMappingConfig, saveTopicMappingConfig,
} from '../services/business/topic-service.js';

import {
    listRequirements, getRequirement, getRequirementImage, createRequirement, updateRequirement, deleteRequirement,
    transportConfig, decryptBody, startUpload, receiveUploadChunk, completeUpload, cancelUpload,
} from '../services/business/requirements-service.js';

import {
    listTemplates as listSurveyTemplates, saveTemplate as saveSurveyTemplate, deleteTemplate as deleteSurveyTemplate,
    createSubmission, listSubmissions, updateSubmission, deleteSubmission, exportSubmissionsWorkbook,
} from '../services/business/survey-service.js';

import * as meetingAttendance from '../services/business/meeting-attendance-service.js';
import * as operationIncentive from '../services/business/operation-incentive-service.js';

const noStore = (fastify) => fastify.addHook('onSend', async (_req, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });
const who = (req) => req.userIdentity.username;

export async function frtRoutes(fastify) {
    noStore(fastify);
    fastify.get('/snapshots', async () => listFrtSnapshots());
    fastify.post('/snapshots', async (req, reply) => reply.code(201).send({ message: 'Snapshot saved successfully', item: await addFrtSnapshot(req.body, who(req)) }));
    fastify.delete('/snapshots/:id', async (req) => { await deleteFrtSnapshot(req.params.id); return { message: 'Snapshot deleted successfully' }; });
}

export async function prauditRoutes(fastify) {
    noStore(fastify);
    fastify.get('/configs', async () => listPrauditConfigs());
    fastify.post('/configs', async (req) => savePrauditConfig(req.body || {}, who(req)));
    fastify.delete('/configs/:id', async (req) => { await deletePrauditConfig(req.params.id); return { success: true }; });
}

export async function dutyRosterRoutes(fastify) {
    noStore(fastify);
    fastify.get('/', async (req) => getDutyRoster(String(req.query?.month || '').trim() || await defaultMonth()));
    fastify.get('/recent', async () => recentDutyRosters());
    fastify.get('/list', async () => listDutyRosters());
    fastify.get('/people', async () => ({ names: await listDutyPeople() }));
    fastify.get('/sample', async (req) => getSampleDutyRoster(String(req.query?.month || '').trim() || '2026-08'));
    fastify.get('/weeks', async (req) => {
        const { year, month, text } = parseMonth(String(req.query?.month || '').trim() || '2026-08');
        return { month: text, weeks: calculateEgyptWeeks(year, month), weekdays: EGYPT_WEEKDAYS };
    });
    fastify.post('/', async (req) => {
        if (!req.body?.month) throw new BusinessError('缺少值班表内容或月份');
        return { success: true, data: await saveDutyRoster(req.body, who(req)) };
    });
}

export async function topicSnapshotsRoutes(fastify) {
    noStore(fastify);
    // 业务错误带上桌面版前端识别的错误码
    fastify.setErrorHandler((error, _req, reply) => {
        if (!(error instanceof BusinessError)) throw error;
        return reply.code(error.code >= 400 && error.code < 600 ? error.code : 400).send({ error: error.message, code: error.codeName || 'TOPIC_SNAPSHOT_ERROR', business: true });
    });
    fastify.get('/', async (req) => listTopicSnapshots(req.query || {}));
    fastify.get('/series', async (req) => ({ items: await getTopicSeries(req.query || {}) }));
    fastify.get('/latest', async (req, reply) => {
        const item = await getLatestTopicSnapshot(req.query?.platform);
        if (!item) return reply.code(404).send({ error: '暂无专题快照', code: 'TOPIC_SNAPSHOT_NOT_FOUND' });
        return { item };
    });
    fastify.get('/eos-monthly-report', async (req) => getEosMonthlyReport(req.query?.month));
    fastify.get('/monthly-report', async (req) => getTopicMonthlyReport(req.query?.topic, req.query?.month));
    fastify.get('/mapping-config', async () => ({ config: await getTopicMappingConfig() }));
    fastify.put('/mapping-config', async (req) => ({ success: true, config: await saveTopicMappingConfig(req.body) }));
    fastify.get('/:id', async (req, reply) => {
        const item = await getTopicSnapshot(req.params.id);
        if (!item) return reply.code(404).send({ error: '专题快照不存在', code: 'TOPIC_SNAPSHOT_NOT_FOUND' });
        return { item };
    });
    fastify.post('/', async (req, reply) => {
        const result = await saveTopicSnapshot(req.body?.snapshot, { name: req.body?.name, updatedBy: who(req) });
        return reply.code(result.created ? 201 : 200).send({ message: result.created ? '专题快照已保存到服务器' : '相同专题快照已存在，已更新导入时间', ...result });
    });
    fastify.delete('/:id', async (req) => deleteTopicSnapshot(req.params.id));
}

// 需求广场：已识别用户都能提需求、改自己的需求；流转状态和指派仅管理员（服务内校验）
export async function requirementsRoutes(fastify) {
    fastify.addHook('onSend', async (_req, reply, payload) => { if (!reply.getHeader('Cache-Control')) reply.header('Cache-Control', 'private, no-store'); return payload; });
    fastify.setErrorHandler((error, _req, reply) => {
        if (!(error instanceof BusinessError)) throw error;
        return reply.code(error.code >= 400 && error.code < 600 ? error.code : 400).send({ error: error.message, code: error.codeName || 'REQUIREMENT_ERROR', business: true });
    });
    const me = (req) => req.userIdentity;
    const plain = (req, path) => decryptBody(req.body, { identity: me(req), method: req.method, path });

    fastify.get('/', async () => listRequirements());
    fastify.get('/transport-key', async (req) => transportConfig(me(req)));
    // 技能 / 工具的发布审核是桌面版多团队下的流程，Web 版没有
    fastify.get('/catalog-updates', async () => ({ updates: [], pendingCount: 0 }));
    fastify.post('/', async (req) => createRequirement(await plain(req, '/api/requirements'), me(req)));
    fastify.post('/uploads/start', async (req) => startUpload(req.body, me(req)));
    fastify.post('/uploads/:uploadId/chunk', async (req) => receiveUploadChunk(req.params.uploadId, req.body, me(req)));
    fastify.post('/uploads/:uploadId/complete', async (req, reply) => {
        const result = await completeUpload(req.params.uploadId, me(req));
        return reply.code(result.status || 200).send(result.body);
    });
    fastify.delete('/uploads/:uploadId', async (req) => { await cancelUpload(req.params.uploadId, me(req)); return { success: true }; });
    fastify.get('/:id', async (req) => getRequirement(req.params.id, me(req)));
    fastify.get('/:id/images/:index', async (req, reply) => {
        const image = await getRequirementImage(req.params.id, req.params.index);
        reply.header('Cache-Control', 'private, max-age=86400').header('X-Content-Type-Options', 'nosniff');
        return reply.type(image.type).send(image.buffer);
    });
    fastify.put('/:id', async (req) => updateRequirement(req.params.id, await plain(req, `/api/requirements/${req.params.id}`), me(req)));
    fastify.delete('/:id', async (req) => deleteRequirement(req.params.id, me(req)));
}

// 问卷调研：模板所有人可读、已识别用户可提交；模板维护、查看与导出提交记录仅管理员
export async function surveysRoutes(fastify) {
    noStore(fastify);
    const adminOnly = async (req, reply) => { if (!req.userIdentity.isAdmin) return reply.code(403).send({ error: '需要管理员权限', code: 'ADMIN_REQUIRED' }); };
    fastify.get('/templates', async () => listSurveyTemplates());
    fastify.post('/templates', async (req) => saveSurveyTemplate(req.body || {}, who(req)));
    fastify.delete('/templates/:id', async (req, reply) => (await deleteSurveyTemplate(req.params.id) ? { success: true } : reply.code(404).send({ error: '模板不存在' })));
    fastify.post('/submissions', async (req) => ({ success: true, submission: await createSubmission(req.body || {}, who(req)) }));
    fastify.get('/submissions', { preHandler: adminOnly }, async (req) => listSubmissions({ templateId: String(req.query?.templateId || ''), limit: Math.min(Number(req.query?.limit) || 100, 500) }));
    fastify.put('/submissions/:id', async (req) => ({ success: true, submission: await updateSubmission(req.params.id, req.body || {}, who(req)) }));
    fastify.delete('/submissions/:id', async (req, reply) => (await deleteSubmission(req.params.id) ? { success: true } : reply.code(404).send({ error: '记录不存在' })));
    fastify.get('/export.xlsx', { preHandler: adminOnly }, async (req, reply) => {
        const { filename, buffer } = await exportSubmissionsWorkbook(String(req.query?.templateId || ''));
        reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
        return reply.send(buffer);
    });
}

// 会议考勤、操作激励的历史快照：已识别用户都能维护（与主线版一致）。两者接口形状相同，只是日期字段不同。
function snapshotRoutes(fastify, service, { label, pick }) {
    noStore(fastify);
    const full = (req) => req.query?.full === '1' || req.query?.full === 'true';
    fastify.get('/', async (req) => {
        const items = await service.listSnapshots({ ...req.query, includePayload: full(req) });
        return { success: true, items, data: items, count: items.length };
    });
    fastify.get('/extract-roster', async () => {
        const roster = await service.extractRoster();
        return { success: true, roster, items: roster, data: roster, count: roster.length };
    });
    fastify.get('/:id', async (req, reply) => {
        const item = await service.getSnapshot(req.params.id);
        if (!item) return reply.code(404).send({ error: `未找到指定${label}快照`, code: 'SNAPSHOT_NOT_FOUND' });
        return { success: true, item, data: item };
    });
    fastify.post('/', async (req, reply) => {
        if (!req.body?.payload) return reply.code(400).send({ error: '缺少快照数据 (payload)' });
        const item = await service.saveSnapshot(pick(req.body), who(req));
        return reply.code(201).send({ success: true, item, data: item });
    });
    fastify.put('/:id', async (req, reply) => {
        if (!req.body?.title) return reply.code(400).send({ error: '缺少快照新标题' });
        const item = await service.renameSnapshot(req.params.id, req.body.title, who(req));
        if (!item) return reply.code(404).send({ error: `未找到指定${label}快照` });
        return { success: true, item, data: item };
    });
    fastify.delete('/:id', async (req, reply) => {
        if (!await service.deleteSnapshot(req.params.id)) return reply.code(404).send({ error: `未找到指定${label}快照或删除失败` });
        return { success: true };
    });
}

export async function operationIncentiveSnapshotsRoutes(fastify) {
    snapshotRoutes(fastify, operationIncentive, { label: '操作激励', pick: ({ id, title, period, sourceFile, summary, payload }) => ({ id, title, period, sourceFile, summary, payload }) });
}

export async function meetingSnapshotsRoutes(fastify) {
    // 固定路径要先于 /:id 注册
    fastify.get('/attendance-check', async (req) => {
        const result = await meetingAttendance.checkPersonAttendance({ staffId: req.query?.staffId || req.query?.account, name: req.query?.name });
        return { success: true, ...result, data: result };
    });
    fastify.post('/batch-attendance-check', async (req) => {
        const result = await meetingAttendance.batchCheckAttendance(req.body?.persons || []);
        return { success: true, results: result, data: result };
    });
    fastify.get('/settings/rosters', async () => ({ success: true, data: await meetingAttendance.getRosterSettings() }));
    fastify.put('/settings/rosters', async (req) => ({ success: true, data: await meetingAttendance.saveRosterSettings({ mandatoryAttendees: req.body?.mandatoryAttendees, exemptions: req.body?.exemptions }) }));
    snapshotRoutes(fastify, meetingAttendance, { label: '会议', pick: ({ id, title, meetingDate, summary, payload }) => ({ id, title, meetingDate, summary, payload }) });
}
