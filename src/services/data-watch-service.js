// 数据巡检：按可配置的周期检查业务库每张表的行数，发现突增、突降、变空、从空变有数、表新增 / 消失、查询开始报错时，
// 同一轮的所有变化聚合成一条消息发给管理员（基座 Web 版的管理员即超级管理员）。
// 数据收集：把业务库每张表的前 N 行连同字段结构收下来；没有数据的表也收，并说明原因（真的没数据 / 无权限 / 表不存在 / 超时 / 视图出错…）。
//
// 只读：业务库只发 SELECT / information_schema 查询（经 base-adapter 的只读守卫）。结果全部存应用库的统一记录表 biz_records：
//   dw_run      每轮巡检（各表行数、异常清单）
//   dw_collect  每次收集的概要；dw_sample 每张表的样例行与字段（按收集批次分组，只保留最近几批）
// 多实例：执行前在键值表里抢一个带过期时间的租约，同一时间只有一个实例在跑。
import crypto from 'node:crypto';
import { kvGet, kvSet, hasBusinessDatasource, deleteRows, sqlVal } from '../dao/scoped.js';
import { listRecords, getRecord, putRecord, trimRecords } from './record-store.js';
import * as client from './netcare/base-adapter.js';
import { listAdmins } from '../core/access.js';
import { pushAlert } from './alert-service.js';
import { pushLog } from '../core/log-ring.js';

const SETTINGS_KEY = 'data_watch_settings';
const STATE_KEY = 'data_watch_state';
const LEASE_KEY = 'data_watch_lease';
const RUN_KIND = 'dw_run';
const COLLECT_KIND = 'dw_collect';
const SAMPLE_KIND = 'dw_sample';
const KEEP_RUNS = 120;
const KEEP_COLLECTIONS = 3;
const LEASE_MS = 30 * 60_000;
const CELL_CHARS = 300;
const SAMPLE_BYTES = 160_000;

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    intervalMinutes: 360,
    collectIntervalMinutes: 1440,
    collectRows: 20,
    linkIntervalMinutes: 5,
    changeRatio: 0.3,
    minAbsChange: 100,
    concurrency: 4,
    countMode: 'exact',
    exclude: [],
    notify: true,
});

const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);
const shortHash = (text) => crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
const pick = (row, key) => {
    if (!row) return undefined;
    if (key in row) return row[key];
    const found = Object.keys(row).find((name) => name.toLowerCase() === key.toLowerCase());
    return found ? row[found] : undefined;
};

export function normalizeSettings(input = {}) {
    const src = { ...DEFAULT_SETTINGS, ...(input && typeof input === 'object' ? input : {}) };
    const list = (value) => (Array.isArray(value) ? value : String(value || '').split(/[\s,，;；]+/))
        .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 50);
    return {
        enabled: src.enabled !== false,
        intervalMinutes: Math.round(clamp(src.intervalMinutes, 15, 10080, DEFAULT_SETTINGS.intervalMinutes)),
        // 0 = 只手动收集
        collectIntervalMinutes: Number(src.collectIntervalMinutes) === 0 ? 0 : Math.round(clamp(src.collectIntervalMinutes, 60, 43200, DEFAULT_SETTINGS.collectIntervalMinutes)),
        collectRows: Math.round(clamp(src.collectRows, 1, 200, DEFAULT_SETTINGS.collectRows)),
        linkIntervalMinutes: Math.round(clamp(src.linkIntervalMinutes, 1, 1440, DEFAULT_SETTINGS.linkIntervalMinutes)),
        changeRatio: clamp(src.changeRatio, 0.01, 100, DEFAULT_SETTINGS.changeRatio),
        minAbsChange: Math.round(clamp(src.minAbsChange, 0, 1e12, DEFAULT_SETTINGS.minAbsChange)),
        concurrency: Math.round(clamp(src.concurrency, 1, 8, DEFAULT_SETTINGS.concurrency)),
        countMode: src.countMode === 'estimate' ? 'estimate' : 'exact',
        exclude: list(src.exclude).slice(0, 100),
        notify: src.notify !== false,
    };
}

