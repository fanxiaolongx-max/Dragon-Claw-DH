// 专题分析：NetCare / DataFab 专题快照的保存、趋势与月报。计算逻辑移植自桌面版；
// 月报引擎（static/js/shared/topic-monthly-engine.js）前后端共用同一份。
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { STATIC_DIR } from '../../config.js';
import { BusinessError, NotFoundError } from '../../core/errors.js';
import { kvGet, kvSet } from '../../dao/scoped.js';
import { listRecords, countRecords, getRecord, findRecordByHash, putRecord, deleteRecord } from '../record-store.js';

const require = createRequire(import.meta.url);
const { buildEosTopic, buildEosMonthlyReport } = require('./topic-eos-report.cjs');
const monthlyEngine = require(path.join(STATIC_DIR, 'js', 'shared', 'topic-monthly-engine.js'));

const KIND = 'topic_snapshot';
const SNAPSHOT_SCHEMA = 'uivf12-topic-snapshot';
const SNAPSHOT_VERSION = 1;
const PLATFORMS = new Set(['netcare', 'datafab']);
const MAX_PAYLOAD_BYTES = 45 * 1024 * 1024;
const MAPPING_KEY = 'topic_customer_mapping';
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const fail = (message, status = 400, codeName = 'INVALID_TOPIC_SNAPSHOT') => Object.assign(new BusinessError(message, status), { codeName });
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function validIsoTime(value, fallback) {
    const date = new Date(value || '');
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

export function normalizeSnapshot(input) {
    if (!isObject(input)) throw fail('缺少专题快照数据');
    if (input.schema !== SNAPSHOT_SCHEMA || Number(input.version) !== SNAPSHOT_VERSION) throw fail('不支持的专题快照格式');
    const platform = String(input.platform || '').toLowerCase();
    if (!PLATFORMS.has(platform)) throw fail('不支持的专题平台');
    if (!isObject(input.data)) throw fail('专题快照缺少 data');
    if (platform === 'netcare') {
        const data = input.data;
        if (![data.certificate, data.eosProduct, data.eosVersion].every(Array.isArray)
            || !Array.isArray(data.change?.rows) || !Array.isArray(data.interception?.rows)
            || !Array.isArray(data.sr?.summary) || !Array.isArray(data.sr?.monthly)) {
            throw fail('NetCare 专题快照数据结构不完整');
        }
    } else if (!Array.isArray(input.data.months) || !Array.isArray(input.data.detail)) {
        throw fail('DataFab 专题快照数据结构不完整');
    }
    const now = new Date().toISOString();
    return {
        ...input,
        schema: SNAPSHOT_SCHEMA,
        version: SNAPSHOT_VERSION,
        platform,
        capturedAt: validIsoTime(input.capturedAt, validIsoTime(input.exportedAt, now)),
        exportedAt: validIsoTime(input.exportedAt, now),
        scope: isObject(input.scope) ? input.scope : {},
        settings: isObject(input.settings) ? input.settings : {},
    };
}

const rowCount = (value) => (Array.isArray(value) ? value.length : 0);
const number = (value) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; };
function round2(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
}
const ratePercent = (value) => { const parsed = number(value); return round2(Math.abs(parsed) <= 1 ? parsed * 100 : parsed); };
const sumField = (rows, field) => (rows || []).reduce((sum, row) => sum + number(row?.[field]), 0);
const ytdRows = (data, year) => (data?.rows || []).filter((row) => row?.scope === 'TOTAL' && number(row?.year) === number(year) && number(row?.month) <= number(data?.currentMonth));
const yoy = (current, prior) => (prior ? round2((current - prior) / prior * 100) : 0);

