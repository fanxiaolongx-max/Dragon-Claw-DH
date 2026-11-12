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
