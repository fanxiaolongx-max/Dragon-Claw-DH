import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { BusinessError } from '../core/errors.js';
import { optionalDep } from '../core/optional.js';
import { TEMPLATES_DIR, config } from '../config.js';
import { isMemoryMode, kvGet, kvSet, selectTable, upsertRow, insertRow, updateRows, deleteRows, sqlVal, parseJsonCol } from '../dao/scoped.js';
import * as rowStore from './snapshot-row-store.js';

const FAST_MAPPING_KEY = 'sla_fast_mapping_templates';
const AUDIT_LOG_KEY = 'sla_audit_log';
const MAX_SNAPSHOTS = 180;

export function slaSourceLabel() {
    return isMemoryMode() ? 'memory' : 'mysql';
}

async function mapConcurrent(items, limit, fn) {
    const workers = Array.from({ length: Math.min(limit, items.length) }, async (_, offset) => {
        for (let i = offset; i < items.length; i += limit) {
            await fn(items[i], i);
        }
    });
    await Promise.all(workers);
}

export function expandCompressedSnapshot(body) {
    if (!body || typeof body !== 'object') return body;
    if (body.compressedSnapshot && typeof body.compressedSnapshot === 'object') {
        const enc = String(body.compressedSnapshot.encoding || body.transport?.compression || '').toLowerCase();
        const buf = Buffer.from(String(body.compressedSnapshot.data || ''), 'base64');
        const out = enc.includes('deflate') ? zlib.inflateSync(buf) : zlib.gunzipSync(buf);
        return JSON.parse(out.toString('utf8'));
    }
    if (body.transport?.compression === 'gzip-base64' && typeof body.compressedPayload === 'string') {
        const buf = Buffer.from(body.compressedPayload, 'base64');
        const jsonStr = zlib.gunzipSync(buf).toString('utf8');
        return JSON.parse(jsonStr);
    }
    return body;
}

async function appendAudit(action, detail = {}, user = 'system') {
    const current = (await kvGet(AUDIT_LOG_KEY, [])) || [];
    const next = [{ id: crypto.randomUUID(), ts: new Date().toISOString(), action, user, detail }, ...current].slice(0, 200);
    await kvSet(AUDIT_LOG_KEY, next);
}

export async function getAuditLog() {
    return (await kvGet(AUDIT_LOG_KEY, [])) || [];
}

// ── Categories ──
export async function listCategories() {
    const rows = await selectTable('sla_categories', {
        orderBySql: '`sort_order` ASC, `id` ASC',
        limit: 200,
        memSort: (a, b) => ((a.sort_order || 0) - (b.sort_order || 0)) || ((a.id || 0) - (b.id || 0)),
    });
    return rows.map((r) => r.name);
}

export async function replaceCategories(cats = []) {
    await deleteRows('sla_categories', { whereSql: '`id` > 0', memFilter: () => true });
    const now = Date.now();
    for (let i = 0; i < cats.length; i += 1) {
        const name = String(cats[i] || '').trim();
        if (!name) continue;
        await upsertRow('sla_categories', { name, sort_order: i, meta_json: '{}', created_at: now }, ['name']);
    }
    return listCategories();
}

export async function collectCategoryCascadeImpact(catName) {
    const [targets, groups, snapshots] = await Promise.all([getTargets(), listGroups(), listSnapshots({ view: 'summary' })]);
    const matchingTargets = Object.keys(targets).filter((k) => targets[k]?.category === catName).length;
    const matchingGroups = groups.filter((g) => g.category === catName).length;
    const matchingSnapshots = snapshots.filter((s) => s.category === catName).length;
    return {
        category: catName,
        targetsCount: matchingTargets,
        groupsCount: matchingGroups,
        snapshotsCount: matchingSnapshots,
    };
}

