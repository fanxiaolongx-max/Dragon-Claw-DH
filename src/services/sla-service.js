import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { optionalDep } from '../core/optional.js';
import { TEMPLATES_DIR } from '../config.js';
import { kvGet, kvSet, selectTable, upsertRow, insertRow, updateRows, deleteRows, sqlVal, parseJsonCol } from '../dao/scoped.js';

const FAST_MAPPING_KEY = 'sla_fast_mapping_templates';
const AUDIT_LOG_KEY = 'sla_audit_log';
const MAX_SNAPSHOTS = 180;

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
        return {
            ...meta,
            key: g.group_key,
            name: g.name,
            category: g.category || '',
            items: byGroup.get(g.group_key) || meta.items || [],
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
        const items = Array.isArray(g.items) ? g.items : [];
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
    for (let i = 0; i < entries.length; i += 1) {
        const [key, val] = entries[i];
        await upsertRow('sla_targets', {
            target_key: String(key),
            name: String(val?.name || val?.label || key),
            category: String(val?.category || ''),
            payload_json: JSON.stringify(val ?? {}),
            sort_order: i,
            updated_at: now,
        }, ['target_key']);
    }
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
    return rows.length ? parseJsonCol(rows[0].value_json, {}) : {};
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
    for (const [k, v] of Object.entries(patch || {})) {
        await upsertPrefItem(k, v);
    }
    return { success: true };
}

// ── Snapshots (MySQL-safe prune without NOT IN + LIMIT subquery) ──
export async function listSnapshots({ view = 'full' } = {}) {
    const rows = await selectTable('sla_snapshots', {
        columns: view === 'summary' ? ['id', 'seq', 'category', 'name', 'snapshot_time', 'created_at'] : ['*'],
        orderBySql: '`seq` DESC',
        limit: MAX_SNAPSHOTS,
        memSort: (a, b) => (b.seq || 0) - (a.seq || 0),
    });
    return rows.map((r) => {
        if (view === 'summary') {
            return { id: r.id, category: r.category, name: r.name, timestamp: r.snapshot_time, createdAt: r.created_at };
        }
        const payload = parseJsonCol(r.payload_json, {}) || {};
        return { ...payload, id: r.id, category: r.category || payload.category || '', name: r.name || payload.name || '', timestamp: r.snapshot_time || payload.timestamp || '' };
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
    return { ...(parseJsonCol(r.payload_json, {}) || {}), id: r.id };
}

export async function addSnapshot(snapshot = {}) {
    const id = String(snapshot.id || `snap_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`);
    const now = Date.now();
    const full = { ...snapshot, id, timestamp: snapshot.timestamp || new Date().toISOString() };
    await upsertRow('sla_snapshots', {
        id,
        category: String(snapshot.category || ''),
        name: String(snapshot.name || snapshot.label || id).slice(0, 250),
        snapshot_time: String(full.timestamp),
        payload_json: JSON.stringify(full),
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
    const prev = parseJsonCol(rows[0].payload_json, {}) || {};
    const merged = { ...prev, ...patch, id };
    await updateRows('sla_snapshots', {
        name: String(merged.name || rows[0].name),
        category: String(merged.category || rows[0].category),
        payload_json: JSON.stringify(merged),
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
function findYuxiangTemplate() {
    const candidate = path.join(TEMPLATES_DIR, '每月赛马-分网络.xlsx');
    return fs.existsSync(candidate) ? candidate : null;
}

export async function readYuxiangTemplateMapping() {
    const templatePath = findYuxiangTemplate();
    if (!templatePath) return [];
    const { default: ExcelJS } = await optionalDep('exceljs', '裕湘模板 Excel 导出');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(templatePath);
    const sheet = workbook.worksheets[0];
    if (!sheet) return [];
    const customMapping = (await kvGet('yuxiang_template_mapping', null)) || {};
    const items = [];
    sheet.eachRow((row, rowNumber) => {
        const first = String(row.getCell(1)?.text || '').trim();
        const second = String(row.getCell(2)?.text || '').trim();
        if (rowNumber >= 2 && (first || second)) {
            items.push({ row: rowNumber, category: first, metric: second, mappedKey: customMapping[`${rowNumber}`] || '' });
        }
    });
    return items;
}

export async function saveYuxiangTemplateMapping(updates = {}) {
    await kvSet('yuxiang_template_mapping', updates || {});
    return { success: true };
}

export async function exportYuxiangBuffer(body = {}) {
    const templatePath = findYuxiangTemplate();
    const { default: ExcelJS } = await optionalDep('exceljs', '裕湘模板 Excel 导出');
    const workbook = new ExcelJS.Workbook();
    if (templatePath) {
        await workbook.xlsx.readFile(templatePath);
    } else {
        const ws = workbook.addWorksheet('每月赛马-分网络');
        ws.addRow(['类别', '指标', '数值']);
    }
    const ws = workbook.worksheets[0];
    const metrics = Array.isArray(body.metrics) ? body.metrics : [];
    if (metrics.length && ws.rowCount <= 1) {
        for (const m of metrics) {
            ws.addRow([m.cat_name || '', m.metric_label || m.name || '', m.raw_val ?? m.num_val ?? '']);
        }
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
}
