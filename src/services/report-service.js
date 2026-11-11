import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import {
    kvGet,
    kvSet,
    selectTable,
    insertRow,
    upsertRow,
    deleteRows,
    sendBaseNotify,
    sqlVal,
    parseJsonCol,
} from '../dao/scoped.js';
import { saveBlobAsset, getBlobAsset } from './blob-service.js';
import { selectLatestSnapshotPerMonth, validSnapshotFilter } from '../utils/ai-report-helpers.js';

const MANUAL_ADJUST_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
    '.pdf', '.txt', '.csv', '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt', '.zip',
]);

function fail(message, status = 400, code = 'REPORT_ERROR') {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    throw error;
}

export function expandCompressedReportPayload(body) {
    const field = body?.compressedReportPayload;
    const compression = body?.transport?.compression || field?.encoding;
    if (!compression && !field) return body;
    if (!field || typeof field !== 'object') fail('报表入库数据压缩字段格式无效');
    const encoding = String(field.encoding || compression || '').toLowerCase();
    const raw = Buffer.from(String(field.data || ''), 'base64');
    if (raw.length === 0 && field.data) fail('报表入库数据压缩内容为空');

    let out;
    if (encoding === 'gzip+base64' || encoding === 'gzip-base64') {
        out = zlib.gunzipSync(raw);
    } else if (encoding === 'deflate+base64') {
        out = zlib.inflateSync(raw);
    } else {
        fail(`报表入库数据压缩编码不支持: ${field.encoding || 'unknown'}`);
    }
    const payload = JSON.parse(out.toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        fail('报表入库数据解压后格式无效');
    }
    return payload;
}

function normalizeDateTimeStr(input) {
    const d = input ? new Date(input) : new Date();
    const valid = Number.isNaN(d.getTime()) ? new Date() : d;
    return valid.toISOString().replace('T', ' ').slice(0, 19);
}

function withoutSourceSections(raw) {
    if (!raw) return raw;
    try {
        const snapshot = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(snapshot?.sourceSections)) return typeof raw === 'string' ? raw : JSON.stringify(snapshot);
        const clone = { ...snapshot, sourceSectionsCount: snapshot.sourceSections.length };
        delete clone.sourceSections;
        return JSON.stringify(clone);
    } catch {
        return raw;
    }
}

function slimTrendSnapshot(raw) {
    if (!raw) return null;
    try {
        const snapshot = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return JSON.stringify({
            month: snapshot.month,
            timestamp: snapshot.timestamp,
            selectedTargetMonth: snapshot.selectedTargetMonth,
            topMetrics: snapshot.topMetrics || [],
        });
    } catch {
        return null;
    }
}

export async function saveManualAdjustAttachment(file) {
    const buf = file?.buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) fail('请选择需要上传的附件');
    if (buf.length > 12 * 1024 * 1024) fail('附件不能超过 12 MB', 413);
    const originalName = path.basename(String(file.originalname || 'attachment')).slice(0, 180);
    const ext = path.extname(originalName).toLowerCase();
    if (!MANUAL_ADJUST_EXTENSIONS.has(ext)) fail(`不支持的附件格式: ${ext || 'unknown'}`);

    const safeName = `adjust_${crypto.randomUUID().slice(0, 12)}${ext}`;
    await saveBlobAsset({
        key: `report/images/${safeName}`,
        category: 'report-attachment',
        filename: originalName,
        mimeType: file.mimetype || 'application/octet-stream',
        buffer: buf,
    });
    return {
        success: true,
        filename: safeName,
        originalName,
        url: `/api/db/images/${safeName}`,
        size: buf.length,
    };
}

export async function getReportAsset(filename) {
    const clean = path.basename(String(filename || ''));
    if (!clean) return null;
    return getBlobAsset(`report/images/${clean}`);
}