export async function deleteCategoryCascade(catName) {
    const targets = await getTargets();
    for (const k of Object.keys(targets)) {
        if (targets[k]?.category === catName) delete targets[k];
    }
    await replaceTargets(targets);
    const groups = await listGroups();
    await replaceGroups(groups.filter((g) => g.category !== catName));
    await deleteRows('sla_snapshots', {
        whereSql: `\`category\` = ${sqlVal(catName)}`,
        memFilter: (r) => r.category === catName,
    });
    rowStore.scheduleGarbageCollection();
    await deleteRows('sla_categories', {
        whereSql: `\`name\` = ${sqlVal(catName)}`,
        memFilter: (r) => r.name === catName,
    });
    return { success: true, deletedCategory: catName };
}

// ── Groups (keyed by group_key so we NEVER use lastInsertId) ──
export async function listGroups() {
    const [groupRows, itemRows] = await Promise.all([
        selectTable('sla_groups', {
            orderBySql: '`sort_order` ASC, `id` ASC',
            limit: 500,
            memSort: (a, b) => ((a.sort_order || 0) - (b.sort_order || 0)) || ((a.id || 0) - (b.id || 0)),
        }),
        selectTable('sla_group_items', {
            orderBySql: '`sort_order` ASC, `id` ASC',
            limit: 2000,
            memSort: (a, b) => ((a.sort_order || 0) - (b.sort_order || 0)) || ((a.id || 0) - (b.id || 0)),
        }),
    ]);
    const byGroup = new Map();
    for (const it of itemRows) {
        if (!byGroup.has(it.group_key)) byGroup.set(it.group_key, []);
        const meta = parseJsonCol(it.meta_json, {}) || {};
        byGroup.get(it.group_key).push(meta.item || it.target_key);
    }
    return groupRows.map((g) => {
        const meta = parseJsonCol(g.meta_json, {}) || {};
        const items = byGroup.get(g.group_key) || meta.items || meta.metrics || [];
        return {
            ...meta,
            id: meta.id || g.group_key,
            key: g.group_key,
            name: g.name,
            category: g.category || '',
            metrics: Array.isArray(meta.metrics) ? meta.metrics : items,
            items,
        };
    });
}

export async function replaceGroups(groups = []) {
    await deleteRows('sla_group_items', { whereSql: '`id` > 0', memFilter: () => true });
    await deleteRows('sla_groups', { whereSql: '`id` > 0', memFilter: () => true });
    const now = Date.now();
    for (let i = 0; i < groups.length; i += 1) {
        const g = groups[i] || {};
        const groupKey = String(g.key || g.id || g.name || `group_${i}`).trim();
        await upsertRow('sla_groups', {
            group_key: groupKey,
            name: String(g.name || groupKey),
            category: String(g.category || ''),
            sort_order: i,
            meta_json: JSON.stringify(g),
            created_at: now,
        }, ['group_key']);
        const items = Array.isArray(g.items) ? g.items : (Array.isArray(g.metrics) ? g.metrics : []);
        for (let j = 0; j < items.length; j += 1) {
            const it = items[j];
            const targetKey = typeof it === 'string' ? it : String(it?.key || it?.targetKey || j);
            await insertRow('sla_group_items', {
                group_key: groupKey,
                target_key: targetKey,
                sort_order: j,
                meta_json: JSON.stringify({ item: it }),
            });
        }
    }
    return listGroups();
}

// ── Targets ──
export async function getTargets() {
    const rows = await selectTable('sla_targets', {
        orderBySql: '`sort_order` ASC, `id` ASC',
        limit: 1000,
        memSort: (a, b) => ((a.sort_order || 0) - (b.sort_order || 0)) || ((a.id || 0) - (b.id || 0)),
    });
    const out = {};
    for (const r of rows) {
        out[r.target_key] = parseJsonCol(r.payload_json, {}) || {};
    }
    return out;
}

export async function replaceTargets(targets = {}) {
    await deleteRows('sla_targets', { whereSql: '`id` > 0', memFilter: () => true });
    const entries = Object.entries(targets || {});
    const now = Date.now();
    await mapConcurrent(entries, 8, async ([key, val], i) => {
        await upsertRow('sla_targets', {
            target_key: String(key),
            name: String(val?.name || val?.label || key),
            category: String(val?.category || ''),
            payload_json: JSON.stringify(val ?? {}),
            sort_order: i,
            updated_at: now,
        }, ['target_key']);
    });
    return getTargets();
}