function changeTopic(data) {
    const current = ytdRows(data, data?.currentYear);
    const previous = ytdRows(data, data?.previousYear);
    const taskCount = sumField(current, 'task_count');
    const priorTaskCount = sumField(previous, 'task_count');
    const operationSuccessRate = taskCount
        ? round2(current.reduce((sum, row) => sum + ratePercent(row?.operation_success_rate) * number(row?.task_count), 0) / taskCount)
        : 0;
    return { taskCount, priorTaskCount, yoyRate: yoy(taskCount, priorTaskCount), rollbackCount: sumField(current, 'rollback_count'), highRiskCount: sumField(current, 'high_core_total_count'), operationSuccessRate };
}

function interceptionTopic(data) {
    const current = ytdRows(data, data?.currentYear);
    const previous = ytdRows(data, data?.previousYear);
    const total = sumField(current, 'interception_cnt');
    const priorTotal = sumField(previous, 'interception_cnt');
    return { total, priorTotal, yoyRate: yoy(total, priorTotal), commandCount: sumField(current, 'commands_interception_cnt'), graphicalCount: sumField(current, 'graphical_interception_cnt') };
}

function srTopic(data) {
    const pick = (period) => (data?.summary || []).find((row) => row?.scope === 'TOTAL' && row?.period === period) || {};
    const current = pick('currentYtd');
    const total = number(current.sr_total);
    const priorTotal = number(pick('previousYtd').sr_total);
    return {
        total, priorTotal, yoyRate: yoy(total, priorTotal),
        frtRate: round2(ratePercent(current.sr_frt)), openCount: number(current.unclose_sr_cnt), overdueCount: number(current.overdue_sr_cnt),
        minorCount: number(current.minor_sr_cnt), majorCount: number(current.major_sr_cnt), criticalCount: number(current.critical_sr_cnt),
    };
}

const periodText = (year, month) => (year ? `${year}${month ? `-${String(month).padStart(2, '0')}` : ''}` : '');

export function buildSummary(snapshot) {
    const data = snapshot.data;
    // 各专题所属月份：月报按月找快照时用，免得为了几个字段把整份快照读出来
    const periodFields = {
        settings: { year: snapshot.settings?.year ?? null, month: snapshot.settings?.month ?? null },
        sr: { currentYear: data.sr?.currentYear ?? null, currentMonth: data.sr?.currentMonth ?? null },
        change: { currentYear: data.change?.currentYear ?? null, currentMonth: data.change?.currentMonth ?? null },
        interception: { currentYear: data.interception?.currentYear ?? null, currentMonth: data.interception?.currentMonth ?? null },
    };
    if (snapshot.platform === 'netcare') {
        const metrics = {
            certificates: rowCount(data.certificate),
            eosProductRows: rowCount(data.eosProduct),
            eosVersionRows: rowCount(data.eosVersion),
            changeRows: rowCount(data.change?.rows),
            interceptionRows: rowCount(data.interception?.rows),
            srSummaryRows: rowCount(data.sr?.summary),
            srMonthlyRows: rowCount(data.sr?.monthly),
        };
        const certificateTotal = sumField(data.certificate, 'need_reduce_cnt');
        const certificateReduced = sumField(data.certificate, 'reduced_cnt');
        return {
            summaryVersion: 2,
            period: periodText(data.sr?.currentYear || snapshot.settings?.year || '', data.sr?.currentMonth || snapshot.settings?.month || ''),
            totalRows: Object.values(metrics).reduce((sum, value) => sum + value, 0),
            metrics,
            periodFields,
            topics: {
                certificate: { total: certificateTotal, reduced: certificateReduced, pending: Math.max(0, certificateTotal - certificateReduced), completionRate: certificateTotal ? round2(certificateReduced / certificateTotal * 100) : 0 },
                eosProduct: buildEosTopic(data.eosProduct, 'product', snapshot.settings),
                eosVersion: buildEosTopic(data.eosVersion, 'version', snapshot.settings),
                change: changeTopic(data.change),
                interception: interceptionTopic(data.interception),
                sr: srTopic(data.sr),
            },
        };
    }
    const detailsByMonth = isObject(data.detailsByMonth) ? data.detailsByMonth : {};
    const rawRows = Object.values(detailsByMonth).reduce((sum, rows) => sum + rowCount(rows), 0) || rowCount(data.detail);
    const month = Number(snapshot.settings?.month) || 0;
    const selected = data.months.find((item) => Number(item?.month) === month) || {};
    const metrics = {
        monthlySummaries: rowCount(data.months),
        rawRows,
        selectedRequired: number(selected.required ?? selected.needReturn ?? selected.shouldReturn),
        selectedReturned: number(selected.returned ?? selected.actualReturn),
        selectedRecorded: number(selected.recorded ?? selected.actualRecord),
    };
    return {
        summaryVersion: 2,
        period: periodText(Number(snapshot.settings?.year) || '', month),
        totalRows: metrics.monthlySummaries + metrics.rawRows,
        metrics,
        periodFields,
        topics: {
            return: {
                required: metrics.selectedRequired, returned: metrics.selectedReturned,
                pending: number(selected.pending) || Math.max(0, metrics.selectedRequired - metrics.selectedReturned),
                returnRate: number(selected.returnRate) || (metrics.selectedRequired ? metrics.selectedReturned / metrics.selectedRequired * 100 : 0),
                targetRate: number(snapshot.settings?.targets?.returnRate),
            },
            filing: {
                required: metrics.selectedRequired, recorded: metrics.selectedRecorded,
                recordRate: number(selected.recordRate) || (metrics.selectedRequired ? metrics.selectedRecorded / metrics.selectedRequired * 100 : 0),
                limitRate: number(snapshot.settings?.targets?.recordRate), rawRows,
            },
        },
    };
}