export async function saveReportDashboard(rawBody = {}) {
    const body = expandCompressedReportPayload(rawBody);
    const {
        snapshot_id,
        month,
        standard_total_score,
        raw_data,
        image_data,
        excel_data,
        cat_scores = [],
        metric_data = [],
        created_at,
    } = body || {};

    if (!snapshot_id) fail('Missing snapshot_id');
    const monthNum = month !== undefined && month !== null ? Number(month) : null;

    let imagePath = null;
    if (typeof image_data === 'string' && image_data.startsWith('data:image/')) {
        const base64 = image_data.replace(/^data:image\/\w+;base64,/, '');
        const fname = `${snapshot_id}_${monthNum}.png`;
        await saveBlobAsset({
            key: `report/images/${fname}`,
            category: 'report-image',
            filename: fname,
            mimeType: 'image/png',
            base64,
        });
        imagePath = `/api/db/images/${fname}`;
    }

    let excelPath = null;
    if (typeof excel_data === 'string' && excel_data.startsWith('data:')) {
        const matches = excel_data.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
            const fname = `${snapshot_id}_${monthNum}.xlsx`;
            await saveBlobAsset({
                key: `report/images/${fname}`,
                category: 'report-excel',
                filename: fname,
                mimeType: matches[1] || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                base64: matches[2],
            });
            excelPath = `/api/db/images/${fname}`;
        }
    }

    await deleteRows('report_snapshots', {
        whereSql: `\`snapshot_id\` = ${sqlVal(snapshot_id)} AND \`month\` = ${sqlVal(monthNum)}`,
        memFilter: (r) => r.snapshot_id === snapshot_id && Number(r.month) === monthNum,
    });
    await deleteRows('report_category_scores', {
        whereSql: `\`snapshot_id\` = ${sqlVal(snapshot_id)} AND (\`month\` = ${sqlVal(monthNum)} OR \`month\` IS NULL)`,
        memFilter: (r) => r.snapshot_id === snapshot_id && (r.month === monthNum || r.month == null),
    });
    await deleteRows('report_metric_data', {
        whereSql: `\`snapshot_id\` = ${sqlVal(snapshot_id)} AND (\`month\` = ${sqlVal(monthNum)} OR \`month\` IS NULL)`,
        memFilter: (r) => r.snapshot_id === snapshot_id && (r.month === monthNum || r.month == null),
    });

    const createdAtStr = normalizeDateTimeStr(created_at);
    await insertRow('report_snapshots', {
        snapshot_id: String(snapshot_id),
        month: monthNum,
        created_at: createdAtStr,
        stored_at: Date.now(),
        standard_total_score: standard_total_score ?? null,
        raw_data_json: JSON.stringify(raw_data ?? {}),
        image_path: imagePath,
        excel_path: excelPath,
    });

    for (const cat of Array.isArray(cat_scores) ? cat_scores : []) {
        await insertRow('report_category_scores', {
            snapshot_id: String(snapshot_id),
            month: monthNum,
            cat_name: String(cat.cat_name || ''),
            base_score: cat.base_score ?? null,
            manual_score: cat.manual_score ?? null,
            final_score: cat.final_score ?? null,
        });
    }

    for (const m of Array.isArray(metric_data) ? metric_data : []) {
        await insertRow('report_metric_data', {
            snapshot_id: String(snapshot_id),
            month: monthNum,
            cat_name: String(m.cat_name || ''),
            metric_label: String(m.metric_label || ''),
            weight: m.weight ?? null,
            target_val: m.target_val != null ? String(m.target_val) : null,
            raw_val: m.raw_val != null ? String(m.raw_val) : null,
            num_val: m.num_val ?? null,
            is_failing: m.is_failing ? 1 : 0,
            gap: m.gap != null ? String(m.gap) : null,
            earned_score: m.earned_score === undefined ? null : m.earned_score,
            proportional_scoring: m.proportional_scoring ? 1 : 0,
            completion_ratio: m.completion_ratio === undefined ? null : m.completion_ratio,
        });
    }

    return { success: true, message: '数据已成功入库', snapshot_id, month: monthNum };
}

export async function listReportSnapshots() {
    const rows = await selectTable('report_snapshots', {
        columns: ['id', 'snapshot_id', 'month', 'created_at', 'standard_total_score'],
        orderBySql: '`id` DESC',
        limit: 500,
        memSort: (a, b) => (b.id || 0) - (a.id || 0),
    });
    return rows.map((r) => ({
        snapshot_id: r.snapshot_id,
        month: r.month,
        created_at: r.created_at,
        standard_total_score: r.standard_total_score,
    }));
}