export async function patchTargetsBulk(targets = {}, sortOffset = 0) {
    const entries = Object.entries(targets || {});
    if (!entries.length) return {};
    const now = Date.now();
    await mapConcurrent(entries, 8, async ([key, val], i) => {
        await upsertRow('sla_targets', {
            target_key: String(key),
            name: String(val?.name || val?.label || key),
            category: String(val?.category || ''),
            payload_json: JSON.stringify(val ?? {}),
            sort_order: sortOffset + i,
            updated_at: now,
        }, ['target_key']);
    });
    return getTargets();
}

export async function patchTarget(targetKey, patch = {}) {
    const existing = await getTargets();
    const next = { ...(existing[targetKey] || {}), ...patch };
    await upsertRow('sla_targets', {
        target_key: String(targetKey),
        name: String(next?.name || next?.label || targetKey),
        category: String(next?.category || ''),
        payload_json: JSON.stringify(next),
        sort_order: Object.keys(existing).length,
        updated_at: Date.now(),
    }, ['target_key']);
    return next;
}

// ── Prefs ──
export async function getPrefsObject() {
    const rows = await selectTable('sla_config_items', {
        whereSql: "`scope_key` = 'sla_pref'",
        limit: 500,
        memFilter: (r) => r.scope_key === 'sla_pref',
    });
    const obj = {};
    for (const r of rows) {
        obj[r.item_key] = parseJsonCol(r.value_json, {});
    }
    return obj;
}

export async function getPrefItem(schemaHash) {
    const rows = await selectTable('sla_config_items', {
        whereSql: `\`item_key\` = ${sqlVal(schemaHash)} AND \`scope_key\` = 'sla_pref'`,
        limit: 1,
        memFilter: (r) => r.item_key === schemaHash && r.scope_key === 'sla_pref',
    });
    return rows.length ? parseJsonCol(rows[0].value_json, {}) : null;
}

export async function upsertPrefItem(schemaHash, value) {
    await upsertRow('sla_config_items', {
        item_key: String(schemaHash),
        scope_key: 'sla_pref',
        value_json: JSON.stringify(value ?? {}),
        updated_at: Date.now(),
    }, ['item_key', 'scope_key']);
    return value;
}

export async function patchPrefsBulk(patch = {}) {
    await mapConcurrent(Object.entries(patch || {}), 8, async ([k, v]) => {
        await upsertPrefItem(k, v);
    });
    return { success: true };
}

// ── Snapshots (MySQL-safe prune without NOT IN + LIMIT subquery) ──
/** hydrate=false 时不还原明细行（只要元信息、行数时用，省去解压） */
export async function listSnapshots({ view = 'full', hydrate = true } = {}) {
    const rows = await selectTable('sla_snapshots', {
        columns: view === 'summary' ? ['id', 'seq', 'category', 'name', 'snapshot_time', 'created_at'] : ['*'],
        orderBySql: '`seq` DESC',
        limit: MAX_SNAPSHOTS,
        memSort: (a, b) => (b.seq || 0) - (a.seq || 0),
    });
    const items = rows.map((r) => {
        if (view === 'summary') {
            return { id: r.id, category: r.category, name: r.name, timestamp: r.snapshot_time, createdAt: r.created_at };
        }
        const payload = parseJsonCol(r.payload_json, {}) || {};
        return { ...payload, id: r.id, category: r.category || payload.category || '', name: r.name || payload.name || '', timestamp: r.snapshot_time || payload.timestamp || '' };
    });
    if (view === 'summary' || !hydrate) return items;
    scheduleCompaction();
    return rowStore.hydrateAll(items);
}