export async function getSettings() {
    return normalizeSettings(await kvGet(SETTINGS_KEY, null));
}

export async function saveSettings(input, actor = '') {
    const current = await getSettings();
    const next = normalizeSettings({ ...current, ...(input || {}) });
    await kvSet(SETTINGS_KEY, { ...next, updatedBy: actor, updatedAt: new Date().toISOString() });
    // 周期改了：下一次按新周期从上次执行时间算
    const state = await getState();
    await saveState({
        ...state,
        nextCheckAt: state.lastCheckAt ? state.lastCheckAt + next.intervalMinutes * 60_000 : Date.now() + 60_000,
        nextCollectAt: next.collectIntervalMinutes ? (state.lastCollectAt ? state.lastCollectAt + next.collectIntervalMinutes * 60_000 : Date.now() + 5 * 60_000) : null,
    });
    return next;
}

async function getState() {
    const state = await kvGet(STATE_KEY, null);
    return state && typeof state === 'object' ? state : {};
}
const saveState = (state) => kvSet(STATE_KEY, state);

// ── 租约：同一时间只有一个实例在跑巡检 / 收集 ──
const memoryProgress = new Map();
async function acquireLease(kind) {
    const now = Date.now();
    const lease = await kvGet(LEASE_KEY, null);
    if (lease && lease.until > now) return null;
    const token = crypto.randomUUID();
    await kvSet(LEASE_KEY, { token, kind, startedAt: now, until: now + LEASE_MS, done: 0, total: 0 });
    const check = await kvGet(LEASE_KEY, null);
    return check?.token === token ? token : null;
}
async function releaseLease(token) {
    const lease = await kvGet(LEASE_KEY, null);
    if (lease?.token === token) await kvSet(LEASE_KEY, { token: '', until: 0 });
    memoryProgress.delete(token);
}
async function reportProgress(token, kind, done, total) {
    memoryProgress.set(token, { kind, done, total });
    // 每 20 张表写一次，别的实例和页面也能看到进度
    if (done % 20 === 0 || done === total) {
        const lease = await kvGet(LEASE_KEY, null);
        if (lease?.token === token) await kvSet(LEASE_KEY, { ...lease, done, total, until: Date.now() + LEASE_MS });
    }
}
export async function runningJob() {
    const lease = await kvGet(LEASE_KEY, null);
    if (!lease || !(lease.until > Date.now()) || !lease.token) return null;
    const local = memoryProgress.get(lease.token);
    return { kind: lease.kind, startedAt: iso(lease.startedAt), done: local?.done ?? lease.done ?? 0, total: local?.total ?? lease.total ?? 0 };
}

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            out[index] = await fn(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

// ── 业务库清单 ──
// 业务库只有一个（平台注入的业务数据源）；巡检的是它里面实际存在的所有表，表键就是表名
export const schemasOf = () => [client.businessSchemaLabel()];
export const tableKey = (_schema, name) => name;

function excluded(name, patterns) {
    return patterns.some((p) => {
        if (p.startsWith('/') && p.endsWith('/') && p.length > 2) {
            try { return new RegExp(p.slice(1, -1), 'i').test(name); } catch { return false; }
        }
        const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
        return re.test(name);
    });
}

/** 业务库里实际存在的表（含视图）：一条 information_schema 查询拿全 */
export async function inventory(settings) {
    const { rows } = await client.queryAll(`SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS est, UPDATE_TIME AS ut, TABLE_COMMENT AS comment FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${client.businessSchemaExpr()} ORDER BY TABLE_NAME`, { maxRows: 5000 });
    return rows.map((row) => {
        const schema = '';
        const name = String(pick(row, 'name') || '');
        return {
            key: tableKey(schema, name), schema, name,
            type: /VIEW/i.test(String(pick(row, 'type') || '')) ? 'view' : 'table',
            estRows: pick(row, 'est') === null || pick(row, 'est') === undefined ? null : Number(pick(row, 'est')) || 0,
            updateTime: pick(row, 'ut') ? String(pick(row, 'ut')) : '',
            comment: String(pick(row, 'comment') || ''),
        };
    }).filter((t) => t.name && !excluded(t.name, settings.exclude || []));
}

/** 把查询报错归成人能看懂的原因 */
export function classifyError(error, type = 'table') {
    const text = String(error?.message || error || '');
    if (error?.code === 'DH_BAD_IDENT') return { kind: 'unsupported_name', reason: '表名含特殊字符，巡检暂不支持' };
    if (/denied|privilege|not authori[sz]ed|permission|无权|没有权限|权限不足/i.test(text)) return { kind: 'permission', reason: '没有查询权限（数据源未授权这张表）' };
    if (/doesn'?t exist|does not exist|unknown table|不存在|no such table/i.test(text)) return { kind: 'missing', reason: '表不存在（可能刚被删除或改名）' };
    if (/timeout|timed out|超时|aborted|ETIMEDOUT/i.test(text)) return { kind: 'timeout', reason: '查询超时（表太大或数据库繁忙）' };
    if (type === 'view' || /view|definer|invalid/i.test(text)) return { kind: 'view_broken', reason: '视图无法执行（引用的表或定义有问题）' };
    if (/基座 API 请求失败|ECONNREFUSED|ENOTFOUND|network|fetch failed/i.test(text)) return { kind: 'unreachable', reason: '业务库连不上' };
    return { kind: 'error', reason: '查询报错' };
}

async function countTable(table) {
    const started = Date.now();
    try {
        const ref = client.businessTableRef(table.name);
        const { rows } = await client.queryPage(`SELECT COUNT(*) AS c FROM ${ref}`, { limit: 1 });
        return { count: Number(pick(rows[0], 'c')) || 0, ms: Date.now() - started };
    } catch (error) {
        const why = classifyError(error, table.type);
        return { count: null, ms: Date.now() - started, errorKind: why.kind, error: `${why.reason}：${String(error.message || error).slice(0, 300)}` };
    }
}

// ── 异常判定 ──
const pct = (from, to) => (from ? Math.round(((to - from) / from) * 1000) / 10 : null);

/** 对比本轮与上一轮：返回异常清单（同一轮多处变化在调用方聚合成一条通知） */
export function detectAnomalies(results, previous, settings) {
    if (!previous) return [];
    const prevMap = new Map((previous.results || []).map((r) => [r.key, r]));
    const nowKeys = new Set(results.map((r) => r.key));
    const out = [];
    for (const r of results) {
        const p = prevMap.get(r.key);
        if (!p) { out.push({ key: r.key, type: 'new_table', severity: 'info', count: r.count, text: `新出现的表${r.count != null ? `（${r.count} 行）` : ''}` }); continue; }
        if (r.count == null) {
            if (p.count != null) out.push({ key: r.key, type: 'error', severity: 'error', prev: p.count, text: `开始查询失败：${r.error || ''}`.slice(0, 200) });
            continue;
        }
        if (p.count == null) continue; // 上一轮就失败：没有可比的基准
        const diff = r.count - p.count;
        if (p.count > 0 && r.count === 0) out.push({ key: r.key, type: 'emptied', severity: 'error', prev: p.count, count: 0, delta: diff, text: `数据被清空：${p.count} → 0` });
        else if (p.count === 0 && r.count > 0) out.push({ key: r.key, type: 'filled', severity: 'info', prev: 0, count: r.count, delta: diff, text: `从空表变为有数据：0 → ${r.count}` });
        else if (p.count > 0 && Math.abs(diff) >= settings.minAbsChange && Math.abs(diff) / p.count >= settings.changeRatio) {
            out.push({ key: r.key, type: diff > 0 ? 'spike' : 'drop', severity: diff > 0 ? 'warn' : 'error', prev: p.count, count: r.count, delta: diff, ratio: pct(p.count, r.count), text: `${diff > 0 ? '突增' : '突降'} ${pct(p.count, r.count)}%：${p.count} → ${r.count}` });
        }
    }
    for (const p of previous.results || []) {
        if (!nowKeys.has(p.key)) out.push({ key: p.key, type: 'removed', severity: 'error', prev: p.count, text: '表消失了（被删除、改名或不再授权）' });
    }
    const order = { error: 0, warn: 1, info: 2 };
    return out.sort((a, b) => order[a.severity] - order[b.severity] || Math.abs(b.delta || 0) - Math.abs(a.delta || 0));
}

export const ANOMALY_LABELS = { emptied: '变空', filled: '从空变有', spike: '突增', drop: '突降', new_table: '新表', removed: '表消失', error: '查询失败' };

async function notifyAnomalies(run, anomalies) {
    const { env, stored } = await listAdmins();
    const admins = [...new Set([...(env || []), ...(stored || [])])];
    if (!admins.length || !anomalies.length) return 0;
    const counts = Object.entries(anomalies.reduce((acc, a) => ({ ...acc, [a.type]: (acc[a.type] || 0) + 1 }), {}))
        .map(([type, n]) => `${ANOMALY_LABELS[type] || type} ${n}`).join('、');
    const lines = anomalies.slice(0, 15).map((a) => `· ${a.key}：${a.text}`);
    if (anomalies.length > 15) lines.push(`…另有 ${anomalies.length - 15} 处，详见 数据探索 → 数据巡检`);
    return pushAlert(admins, {
        type: 'system',
        severity: anomalies.some((a) => a.severity === 'error') ? 'error' : 'warn',
        title: `数据巡检：${anomalies.length} 张表数据量异常（${counts}）`,
        message: lines.join('\n'),
        source: 'data-watch',
        objectType: 'data_watch_run',
        objectId: run.id,
        detail: { runId: run.id, finishedAt: run.finishedAt, anomalies: anomalies.slice(0, 100) },
    }, { allowDuplicate: true });
}

export async function latestRun({ withPayload = true } = {}) {
    const [head] = await listRecords(RUN_KIND, { limit: 1 });
    if (!head) return null;
    if (!withPayload) return head;
    const full = await getRecord(RUN_KIND, head.id);
    return full ? { ...full.payload, id: full.id, summary: full.summary } : null;
}

export async function listRuns(limit = 30) {
    return (await listRecords(RUN_KIND, { limit: Math.min(Number(limit) || 30, KEEP_RUNS) })).map((r) => ({ id: r.id, ...r.summary }));
}

export async function getRun(id) {
    const rec = await getRecord(RUN_KIND, id);
    return rec ? { id: rec.id, ...rec.summary, ...rec.payload } : null;
}

/** 某张表最近若干轮的行数（详情页画趋势） */
export async function countHistory(key, limit = 30) {
    const heads = await listRecords(RUN_KIND, { limit: Math.min(limit, KEEP_RUNS) });
    const out = [];
    for (const head of heads) {
        const rec = await getRecord(RUN_KIND, head.id);
        const hit = rec?.payload?.results?.find((r) => r.key === key);
        if (hit) out.push({ at: rec.summary?.finishedAt, count: hit.count, error: hit.error || '' });
    }
    return out.reverse();
}

const runListeners = new Set();
/** 每轮巡检结束后回调（派生表联动用：源表行数变了就重算） */
export function onRunFinished(fn) { runListeners.add(fn); return () => runListeners.delete(fn); }

/** 执行一轮行数巡检。trigger: schedule | manual */
export async function runCheck({ trigger = 'manual', actor = '' } = {}) {
    if (!hasBusinessDatasource()) throw client.dhError('DH_DISABLED', '还没有授权业务数据源，无法巡检', { statusCode: 409 });
    const token = await acquireLease('check');
    if (!token) throw client.dhError('DW_BUSY', '已有巡检或收集在进行，请稍后再试', { statusCode: 409 });
    const startedAt = Date.now();
    try {
        const settings = await getSettings();
        const previous = await latestRun();
        const tables = await inventory(settings);
        let done = 0;
        const results = await mapLimit(tables, settings.concurrency, async (table) => {
            const counted = settings.countMode === 'estimate'
                ? { count: table.estRows, ms: 0, estimated: true }
                : await countTable(table);
            await reportProgress(token, 'check', ++done, tables.length);
            return { key: table.key, name: table.name, type: table.type, estRows: table.estRows, updateTime: table.updateTime, comment: table.comment, ...counted };
        });
        const anomalies = detectAnomalies(results, previous, settings);
        const finishedAt = Date.now();
        const id = `run_${new Date(startedAt).toISOString().replace(/\D/g, '').slice(0, 14)}_${shortHash(token).slice(0, 4)}`;
        const summary = {
            startedAt: iso(startedAt), finishedAt: iso(finishedAt), durationMs: finishedAt - startedAt, trigger, actor,
            tables: results.length, ok: results.filter((r) => r.count != null).length,
            errors: results.filter((r) => r.count == null).length, empty: results.filter((r) => r.count === 0).length,
            totalRows: results.reduce((s, r) => s + (r.count || 0), 0), anomalies: anomalies.length,
            anomalyTypes: anomalies.reduce((acc, a) => ({ ...acc, [a.type]: (acc[a.type] || 0) + 1 }), {}),
            countMode: settings.countMode, baseline: previous?.id || null,
        };
        await putRecord(RUN_KIND, { id, sortKey: iso(startedAt), name: `巡检 ${iso(startedAt)}`, summary, payload: { results, anomalies }, updatedBy: actor || 'system' });
        await trimRecords(RUN_KIND, KEEP_RUNS);
        const run = { id, ...summary };
        let notified = 0;
        if (anomalies.length && settings.notify) notified = await notifyAnomalies(run, anomalies).catch(() => 0);
        const state = await getState();
        await saveState({ ...state, lastCheckAt: finishedAt, nextCheckAt: finishedAt + settings.intervalMinutes * 60_000, lastCheckError: '' });
        for (const fn of runListeners) await Promise.resolve(fn({ run, results, previous })).catch((e) => pushLog({ level: 'WARN', category: 'DATA_WATCH', message: `巡检后续处理失败：${e.message}` }));
        pushLog({ level: anomalies.length ? 'WARN' : 'INFO', category: 'DATA_WATCH', message: `数据巡检完成：${results.length} 张表，${anomalies.length} 处异常，通知 ${notified} 人`, detail: { id, durationMs: summary.durationMs } });
        return { ...run, anomaliesList: anomalies, notified };
    } catch (error) {
        const state = await getState();
        const settings = await getSettings().catch(() => DEFAULT_SETTINGS);
        // 失败后过 30 分钟再试，不必等满一个周期
        await saveState({ ...state, lastCheckError: String(error.message || error).slice(0, 300), lastCheckErrorAt: Date.now(), nextCheckAt: Date.now() + Math.min(30, settings.intervalMinutes) * 60_000 });
        throw error;
    } finally {
        await releaseLease(token);
    }
}

// ── 数据收集 ──
function clipCell(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return text.length > CELL_CHARS ? `${text.slice(0, CELL_CHARS)}…` : text;
}

function clipRows(rows) {
    const out = [];
    let bytes = 0;
    for (const row of rows) {
        const clean = Object.fromEntries(Object.entries(row || {}).map(([k, v]) => [k, clipCell(v)]));
        bytes += Buffer.byteLength(JSON.stringify(clean), 'utf8');
        if (out.length && bytes > SAMPLE_BYTES) return { rows: out, clipped: true };
        out.push(clean);
    }
    return { rows: out, clipped: false };
}

/** 一张表的字段结构（逐表查：表多了整库字段会超过单次取数上限） */
async function tableColumns(table) {
    try {
        const { rows } = await client.queryAll(`SELECT COLUMN_NAME AS c, COLUMN_TYPE AS ct, COLUMN_COMMENT AS cm, COLUMN_KEY AS k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${client.businessSchemaExpr()} AND TABLE_NAME = ${client.quote(table.name)} ORDER BY ORDINAL_POSITION`, { maxRows: 2000 });
        return rows.map((row) => ({ name: String(pick(row, 'c') || ''), type: String(pick(row, 'ct') || ''), comment: String(pick(row, 'cm') || ''), key: String(pick(row, 'k') || '') })).filter((c) => c.name);
    } catch { return []; /* 字段结构拿不到时，有数据的表用样例行的键 */ }
}

/** 分区族（xxx_0 / xxx_1、xxx_01…）里有数据的兄弟表，用来解释“这张为空但同族有数据” */
function siblingsWithData(table, counts) {
    const m = /^(.*?)_(\d{1,2})$/.exec(table.name);
    if (!m) return [];
    const re = new RegExp(`^${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_\\d{1,2}$`);
    return [...counts.entries()].filter(([key, n]) => n > 0 && key !== table.key && re.test(key)).map(([key]) => key);
}

async function sampleTable(table, rowsWanted, counts) {
    const base = { key: table.key, name: table.name, type: table.type, comment: table.comment, columns: await tableColumns(table) };
    try {
        const ref = client.businessTableRef(table.name);
        const { rows } = await client.queryPage(`SELECT * FROM ${ref} LIMIT ${rowsWanted}`, { limit: rowsWanted });
        if (rows.length) {
            const clipped = clipRows(rows);
            return { ...base, status: 'ok', rows: clipped.rows, sampled: clipped.rows.length, clipped: clipped.clipped, count: counts.get(table.key) ?? null, columns: base.columns.length ? base.columns : Object.keys(rows[0]).map((name) => ({ name })) };
        }
        // 没取到行：再确认一次总数，区分“真的没有数据”和别的情况
        let count = counts.get(table.key);
        if (count === undefined || count === null) count = (await countTable(table)).count;
        const siblings = siblingsWithData(table, counts);
        let reason;
        let status = 'empty';
        if (count > 0) { status = 'inconsistent'; reason = `取样为空但计数为 ${count} 行，可能是数据正在写入或视图带了过滤`; }
        else if (table.type === 'view') reason = '视图能执行，但当前结果为空（引用的表没有符合条件的数据）';
        else if (siblings.length) reason = `表里确实没有数据；同族分区 ${siblings.slice(0, 3).join('、')} 有数据，这张可能是轮换备用表`;
        else if (!base.columns.length) reason = '表里确实没有数据，且读不到字段结构';
        else reason = '表里确实没有数据（查询正常，0 行）';
        return { ...base, status, rows: [], sampled: 0, count: count ?? 0, reason };
    } catch (error) {
        const why = classifyError(error, table.type);
        return { ...base, status: 'error', rows: [], sampled: 0, count: null, errorKind: why.kind, reason: why.reason, error: String(error.message || error).slice(0, 500) };
    }
}

export async function latestCollection() {
    const [head] = await listRecords(COLLECT_KIND, { limit: 1 });
    return head ? { id: head.id, ...head.summary } : null;
}

export async function listCollections() {
    return (await listRecords(COLLECT_KIND, { limit: KEEP_COLLECTIONS + 2 })).map((r) => ({ id: r.id, ...r.summary }));
}

/** 某次收集里一张表的样例；不传 collectId 用最近一次 */
export async function getSample(key, collectId = '') {
    const id = collectId || (await latestCollection())?.id;
    if (!id) return null;
    const rec = await getRecord(SAMPLE_KIND, `${id}:${shortHash(key)}`);
    return rec ? { collectId: id, ...rec.payload } : null;
}

/** 某次收集的所有表（导出用；不带正文时只给状态） */
export async function collectionTables(collectId, { withRows = false } = {}) {
    const recs = await listRecords(SAMPLE_KIND, { group: collectId, withPayload: withRows, limit: 5000, maxRows: 5000 });
    return recs.map((r) => (withRows ? r.payload : { key: r.name, ...r.summary })).sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

export async function runCollect({ trigger = 'manual', actor = '', rows } = {}) {
    if (!hasBusinessDatasource()) throw client.dhError('DH_DISABLED', '还没有授权业务数据源，无法收集', { statusCode: 409 });
    const token = await acquireLease('collect');
    if (!token) throw client.dhError('DW_BUSY', '已有巡检或收集在进行，请稍后再试', { statusCode: 409 });
    const startedAt = Date.now();
    try {
        const settings = await getSettings();
        const rowsWanted = Math.round(clamp(rows, 1, 200, settings.collectRows));
        const tables = await inventory(settings);
        const last = await latestRun({ withPayload: true }).catch(() => null);
        const counts = new Map((last?.results || []).filter((r) => r.count != null).map((r) => [r.key, r.count]));
        const id = `col_${new Date(startedAt).toISOString().replace(/\D/g, '').slice(0, 14)}_${shortHash(token).slice(0, 4)}`;
        const stats = { ok: 0, empty: 0, error: 0, inconsistent: 0 };
        const reasons = {};
        let done = 0;
        await mapLimit(tables, settings.concurrency, async (table) => {
            const sample = await sampleTable(table, rowsWanted, counts);
            stats[sample.status] = (stats[sample.status] || 0) + 1;
            if (sample.status !== 'ok') reasons[sample.errorKind || sample.status] = (reasons[sample.errorKind || sample.status] || 0) + 1;
            await putRecord(SAMPLE_KIND, {
                id: `${id}:${shortHash(table.key)}`, group: id, name: table.key, sortKey: table.key,
                summary: { status: sample.status, sampled: sample.sampled, count: sample.count, columns: sample.columns.length, reason: sample.reason || '', errorKind: sample.errorKind || '', type: table.type },
                payload: sample, updatedBy: actor || 'system',
            });
            await reportProgress(token, 'collect', ++done, tables.length);
        });
        const finishedAt = Date.now();
        const summary = { startedAt: iso(startedAt), finishedAt: iso(finishedAt), durationMs: finishedAt - startedAt, trigger, actor, rows: rowsWanted, tables: tables.length, ...stats, reasons };
        await putRecord(COLLECT_KIND, { id, sortKey: iso(startedAt), name: `收集 ${iso(startedAt)}`, summary, payload: null, updatedBy: actor || 'system' });
        // 只保留最近几批：旧批次的样例一起删
        const all = await listRecords(COLLECT_KIND, { limit: 100 });
        for (const old of all.slice(KEEP_COLLECTIONS)) {
            await deleteRows('biz_records', { whereSql: `\`kind\` = ${sqlVal(SAMPLE_KIND)} AND \`group_key\` = ${sqlVal(old.id)}`, memFilter: (r) => r.kind === SAMPLE_KIND && r.group_key === old.id });
            await deleteRows('biz_records', { whereSql: `\`kind\` = ${sqlVal(COLLECT_KIND)} AND \`id\` = ${sqlVal(old.id)}`, memFilter: (r) => r.kind === COLLECT_KIND && r.id === old.id });
        }
        const state = await getState();
        await saveState({ ...state, lastCollectAt: finishedAt, nextCollectAt: settings.collectIntervalMinutes ? finishedAt + settings.collectIntervalMinutes * 60_000 : null, lastCollectError: '' });
        pushLog({ level: 'INFO', category: 'DATA_WATCH', message: `数据收集完成：${tables.length} 张表，空表 ${stats.empty}，失败 ${stats.error}`, detail: { id } });
        return { id, ...summary };
    } catch (error) {
        const state = await getState();
        await saveState({ ...state, lastCollectError: String(error.message || error).slice(0, 300), lastCollectErrorAt: Date.now(), nextCollectAt: Date.now() + 60 * 60_000 });
        throw error;
    } finally {
        await releaseLease(token);
    }
}

/** 后台启动一个任务（页面「一键体检」用）：立即返回，进度看 runningJob() */
export function startInBackground(kind, actor) {
    const job = async () => {
        if (kind === 'check' || kind === 'all') await runCheck({ trigger: 'manual', actor });
        if (kind === 'collect' || kind === 'all') await runCollect({ trigger: 'manual', actor });
    };
    job().catch((error) => pushLog({ level: 'WARN', category: 'DATA_WATCH', message: `手动${kind === 'collect' ? '收集' : '巡检'}失败：${error.message}` }));
}

export async function status() {
    const [settings, state, job, run, collection] = await Promise.all([getSettings(), getState(), runningJob(), latestRun({ withPayload: true }), latestCollection()]);
    return {
        configured: hasBusinessDatasource(),
        schemas: schemasOf(settings),
        settings,
        state: {
            lastCheckAt: iso(state.lastCheckAt), nextCheckAt: settings.enabled ? iso(state.nextCheckAt) : null, lastCheckError: state.lastCheckError || '',
            lastCollectAt: iso(state.lastCollectAt), nextCollectAt: settings.enabled && settings.collectIntervalMinutes ? iso(state.nextCollectAt) : null, lastCollectError: state.lastCollectError || '',
            lastLinkAt: iso(state.lastLinkAt),
        },
        running: job,
        lastRun: run ? { ...run.summary, id: run.id, anomalyList: run.anomalies || [] } : null,
        lastCollection: collection,
    };
}

// ── 调度：每分钟看一次是否到期（巡检、收集、派生表联动） ──
let timer = null;
let ticking = false;
const linkers = new Set();
/** 注册联动检查（派生表服务用）：每 linkIntervalMinutes 调一次 */
export function onLinkTick(fn) { linkers.add(fn); return () => linkers.delete(fn); }

export async function tick(now = Date.now()) {
    if (!hasBusinessDatasource()) return { skipped: 'no-datasource' };
    const settings = await getSettings();
    if (!settings.enabled) return { skipped: 'disabled' };
    let state = await getState();
    const done = {};
    if (!state.nextCheckAt) { state = { ...state, nextCheckAt: now + 2 * 60_000 }; await saveState(state); }
    if (state.nextCheckAt && now >= state.nextCheckAt && !(await runningJob())) {
        done.check = await runCheck({ trigger: 'schedule' }).then((r) => r.id).catch((e) => `失败：${e.message}`);
        state = await getState();
    }
    if (settings.collectIntervalMinutes) {
        if (!state.nextCollectAt) { state = { ...state, nextCollectAt: now + 10 * 60_000 }; await saveState(state); }
        if (now >= state.nextCollectAt && !(await runningJob())) {
            done.collect = await runCollect({ trigger: 'schedule' }).then((r) => r.id).catch((e) => `失败：${e.message}`);
            state = await getState();
        }
    }
    if (linkers.size && (!state.lastLinkAt || now - state.lastLinkAt >= settings.linkIntervalMinutes * 60_000)) {
        await saveState({ ...(await getState()), lastLinkAt: now });
        for (const fn of linkers) await Promise.resolve(fn({ settings })).catch((e) => pushLog({ level: 'WARN', category: 'DATA_WATCH', message: `派生表联动检查失败：${e.message}` }));
        done.link = true;
    }
    return done;
}

export function startDataWatch() {
    if (timer) return;
    const run = async () => {
        if (ticking) return;
        ticking = true;
        try { await tick(); } catch (error) { pushLog({ level: 'WARN', category: 'DATA_WATCH', message: `数据巡检调度出错：${error.message}` }); } finally { ticking = false; }
    };
    timer = setInterval(run, 60_000);
    timer.unref?.();
    setTimeout(run, 30_000).unref?.();
}

export function stopDataWatch() {
    if (timer) clearInterval(timer);
    timer = null;
}