async function buildFailingResponse(snapshot) {
    const metricRows = await selectTable('report_metric_data', {
        whereSql: `\`snapshot_id\` = ${sqlVal(snapshot.snapshot_id)} AND (\`month\` = ${sqlVal(snapshot.month)} OR \`month\` IS NULL) AND \`is_failing\` = 1`,
        limit: 1000,
        memFilter: (r) => r.snapshot_id === snapshot.snapshot_id && (r.month === snapshot.month || r.month == null) && Number(r.is_failing) === 1,
    });
    const grouped = {};
    for (const row of metricRows) {
        if (!grouped[row.cat_name]) grouped[row.cat_name] = [];
        grouped[row.cat_name].push(row);
    }
    return {
        snapshot_id: snapshot.snapshot_id,
        month: snapshot.month,
        created_at: snapshot.created_at,
        failing_metrics: grouped,
        image_path: snapshot.image_path,
        excel_path: snapshot.excel_path,
        raw_data_json: snapshot.raw_data_json,
    };
}

export async function getLatestFailing() {
    const rows = await selectTable('report_snapshots', {
        orderBySql: '`id` DESC',
        limit: 1,
        memSort: (a, b) => (b.id || 0) - (a.id || 0),
    });
    if (!rows.length) return { message: 'No snapshots found' };
    return buildFailingResponse(rows[0]);
}

export async function getFailingBySnapshotId(snapshotId, month = null) {
    const monthNum = month !== null && month !== '' ? Number(month) : null;
    const whereSql = monthNum != null
        ? `\`snapshot_id\` = ${sqlVal(snapshotId)} AND \`month\` = ${sqlVal(monthNum)}`
        : `\`snapshot_id\` = ${sqlVal(snapshotId)}`;
    const rows = await selectTable('report_snapshots', {
        whereSql,
        orderBySql: '`id` DESC',
        limit: 1,
        memFilter: (r) => r.snapshot_id === snapshotId && (monthNum == null || Number(r.month) === monthNum),
        memSort: (a, b) => (b.id || 0) - (a.id || 0),
    });
    if (!rows.length) fail('Snapshot not found', 404);
    return buildFailingResponse(rows[0]);
}

export async function getDashboardConfig(key) {
    return (await kvGet(`report_config:${key}`, {})) || {};
}

export async function setDashboardConfig(key, value) {
    let configValue = value;
    if (key === 'monthly_report_titles') {
        if (!configValue || typeof configValue !== 'object' || Array.isArray(configValue)) {
            fail('月报标题格式无效');
        }
        const zh = typeof configValue.zh === 'string' ? configValue.zh.trim() : '';
        const en = typeof configValue.en === 'string' ? configValue.en.trim() : '';
        if (!zh || !en) fail('中英文月报标题均不能为空');
        if (zh.length > 120 || en.length > 120) fail('月报标题不能超过 120 个字符');
        configValue = { zh, en };
    }
    if (key === 'report_snapshot_filter') {
        if (!configValue || typeof configValue !== 'object' || Array.isArray(configValue) || !validSnapshotFilter(configValue.minSourceTables)) {
            fail('最少表源数必须为 0–10000 的整数', 400, 'INVALID_SNAPSHOT_FILTER');
        }
        configValue = { minSourceTables: configValue.minSourceTables };
    }
    await kvSet(`report_config:${key}`, configValue);
    return { success: true };
}