// 旧快照（明细行内嵌）在第一次读到快照列表后，于后台逐条转成去重存储（每个进程一次）
let compactionStarted = false;
function scheduleCompaction(delayMs = config.snapshotRowsCompactDelayMs) {
    if (compactionStarted || isMemoryMode()) return;
    compactionStarted = true;
    const timer = setTimeout(() => compactSnapshotRows()
        .then((summary) => { if (summary.converted || summary.failed) console.log('[snapshot-rows] 旧快照转换：', JSON.stringify(summary)); })
        .then(() => rowStore.collectGarbage())
        .catch((error) => console.warn('[snapshot-rows] 旧快照转换失败：', error.message)), delayMs);
    timer.unref?.();
}

export async function compactSnapshotRows({ pauseMs = 50 } = {}) {
    return rowStore.compact({
        pauseMs,
        listIds: async () => (await selectTable('sla_snapshots', { columns: ['id'], limit: 1000 })).map((r) => r.id),
        read: async (id) => {
            const rows = await selectTable('sla_snapshots', { whereSql: `\`id\` = ${sqlVal(id)}`, limit: 1, memFilter: (r) => r.id === id });
            return rows.length ? parseJsonCol(rows[0].payload_json, null) : null;
        },
        write: (id, payload) => updateRows('sla_snapshots', { payload_json: JSON.stringify(payload) }, { whereSql: `\`id\` = ${sqlVal(id)}`, memFilter: (r) => r.id === id }),
    });
}

export async function getLatestSnapshot() {
    const rows = await selectTable('sla_snapshots', {
        orderBySql: '`seq` DESC',
        limit: 1,
        memSort: (a, b) => (b.seq || 0) - (a.seq || 0),
    });
    if (!rows.length) return null;
    const r = rows[0];
    return rowStore.hydrate({ ...(parseJsonCol(r.payload_json, {}) || {}), id: r.id });
}

export async function getSnapshotById(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    const rows = await selectTable('sla_snapshots', {
        whereSql: `\`id\` = ${sqlVal(key)}`,
        limit: 1,
        memFilter: (r) => r.id === key,
    });
    if (!rows.length) return null;
    const r = rows[0];
    const payload = parseJsonCol(r.payload_json, {}) || {};
    return rowStore.hydrate({ ...payload, id: r.id, category: r.category || payload.category || '', name: r.name || payload.name || '', timestamp: r.snapshot_time || payload.timestamp || '' });
}

export async function addSnapshot(snapshot = {}) {
    const id = String(snapshot.id || `snap_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`);
    const now = Date.now();
    const full = { ...snapshot, id, timestamp: snapshot.timestamp || new Date().toISOString() };
    // 明细行存进去重存储，快照里只留引用
    const stored = await rowStore.dehydrate(full);
    await upsertRow('sla_snapshots', {
        id,
        category: String(snapshot.category || ''),
        name: String(snapshot.name || snapshot.label || id).slice(0, 250),
        snapshot_time: String(full.timestamp),
        payload_json: JSON.stringify(stored),
        created_at: now,
    }, ['id'], ['category', 'name', 'snapshot_time', 'payload_json']);

    // 安全裁剪超额旧快照：先查超出阈值的主键，再按具体主键删
    const allIds = await selectTable('sla_snapshots', {
        columns: ['id', 'seq'],
        orderBySql: '`seq` DESC',
        limit: 500,
        memSort: (a, b) => (b.seq || 0) - (a.seq || 0),
    });
    if (allIds.length > MAX_SNAPSHOTS) {
        const dropIds = allIds.slice(MAX_SNAPSHOTS).map((r) => sqlVal(r.id));
        const dropSet = new Set(allIds.slice(MAX_SNAPSHOTS).map((r) => r.id));
        await deleteRows('sla_snapshots', {
            whereSql: `\`id\` IN (${dropIds.join(', ')})`,
            memFilter: (r) => dropSet.has(r.id),
        });
        rowStore.scheduleGarbageCollection();
    }
    return full;
}