// 记录 → 接口里的快照元信息（字段名与桌面版一致）
const toMeta = (record) => ({
    id: record.id,
    platform: record.group,
    name: record.name,
    capturedAt: record.summary.capturedAt || '',
    exportedAt: record.summary.exportedAt || '',
    importedAt: record.sortKey,
    period: record.period,
    summary: record.summary.summary || {},
    payloadBytes: record.payloadBytes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
});
const withSnapshot = (record) => (record ? { ...toMeta(record), snapshot: record.payload } : null);

/** 保存快照；同一平台内容完全相同的快照只保留一份（更新导入时间） */
export async function saveTopicSnapshot(input, { name = '', updatedBy = '' } = {}) {
    const snapshot = normalizeSnapshot(input);
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_PAYLOAD_BYTES) throw fail('专题快照超过 45MB 上限', 413, 'TOPIC_SNAPSHOT_TOO_LARGE');
    const stable = JSON.stringify({ platform: snapshot.platform, capturedAt: snapshot.capturedAt, scope: snapshot.scope, settings: snapshot.settings, data: snapshot.data });
    const hash = crypto.createHash('sha256').update(stable).digest('hex');
    const existing = await findRecordByHash(KIND, snapshot.platform, hash);
    const summary = buildSummary(snapshot);
    const record = await putRecord(KIND, {
        id: existing?.id || `topic_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`,
        group: snapshot.platform,
        name: String(name || '').trim().slice(0, 120) || existing?.name || '',
        period: summary.period,
        sortKey: new Date().toISOString(), // 导入时间
        hash,
        summary: { capturedAt: snapshot.capturedAt, exportedAt: snapshot.exportedAt, summary },
        payload: snapshot,
        updatedBy,
        createdAt: existing ? Date.parse(existing.createdAt) : 0,
    });
    return { item: toMeta(record), created: !existing };
}

function checkPlatform(platform, required = false) {
    const value = String(platform || '').toLowerCase();
    if (value ? !PLATFORMS.has(value) : required) throw fail(required ? '请指定 netcare 或 datafab' : '不支持的专题平台');
    return value;
}