export async function getMonthlyReportData({ startDate, endDate } = {}) {
    const allSnaps = await selectTable('report_snapshots', {
        orderBySql: '`created_at` ASC, `id` ASC',
        limit: 1000,
        memSort: (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || ((a.id || 0) - (b.id || 0)),
    });

    const filtered = allSnaps.filter((s) => {
        const d = String(s.created_at || '').slice(0, 10);
        if (startDate && d < startDate) return false;
        if (endDate && d > endDate) return false;
        return true;
    });

    // 每日取最新一条快照
    const byDate = new Map();
    for (const s of filtered) {
        const d = String(s.created_at || '').slice(0, 10);
        if (!d) continue;
        byDate.set(d, s);
    }
    const dailySnapshots = Array.from(byDate.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, s]) => ({ ...s, date }));

    if (!dailySnapshots.length) {
        return { trends: [], latest_snapshot: null };
    }

    const [allCatScores, allMetrics] = await Promise.all([
        selectTable('report_category_scores', { limit: 5000 }),
        selectTable('report_metric_data', { limit: 15000 }),
    ]);

    const catScoreMap = {};
    for (const cs of allCatScores) {
        const k = `${cs.snapshot_id}@@${cs.month ?? ''}`;
        if (!catScoreMap[k]) catScoreMap[k] = {};
        catScoreMap[k][cs.cat_name] = cs.final_score;
    }

    const metricStatsMap = {};
    for (const m of allMetrics) {
        const k = `${m.snapshot_id}@@${m.month ?? ''}`;
        if (!metricStatsMap[k]) metricStatsMap[k] = { total: 0, failing: 0 };
        metricStatsMap[k].total += 1;
        if (Number(m.is_failing) === 1) metricStatsMap[k].failing += 1;
    }

    const trends = dailySnapshots.map((s) => {
        const key = `${s.snapshot_id}@@${s.month ?? ''}`;
        const stats = metricStatsMap[key] || { total: 0, failing: 0 };
        const complianceRate = stats.total > 0 ? ((stats.total - stats.failing) / stats.total) * 100 : 0;
        return {
            date: s.date,
            snapshot_id: s.snapshot_id,
            month: s.month,
            total_score: s.standard_total_score,
            cat_scores: catScoreMap[key] || {},
            compliance_rate: complianceRate,
            metrics_total: stats.total,
            metrics_failing: stats.failing,
            raw_data_json: slimTrendSnapshot(s.raw_data_json),
        };
    });

    const latest = dailySnapshots[dailySnapshots.length - 1];
    const prev = dailySnapshots.length > 1 ? dailySnapshots[dailySnapshots.length - 2] : null;
    const matchSnap = (row, s) => row.snapshot_id === s.snapshot_id && (Number(row.month) === Number(s.month) || row.month == null);

    return {
        trends,
        latest_snapshot: {
            snapshot_id: latest.snapshot_id,
            month: latest.month,
            total_score: latest.standard_total_score,
            cat_scores: allCatScores.filter((r) => matchSnap(r, latest)),
            metrics: allMetrics.filter((r) => matchSnap(r, latest)),
            previous_metrics: prev ? allMetrics.filter((r) => matchSnap(r, prev)) : [],
            raw_data_json: withoutSourceSections(latest.raw_data_json),
        },
    };
}

export async function getMetricCountTrends(daysInput = 90) {
    const days = Number.isFinite(Number(daysInput)) && Number(daysInput) > 0 ? Math.min(Number(daysInput), 365) : 90;
    const cutoffStr = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

    const [snaps, metrics] = await Promise.all([
        selectTable('report_snapshots', { orderBySql: '`created_at` ASC, `id` ASC', limit: 1000 }),
        selectTable('report_metric_data', { limit: 15000 }),
    ]);

    const sortedSnaps = [...snaps].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || ((a.id || 0) - (b.id || 0)));

    const normalizeRow = (s) => {
        const mRows = metrics.filter((m) => m.snapshot_id === s.snapshot_id && (Number(m.month) === Number(s.month) || m.month == null));
        const labelSet = new Set(mRows.map((m) => m.metric_label));
        const categoryCounts = {};
        for (const m of mRows) {
            const cat = m.cat_name || '未分组';
            if (!categoryCounts[cat]) categoryCounts[cat] = { sub_metric_count: 0, labelSet: new Set() };
            categoryCounts[cat].sub_metric_count += 1;
            categoryCounts[cat].labelSet.add(m.metric_label);
        }
        const cleanCats = {};
        for (const [k, v] of Object.entries(categoryCounts)) {
            cleanCats[k] = { sub_metric_count: v.sub_metric_count, metric_count: v.labelSet.size };
        }
        return {
            snapshot_row_id: s.id,
            snapshot_id: s.snapshot_id,
            month: s.month,
            created_at: s.created_at,
            overall_metric_count: labelSet.size,
            sub_metric_count: mRows.length,
            category_counts: cleanCats,
        };
    };

    const trends = sortedSnaps.filter((s) => String(s.created_at || '').slice(0, 10) >= cutoffStr).map(normalizeRow);
    const recent = [...sortedSnaps].reverse().slice(0, 3).map(normalizeRow);
    return { days, trends, recent };
}