export async function updateSnapshot(id, patch = {}) {
    const rows = await selectTable('sla_snapshots', {
        whereSql: `\`id\` = ${sqlVal(id)}`,
        limit: 1,
        memFilter: (r) => r.id === id,
    });
    if (!rows.length) return false;
    const prev = await rowStore.hydrate(parseJsonCol(rows[0].payload_json, {}) || {});
    const merged = { ...prev, ...patch, id };
    const stored = await rowStore.dehydrate(merged);
    await updateRows('sla_snapshots', {
        name: String(merged.name || rows[0].name),
        category: String(merged.category || rows[0].category),
        payload_json: JSON.stringify(stored),
    }, {
        whereSql: `\`id\` = ${sqlVal(id)}`,
        memFilter: (r) => r.id === id,
    });
    return true;
}

export async function deleteSnapshot(id) {
    const n = await deleteRows('sla_snapshots', {
        whereSql: `\`id\` = ${sqlVal(id)}`,
        memFilter: (r) => r.id === id,
    });
    rowStore.scheduleGarbageCollection();
    return { deleted: n > 0, id };
}

export async function previewDeleteSnapshot(id) {
    const rows = await selectTable('sla_snapshots', {
        whereSql: `\`id\` = ${sqlVal(id)}`,
        limit: 1,
        memFilter: (r) => r.id === id,
    });
    return { exists: rows.length > 0, id };
}

export async function cleanupRedundantSnapshots({ mode = 'daily-latest', dryRun = false } = {}) {
    const all = await listSnapshots({ view: 'summary' });
    if (all.length <= 1) return { removedIds: [], keptCount: all.length, dryRun };
    const toRemove = [];
    if (mode === 'latest-only') {
        toRemove.push(...all.slice(1).map((s) => s.id));
    } else {
        const seenDay = new Set();
        for (const s of all) {
            const day = String(s.timestamp || '').slice(0, 10) || s.id;
            if (seenDay.has(day)) toRemove.push(s.id);
            else seenDay.add(day);
        }
    }
    if (!dryRun && toRemove.length) {
        const set = new Set(toRemove);
        await deleteRows('sla_snapshots', {
            whereSql: `\`id\` IN (${toRemove.map(sqlVal).join(', ')})`,
            memFilter: (r) => set.has(r.id),
        });
        rowStore.scheduleGarbageCollection();
    }
    return { removedIds: toRemove, removedCount: toRemove.length, keptCount: all.length - toRemove.length, dryRun };
}

// ── Copied Fields & Rule Templates ──
export async function getCopiedFields(tableType = '') {
    const store = (await kvGet('sla_copied_fields', {})) || {};
    if (tableType) return { fields: store[tableType] || {}, store };
    return { store };
}

export async function recordCopiedField(tableType = 'default', fieldName) {
    const store = (await kvGet('sla_copied_fields', {})) || {};
    const t = String(tableType || 'default');
    store[t] = store[t] || {};
    store[t][fieldName] = (Number(store[t][fieldName]) || 0) + 1;
    await kvSet('sla_copied_fields', store);
    return { tableType: t, fieldName, count: store[t][fieldName] };
}

export async function deleteCopiedField(tableType = 'default', fieldName = '') {
    const store = (await kvGet('sla_copied_fields', {})) || {};
    if (!fieldName) delete store[tableType];
    else if (store[tableType]) delete store[tableType][fieldName];
    await kvSet('sla_copied_fields', store);
}

export async function getFastMappingTemplates() {
    return (await kvGet(FAST_MAPPING_KEY, { templates: [] })) || { templates: [] };
}

export async function saveFastMappingTemplates(data) {
    return kvSet(FAST_MAPPING_KEY, data || { templates: [] });
}

export async function renameMetricKey(oldKey, newKey, user) {
    const targets = await getTargets();
    if (targets[oldKey]) {
        targets[newKey] = { ...targets[oldKey], name: newKey };
        delete targets[oldKey];
        await replaceTargets(targets);
    }
    await appendAudit('rename-metric', { oldKey, newKey }, user);
    return { success: true };
}

// ── Yuxiang Template & Export (ExcelJS) ──
const YUXIANG_MAPPING_KEY = 'yuxiang_template_mapping';
const YUXIANG_NETWORKS = ['TE', 'ORG', 'ET', 'VDF'];
const YUXIANG_TOTALS = [
    ['SYS_SubTotal', 'subTotal', 37],
    ['SYS_AdjustTotal', 'adjustTotal', 54],
    ['SYS_WeightInMonth', 'weightInMonth', 55],
    ['SYS_FinalResult', 'finalResult', 56],
];
const YUXIANG_MAP_TAG = /\[Map:\s*(.+?)\]/;