export async function listTopicSnapshots(options = {}) {
    const platform = checkPlatform(options.platform);
    const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));
    const offset = Math.max(0, Number(options.offset) || 0);
    const since = options.since ? Date.parse(options.since) : NaN;
    let items = (await listRecords(KIND, { group: platform, limit: 1000 })).map(toMeta);
    if (Number.isFinite(since)) items = items.filter((item) => Date.parse(item.importedAt) >= since);
    return { items: items.slice(offset, offset + limit), total: Number.isFinite(since) ? items.length : await countRecords(KIND, { group: platform }), limit, offset };
}

export async function getTopicSnapshot(id) {
    return withSnapshot(await getRecord(KIND, id));
}

// 按采集时间倒序的全部元信息（不带正文）
async function allMeta(platform) {
    return (await listRecords(KIND, { group: platform, limit: 1000 })).map(toMeta);
}

export async function getLatestTopicSnapshot(platform) {
    const items = await allMeta(checkPlatform(platform, true));
    const latest = items.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)) || String(b.importedAt).localeCompare(String(a.importedAt)))[0];
    return latest ? getTopicSnapshot(latest.id) : null;
}

export async function getTopicSeries(options = {}) {
    const { items } = await listTopicSnapshots({ ...options, limit: 200, offset: 0 });
    return items.sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
}

function checkMonth(month) {
    if (month && !MONTH_RE.test(month)) throw fail('月份格式应为 YYYY-MM');
    return month || '';
}

/** 每个月份取最后导入的那份快照：返回 月份 → 快照标识（items 已按导入时间倒序） */
function latestPerMonth(items, periodOf) {
    const byMonth = new Map();
    for (const item of items) {
        const period = periodOf(item);
        if (period && !byMonth.has(period)) byMonth.set(period, item.id);
    }
    return byMonth;
}

export async function getEosMonthlyReport(monthInput) {
    const month = checkMonth(monthInput);
    const byMonth = latestPerMonth(await allMeta('netcare'), (item) => (/^\d{4}-\d{2}/.test(item.period) ? item.period.slice(0, 7) : String(item.capturedAt).slice(0, 7)));
    const months = [...byMonth.keys()].sort().reverse();
    const selected = month || months[0];
    if (!byMonth.has(selected)) return { months, report: null };
    return { months, report: buildEosMonthlyReport(await getTopicSnapshot(byMonth.get(selected)), selected) };
}

export async function getTopicMonthlyReport(topicKey, monthInput = '') {
    const definition = monthlyEngine.get(topicKey);
    if (!definition) throw fail('不支持的月报专题');
    const month = checkMonth(monthInput);
    if (topicKey === 'eos') return getEosMonthlyReport(month);
    const byMonth = latestPerMonth(await allMeta(definition.platform), (item) => {
        const fields = item.summary.periodFields || {};
        return monthlyEngine.period({ capturedAt: item.capturedAt, settings: fields.settings || {}, data: { sr: fields.sr || {}, change: fields.change || {}, interception: fields.interception || {} } }, topicKey);
    });
    const months = [...byMonth.keys()].sort().reverse();
    const selected = month || months[0];
    if (!byMonth.has(selected)) return { months, report: null };
    const item = await getTopicSnapshot(byMonth.get(selected));
    if (!item || !monthlyEngine.available(item.snapshot, topicKey)) return { months, report: null };
    const report = monthlyEngine.build(item.snapshot, topicKey, selected);
    report.snapshot = { id: item.id, name: item.name, capturedAt: item.capturedAt, importedAt: item.importedAt };
    return { months, report };
}

export async function deleteTopicSnapshot(id) {
    if (!await deleteRecord(KIND, id)) throw Object.assign(new NotFoundError('专题快照不存在'), { codeName: 'TOPIC_SNAPSHOT_NOT_FOUND' });
    return { message: '专题快照已删除' };
}

export const getTopicMappingConfig = () => kvGet(MAPPING_KEY, null);
export async function saveTopicMappingConfig(config) {
    await kvSet(MAPPING_KEY, config && typeof config === 'object' ? config : {});
    return config;
}