function summarizeWarningSnapshot(row) {
    const raw = parseJsonCol(row.raw_data_json, {});
    const tickets = Array.isArray(raw.expiringTickets) ? raw.expiringTickets : [];
    const byCategory = {};
    for (const t of tickets) {
        const key = t?.collection ? `${t.collection} / ${t.title || ''}` : (t?.title || '未分类预警');
        byCategory[key] = (byCategory[key] || 0) + (Number(t.count) || 1);
    }
    return {
        snapshot_row_id: row.id,
        snapshot_id: row.snapshot_id,
        month: row.month,
        created_at: row.created_at,
        total_warnings: tickets.length,
        by_category: byCategory,
    };
}

export async function getExpiringWarningTrends(daysInput = 90) {
    const days = Number.isFinite(Number(daysInput)) && Number(daysInput) > 0 ? Math.min(Number(daysInput), 365) : 90;
    const cutoffStr = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const snaps = await selectTable('report_snapshots', { orderBySql: '`created_at` ASC, `id` ASC', limit: 1000 });
    const sorted = [...snaps].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || ((a.id || 0) - (b.id || 0)));
    return {
        days,
        trends: sorted.filter((s) => String(s.created_at || '').slice(0, 10) >= cutoffStr).map(summarizeWarningSnapshot),
        recent: [...sorted].reverse().slice(0, 3).map(summarizeWarningSnapshot),
    };
}

function parseMetricTargetValue(value) {
    const text = String(value || '').trim();
    if (!text || text === '--') return null;
    const match = text.match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    return { raw: text, value: Number(match[0]), condition: /≤|<=|小于|不高于|低于/.test(text) ? 'lte' : 'gte' };
}

export async function getMetricItemTrend({ label, kind = 'metric', months = 6 } = {}) {
    const cleanLabel = String(label || '').trim();
    if (!cleanLabel) fail('Missing label');
    const monthLimit = Number.isFinite(Number(months)) && Number(months) > 0 ? Math.min(Number(months), 24) : 6;

    const allSnaps = await selectTable('report_snapshots', { orderBySql: '`created_at` ASC, `id` ASC', limit: 1000 });
    const now = new Date();
    const startMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (monthLimit - 1), 1));
    const startPrefix = startMonthDate.toISOString().slice(0, 7);

    const eligible = allSnaps
        .map((r) => ({ ...r, trend_month: String(r.created_at || '').slice(0, 7) }))
        .filter((r) => r.trend_month >= startPrefix);

    const snapshots = selectLatestSnapshotPerMonth(eligible);
    if (!snapshots.length) {
        return { label: cleanLabel, kind, months: monthLimit, sampling: 'monthly_latest', trends: [] };
    }

    if (kind === 'manual') {
        const trends = snapshots.map((row) => {
            const raw = parseJsonCol(row.raw_data_json, {});
            const items = Array.isArray(raw.manualAdjustItems) ? raw.manualAdjustItems : [];
            const adjustData = raw.manualAdjustData && typeof raw.manualAdjustData === 'object' ? raw.manualAdjustData : {};
            const matched = items.map((item, idx) => ({ item, idx })).filter((e) => e.item && !e.item.deleted && e.item.name === cleanLabel);
            const series = {};
            let totalValue = 0;
            let totalScore = 0;
            for (const cat of Object.keys(adjustData)) {
                let count = 0;
                let score = 0;
                for (const { item, idx } of matched) {
                    const val = Number(adjustData[cat]?.[idx]) || 0;
                    count += val;
                    const unit = Number(item.unit) || 0;
                    const cap = item.cap != null && item.cap !== '' ? Number(item.cap) : null;
                    const rawScore = Math.max(0, val) * unit;
                    const capped = Number.isFinite(cap) && cap > 0 ? Math.min(rawScore, cap) : rawScore;
                    score += item.type === '加分' ? capped : -capped;
                }
                if (count !== 0 || score !== 0) {
                    series[cat] = { value: count, score, raw: String(count) };
                    totalValue += count;
                    totalScore += score;
                }
            }
            return {
                snapshot_id: row.snapshot_id,
                month: row.month,
                trend_month: row.trend_month,
                created_at: row.created_at,
                total_value: totalValue,
                total_score: totalScore,
                series,
            };
        });
        return { label: cleanLabel, kind, months: monthLimit, sampling: 'monthly_latest', trends };
    }

    const metricRows = await selectTable('report_metric_data', {
        whereSql: `\`metric_label\` = ${sqlVal(cleanLabel)}`,
        limit: 5000,
        memFilter: (r) => r.metric_label === cleanLabel,
    });

    const trends = snapshots.map((row) => {
        const rows = metricRows.filter((m) => m.snapshot_id === row.snapshot_id && (m.month === row.month || m.month == null));
        const series = {};
        for (const item of rows) {
            const cat = item.cat_name || '整体';
            series[cat] = {
                value: Number.isFinite(Number(item.num_val)) ? Number(item.num_val) : null,
                raw: item.raw_val,
                target_raw: item.target_val || '',
                target_value: parseMetricTargetValue(item.target_val)?.value ?? null,
                is_failing: Boolean(item.is_failing),
                gap: item.gap || '',
            };
        }
        const overall = series['整体'];
        const numericValues = Object.values(series).map((i) => Number(i.value)).filter(Number.isFinite);
        const totalValue = overall && Number.isFinite(Number(overall.value))
            ? Number(overall.value)
            : (numericValues.length ? numericValues.reduce((a, b) => a + b, 0) / numericValues.length : null);
        return {
            snapshot_id: row.snapshot_id,
            month: row.month,
            trend_month: row.trend_month,
            created_at: row.created_at,
            total_value: totalValue,
            total_score: null,
            series,
        };
    });

    const monthTargets = {};
    for (const m of metricRows) {
        const mNum = Number(m.month);
        if (!Number.isFinite(mNum) || monthTargets[mNum]) continue;
        const parsed = parseMetricTargetValue(m.target_val);
        if (parsed && Number.isFinite(parsed.value)) {
            monthTargets[mNum] = { month: mNum, value: parsed.value, raw: parsed.raw, condition: parsed.condition };
        }
    }
    const availableMonths = Object.keys(monthTargets).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const currentMonth = trends.slice().reverse().map((r) => Number(r.month)).find((n) => Number.isFinite(n) && monthTargets[n]) || availableMonths.at(-1);
    const previousMonth = Number.isFinite(currentMonth)
        ? (monthTargets[currentMonth - 1] ? currentMonth - 1 : availableMonths.filter((m) => m < currentMonth).pop() || null)
        : null;

    return {
        label: cleanLabel,
        kind: 'metric',
        months: monthLimit,
        sampling: 'monthly_latest',
        trends,
        targets: {
            current: Number.isFinite(currentMonth) ? monthTargets[currentMonth] || null : null,
            previous: Number.isFinite(previousMonth) ? monthTargets[previousMonth] || null : null,
        },
    };
}