async function openYuxiangTemplate() {
    const templatePath = path.join(TEMPLATES_DIR, '每月赛马-分网络.xlsx');
    if (!fs.existsSync(templatePath)) throw new BusinessError('未找到内置赛马表模板', 500);
    const { default: ExcelJS } = await optionalDep('exceljs', '裕湘模板 Excel 导出');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(templatePath);
    return workbook;
}

function stripYuxiangMapTag(text) {
    return text.replace(/\s*\[Map:\s*.+?\]/g, '');
}

function getDefaultYuxiangRows(sheet) {
    const rows = [];
    sheet.eachRow((row, r) => {
        if (r < 3) return;
        const originalVal = row.getCell(3).text;
        const text = stripYuxiangMapTag(originalVal).trim();
        const mapping = (row.getCell(26).text.match(YUXIANG_MAP_TAG)?.[1]
            ?? originalVal.match(YUXIANG_MAP_TAG)?.[1] ?? '').trim();
        if (text || mapping) rows[r - 3] = { r, text, mapping, originalVal };
    });
    return Array.from(rows, (row, idx) => row || { r: idx + 3, text: '', mapping: '', originalVal: '' });
}

function normalizeYuxiangRows(updates, defaults) {
    if (!Array.isArray(updates)) {
        // 兼容旧基座保存的「行号 → 指标」对象。
        return defaults.map(row => ({
            ...row,
            sourceR: row.r,
            mapping: typeof updates?.[row.r] === 'string' ? updates[row.r].trim() : row.mapping,
        }));
    }
    return updates.map((update, idx) => {
        const r = idx + 3;
        const source = Number(update?.isNew
            ? update.templateSourceR ?? update.sourceR
            : update?.sourceR ?? update?.templateSourceR ?? update?.r);
        const sourceR = defaults[source - 3] ? source : Math.min(r, defaults.length + 2);
        const text = stripYuxiangMapTag(String(update?.text ?? ''));
        const mapping = String(update?.mapping ?? '').trim();
        return { r, sourceR, text, mapping, originalVal: text };
    });
}

export async function readYuxiangTemplateMapping() {
    const [workbook, updates] = await Promise.all([openYuxiangTemplate(), kvGet(YUXIANG_MAPPING_KEY)]);
    return normalizeYuxiangRows(updates, getDefaultYuxiangRows(workbook.worksheets[0]));
}

export async function saveYuxiangTemplateMapping(updates) {
    if (!updates || typeof updates !== 'object') throw new BusinessError('赛马表映射格式无效');
    await kvSet(YUXIANG_MAPPING_KEY, updates);
    return { success: true };
}

function applyYuxiangLayout(sheet, rows, templateLastRow) {
    const merges = sheet.model.merges.map(range => range.split(':').map(address => sheet.getCell(address)));
    const bodyMerges = merges.filter(([start]) => start.row >= 3);
    const columnCount = sheet.columnCount;
    const sourceRows = new Map();
    for (let r = 3; r <= templateLastRow; r++) {
        const row = sheet.getRow(r);
        const cells = Array.from({ length: columnCount }, (_, idx) => {
            const cell = row.getCell(idx + 1);
            return { value: cell.value, style: cell.style };
        });
        sourceRows.set(r, { cells, height: row.height, hidden: row.hidden, outlineLevel: row.outlineLevel });
    }

    // 从未修改的模板行取样，再按映射设置重排，避免移动或插入时覆盖后续行的样式。
    for (const [start, end] of bodyMerges) sheet.unMergeCells(start.address, end.address);
    for (let r = 3; r <= Math.max(templateLastRow, rows.length + 2); r++) {
        const row = sheet.getRow(r);
        const source = sourceRows.get(rows[r - 3]?.sourceR);
        row.values = [];
        row.height = source?.height;
        row.hidden = source?.hidden ?? false;
        row.outlineLevel = source?.outlineLevel ?? 0;
        source?.cells.forEach(({ value, style }, idx) => {
            const cell = row.getCell(idx + 1);
            cell.value = value;
            cell.style = style;
        });
    }
    for (const [start, end] of bodyMerges) {
        let first = null;
        for (let idx = 0; idx <= rows.length; idx++) {
            const sourceR = rows[idx]?.sourceR;
            if (sourceR >= start.row && sourceR <= end.row) {
                first ??= idx + 3;
            } else if (first !== null) {
                const last = idx + 2;
                if (last > first || end.col > start.col) {
                    sheet.mergeCellsWithoutStyle(first, start.col, last, end.col);
                }
                first = null;
            }
        }
    }
}

function setYuxiangCell(row, col, value, { score = false, missing = false, failing = false } = {}) {
    const cell = row.getCell(col);
    const isPercent = typeof value === 'string' && value.endsWith('%');
    if (value == null || value === '' || value === '--' || (score && missing && Number(value) === 0)) value = '/';
    if (score && !isPercent && Number.isFinite(Number(value))) {
        const number = Number(value);
        value = Math.sign(number) * Math.round((Math.abs(number) + Number.EPSILON) * 100) / 100;
    }
    cell.value = value;
    cell.style = { ...cell.style };
    if (!isPercent) cell.numFmt = score && typeof value === 'number' ? '0.00' : 'General';
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    if (failing) cell.font = { ...cell.font, color: { argb: 'FFFF0000' }, bold: true };
}

async function fillYuxiangWorkbook({ metrics, adjustments, totals, targetMonth } = {}) {
    const [workbook, updates] = await Promise.all([openYuxiangTemplate(), kvGet(YUXIANG_MAPPING_KEY)]);
    const sheet = workbook.worksheets[0];
    const defaults = getDefaultYuxiangRows(sheet);
    const rows = normalizeYuxiangRows(updates, defaults);
    const hasCustomLayout = Array.isArray(updates);
    if (hasCustomLayout) applyYuxiangLayout(sheet, rows, defaults.at(-1)?.r ?? 2);

    const mappingToRow = new Map();
    for (const { r, text, mapping } of rows) {
        const row = sheet.getRow(r);
        const label = row.getCell(3).master;
        label.style = { ...label.style };
        label.alignment = { horizontal: 'left', vertical: 'middle', wrapText: false };
        if (hasCustomLayout || label.text.includes('[Map:')) label.value = text;
        if (updates != null) row.getCell(26).value = mapping ? `[Map:${mapping}]` : null;
        if (mapping) mappingToRow.set(mapping, r);
    }
    const mappedRow = (label, fallback) => mappingToRow.get(label)
        ?? (hasCustomLayout || mappingToRow.size ? undefined : fallback);

    const monthNumber = Number(targetMonth);
    const month = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May.', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'][monthNumber - 1];
    if (month) {
        sheet.getCell('J1').value = `Target\n  (${month})`;
        sheet.getCell('K1').value = `Achivement\n (${month})`;
        sheet.getCell('O1').value = `Score\n (${month})`;
    }

    if (Array.isArray(metrics)) metrics.forEach((metric, idx) => {
        const r = mappedRow(metric?.label, idx + 3);
        if (!metric || !r) return;
        const row = sheet.getRow(r);
        const isPercent = YUXIANG_NETWORKS.some(network => String(metric[network]?.achv).includes('%'));
        const target = metric.target;
        setYuxiangCell(row, 10, isPercent && target != null && target !== '' && target !== '--' && !String(target).includes('%')
            ? `${target}%`
            : target);
        YUXIANG_NETWORKS.forEach((network, idx) => {
            const { achv, score, isFailing } = metric[network] || {};
            const missing = achv == null || achv === '' || achv === '--';
            setYuxiangCell(row, 11 + idx, achv, { failing: isFailing });
            setYuxiangCell(row, 15 + idx, score, { score: true, missing, failing: isFailing });
        });
    });

    if (Array.isArray(adjustments)) adjustments.forEach((adjustment, idx) => {
        const r = mappedRow(adjustment?.label, 38 + idx);
        if (!adjustment || !r) return;
        const row = sheet.getRow(r);
        const label = row.getCell(3).text;
        const type = ['加分', 'Add'].includes(adjustment.type) ? 'Add' : 'Deduct';
        const unit = Number(adjustment.unit);
        sheet.unMergeCells(r, 1, r, 9);
        sheet.mergeCells(r, 6, r, 9);
        setYuxiangCell(row, 1, type);
        setYuxiangCell(row, 2, 'All');
        setYuxiangCell(row, 3, label);
        row.getCell(3).alignment = { horizontal: 'left', vertical: 'middle', wrapText: false };
        setYuxiangCell(row, 4, Number.isFinite(unit) ? `${unit} point/${type === 'Deduct' ? 'case' : 'time'}` : '');
        setYuxiangCell(row, 5, 'Timely');
        setYuxiangCell(row, 6, '/');
        setYuxiangCell(row, 10, '/');
        YUXIANG_NETWORKS.forEach((network, idx) => {
            const { score, count } = adjustment[network] || {};
            const hasScore = Number(score) !== 0 && score != null;
            setYuxiangCell(row, 11 + idx, hasScore ? count : '/', { failing: score < 0 });
            setYuxiangCell(row, 15 + idx, hasScore ? score : '/', { score: true, failing: score < 0 });
        });
    });

    for (const [label, key, fallback] of YUXIANG_TOTALS) {
        const r = mappedRow(label, fallback);
        if (!r || !totals?.[key]) continue;
        const row = sheet.getRow(r);
        const text = row.getCell(3).text || row.getCell(1).text;
        sheet.unMergeCells(r, 1, r, 5);
        sheet.mergeCells(r, 1, r, 5);
        setYuxiangCell(row, 1, text);
        const cell = row.getCell(1);
        cell.font = { ...cell.font, bold: true };
        YUXIANG_NETWORKS.forEach((network, idx) => {
            setYuxiangCell(row, 15 + idx, totals[key][network], { score: true });
        });
    }

    sheet.getColumn(3).width = 70;
    for (let c = 10; c <= 18; c++) sheet.getColumn(c).width = 12;
    const maxRow = Math.min(sheet.rowCount, Math.max(65, rows.at(-1)?.r ?? 0));
    return { workbook, sheet, maxRow };
}