export async function listBigscreenOwners() {
    return selectTable('bigscreen_owners', {
        orderBySql: '`cat_name` ASC, `metric_label` ASC',
        limit: 1000,
        memSort: (a, b) => String(a.cat_name).localeCompare(String(b.cat_name)) || String(a.metric_label).localeCompare(String(b.metric_label)),
    });
}

export async function saveBigscreenOwners(items = []) {
    const normalized = (Array.isArray(items) ? items : [])
        .map((i) => ({
            cat_name: String(i?.cat_name || '').trim(),
            metric_label: String(i?.metric_label || '').trim(),
            owner_name: String(i?.owner_name || '').trim(),
            emp_id: String(i?.emp_id || '').trim(),
            avatar: String(i?.avatar || '').trim(),
        }))
        .filter((i) => i.cat_name && i.owner_name);

    await deleteRows('bigscreen_owners', { whereSql: '`id` > 0', memFilter: () => true });
    const nowStr = normalizeDateTimeStr();
    for (const item of normalized) {
        const ownerKey = `${item.cat_name}::${item.metric_label}`;
        await upsertRow('bigscreen_owners', {
            owner_key: ownerKey,
            cat_name: item.cat_name,
            metric_label: item.metric_label,
            owner_name: item.owner_name,
            emp_id: item.emp_id,
            avatar: item.avatar,
            updated_at: nowStr,
        }, ['owner_key']);
    }
    return { success: true, count: normalized.length };
}