export async function previewYuxiangWorkbook(body) {
    const { sheet, maxRow } = await fillYuxiangWorkbook(body);
    const maxCol = 18;
    const rows = Array.from({ length: maxRow }, (_, r) => Array.from({ length: maxCol }, (_, c) => {
        const cell = sheet.getCell(r + 1, c + 1);
        const value = cell.text;
        return {
            val: c >= 14 && value.trim() && Number.isFinite(Number(value)) ? Number(value).toFixed(2) : value,
            isMerged: cell.isMerged,
            masterAddress: cell.isMerged ? cell.master.address : null,
            address: cell.address,
            bg: cell.fill?.fgColor?.argb ?? null,
            color: cell.font?.color?.argb ?? null,
            bold: Boolean(cell.font?.bold),
            align: cell.alignment?.horizontal || 'left',
        };
    }));
    return { maxRow, maxCol, merges: sheet.model.merges, rows };
}

export async function exportYuxiangBuffer(body = {}) {
    const { workbook, sheet, maxRow } = await fillYuxiangWorkbook(body);
    for (const [key, value] of Object.entries(body.overrides || {})) {
        if (!/^\d+_\d+$/.test(key)) continue;
        const [r, c] = key.split('_').map(Number);
        if (r < 1 || r > maxRow || c < 1 || c > 18 || !['string', 'number'].includes(typeof value)) continue;
        const cell = sheet.getCell(r, c);
        if (cell.master !== cell) continue;
        const number = Number(value);
        cell.value = String(value).trim() && Number.isFinite(number) ? number : value;
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
}