export async function exportReportDataBackupZip() {
    const [snapshots, catScores, metrics, owners] = await Promise.all([
        selectTable('report_snapshots', { limit: 1000 }),
        selectTable('report_category_scores', { limit: 5000 }),
        selectTable('report_metric_data', { limit: 20000 }),
        selectTable('bigscreen_owners', { limit: 1000 }),
    ]);
    const manifest = {
        exportedAt: new Date().toISOString(),
        counts: {
            snapshots: snapshots.length,
            categoryScores: catScores.length,
            metrics: metrics.length,
            owners: owners.length,
        },
    };
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    zip.file('data.json', JSON.stringify({ snapshots, catScores, metrics, owners }));
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return { buffer, manifest };
}

export async function importReportDataBackupZip(zipBuffer, { mode = 'merge' } = {}) {
    const zip = await JSZip.loadAsync(zipBuffer);
    const dataFile = zip.file('data.json');
    if (!dataFile) fail('无效的报表备份包（缺少 data.json）');
    const data = JSON.parse(await dataFile.async('string'));

    if (mode === 'replace') {
        await deleteRows('report_metric_data', { whereSql: '`id` > 0', memFilter: () => true });
        await deleteRows('report_category_scores', { whereSql: '`id` > 0', memFilter: () => true });
        await deleteRows('report_snapshots', { whereSql: '`id` > 0', memFilter: () => true });
        await deleteRows('bigscreen_owners', { whereSql: '`id` > 0', memFilter: () => true });
    }

    for (const s of data.snapshots || []) {
        await insertRow('report_snapshots', {
            snapshot_id: s.snapshot_id,
            month: s.month ?? null,
            created_at: s.created_at || normalizeDateTimeStr(),
            stored_at: s.stored_at || Date.now(),
            standard_total_score: s.standard_total_score ?? null,
            raw_data_json: s.raw_data_json || '{}',
            image_path: s.image_path || null,
            excel_path: s.excel_path || null,
        });
    }
    for (const c of data.catScores || []) {
        await insertRow('report_category_scores', {
            snapshot_id: c.snapshot_id,
            month: c.month ?? null,
            cat_name: c.cat_name || '',
            base_score: c.base_score ?? null,
            manual_score: c.manual_score ?? null,
            final_score: c.final_score ?? null,
        });
    }
    for (const m of data.metrics || []) {
        await insertRow('report_metric_data', {
            snapshot_id: m.snapshot_id,
            month: m.month ?? null,
            cat_name: m.cat_name || '',
            metric_label: m.metric_label || '',
            weight: m.weight ?? null,
            target_val: m.target_val ?? null,
            raw_val: m.raw_val ?? null,
            num_val: m.num_val ?? null,
            is_failing: m.is_failing ? 1 : 0,
            gap: m.gap ?? null,
            earned_score: m.earned_score ?? null,
            proportional_scoring: m.proportional_scoring ? 1 : 0,
            completion_ratio: m.completion_ratio ?? null,
        });
    }
    for (const o of data.owners || []) {
        const key = o.owner_key || `${o.cat_name || ''}::${o.metric_label || ''}`;
        await upsertRow('bigscreen_owners', {
            owner_key: key,
            cat_name: o.cat_name || '',
            metric_label: o.metric_label || '',
            owner_name: o.owner_name || '',
            emp_id: o.emp_id || '',
            avatar: o.avatar || '',
            updated_at: o.updated_at || normalizeDateTimeStr(),
        }, ['owner_key']);
    }

    return {
        success: true,
        mode,
        counts: {
            snapshots: (data.snapshots || []).length,
            categoryScores: (data.catScores || []).length,
            metrics: (data.metrics || []).length,
            owners: (data.owners || []).length,
        },
    };
}

export async function sendExpediteNotification({ recipients = [], title = '', content = '', channel = 'email', payload = null } = {}) {
    const body = payload || {
        module_type: 'AIOps一键催办',
        sub_module_type: channel === 'welink' ? 'WeLink催办通知' : '未达标指标催办',
        msg_type: '1',
        email_params: {
            title: title || '【AIOps 一键催办】未达标指标跟进提醒',
            content: content || '存在未达标运营指标，请及时核查整改。',
            email_to: Array.isArray(recipients) && recipients.length
                ? recipients.join(',')
                : 'email:aiops@example.com',
        },
    };
    const res = await sendBaseNotify(body);
    return { success: true, payload: body, baseResult: res };
}
