import crypto from 'node:crypto';
import {
    kvGet,
    kvSet,
    selectTable,
    insertRow,
    upsertRow,
    updateRows,
    deleteRows,
    sqlVal,
    parseJsonCol,
} from '../dao/scoped.js';
import { listSnapshots as listSlaSnapshots } from './sla-service.js';
import { documentRevision } from '../utils/ai-report-helpers.js';

const IMPORT_SETTINGS_KEY = 'import_settings';
const DEFAULT_TEMPLATE_KEY = 'monthly_default_template';
const SOURCE_CATEGORIES_KEY = 'source_categories_map';
const SOURCE_PRESENTATIONS_KEY = 'source_presentations_map';
const QUICK_METRICS_KEY = 'monthly_quick_metrics_map';

const PRESET_TYPE_MAP = {
    component: 'component',
    mapping: 'mapping',
    dataFormat: 'dataFormat',
};

function fail(message, status = 400, code = 'IMPORT_SOURCE_ERROR') {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    throw error;
}

function normalizeFileName(value) {
    return String(value || '').trim();
}

function deriveSourceKey(name) {
    return String(name || '')
        .replace(/\.[^.]+$/, '')
        .replace(/(Latest).*/i, '$1')
        .replace(/\s*\(\d+\)$/, '')
        .replace(/20\d{2}[-_]\d{2}[-_]\d{2}/g, '{date}');
}

function snapshotTime(value) {
    const text = String(value || '');
    return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}Z` : text) || 0;
}

// ============================================================
// Upload History (upload_history)
// ============================================================

export async function listUploadHistory({ tool, limit = 50 } = {}) {
    const maxRows = Math.max(1, Math.min(500, Number(limit) || 50));
    const rows = await selectTable('upload_history', {
        orderBySql: '`created_at` DESC, `id` DESC',
        limit: 500,
        memSort: (a, b) => (b.created_at || 0) - (a.created_at || 0),
    });
    const mapped = rows.map((r) => {
        const p = parseJsonCol(r.payload_json, {});
        return {
            id: r.entry_key || String(r.id),
            tool: p.tool || '',
            action: p.action || '',
            detail: p.detail ?? null,
            fileName: r.file_name || p.fileName || '',
            timestamp: p.timestamp || (r.created_at ? new Date(r.created_at).toISOString() : ''),
            createdAt: r.created_at,
        };
    });
    const filtered = tool ? mapped.filter((item) => item.tool === tool) : mapped;
    return filtered.slice(0, maxRows);
}

export async function addUploadHistory({ tool, action, detail }) {
    if (!tool || !action) fail('参数不完整');
    const now = Date.now();
    const entryKey = `hist_${now}_${crypto.randomUUID().slice(0, 8)}`;
    const item = {
        id: entryKey,
        tool: String(tool),
        action: String(action),
        detail: detail ?? null,
        timestamp: new Date(now).toISOString(),
    };
    const fileName = detail && typeof detail === 'object' ? String(detail.fileName || detail.name || '') : '';
    await insertRow('upload_history', {
        entry_key: entryKey,
        file_name: fileName.slice(0, 250),
        payload_json: JSON.stringify(item),
        created_at: now,
    });
    return item;
}

export async function clearUploadHistory({ tool } = {}) {
    if (!tool) {
        await deleteRows('upload_history', { whereSql: '`id` > 0', memFilter: () => true });
        return { success: true };
    }
    const rows = await selectTable('upload_history', { limit: 1000 });
    for (const r of rows) {
        const p = parseJsonCol(r.payload_json, {});
        if (p.tool === tool) {
            await deleteRows('upload_history', {
                whereSql: `\`entry_key\` = ${sqlVal(r.entry_key)}`,
                memFilter: (x) => x.entry_key === r.entry_key,
            });
        }
    }
    return { success: true };
}

// ============================================================
// Import Settings & Source Batches / Files / Sheets
// ============================================================

export async function getImportSettings() {
    return (await kvGet(IMPORT_SETTINGS_KEY, {
        requireOriginalUploads: false,
        autoArchive: true,
        retentionDays: 180,
    })) || { requireOriginalUploads: false, autoArchive: true, retentionDays: 180 };
}

export async function saveImportSettings(settings = {}) {
    const next = { ...(await getImportSettings()), ...(settings && typeof settings === 'object' ? settings : {}) };
    await kvSet(IMPORT_SETTINGS_KEY, next);
    return next;
}

export async function createBatch({ source = 'manual', targetMonth = '' } = {}) {
    const id = `batch_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();
    const meta = { source: String(source || 'manual'), target_month: targetMonth ? String(targetMonth) : null };
    await insertRow('import_source_batches', {
        id,
        name: targetMonth ? `${source}_${targetMonth}` : String(source),
        category: String(source || 'manual'),
        status: 'ready',
        meta_json: JSON.stringify(meta),
        created_at: now,
        updated_at: now,
    });
    return { id, source: meta.source, target_month: meta.target_month, created_at: new Date(now).toISOString() };
}

export async function saveFile(batchId, file, kind = 'original') {
    const batches = await selectTable('import_source_batches', {
        whereSql: `\`id\` = ${sqlVal(batchId)}`,
        limit: 1,
        memFilter: (b) => b.id === batchId,
    });
    if (!batches.length) fail('导入批次不存在', 404);
    const buf = Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.from(file?.base64 || '', 'base64');
    if (!buf.length) fail('缺少上传文件内容');
    const filename = normalizeFileName(file?.originalName || file?.originalname || file?.filename || 'source.xlsx');
    const sourceKey = deriveSourceKey(filename);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const fileId = `file_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();
    const meta = {
        kind: kind === 'structured' ? 'structured' : 'original',
        source_key: sourceKey,
        parse_status: 'pending',
        parse_error: '',
    };
    await insertRow('import_source_files', {
        id: fileId,
        batch_id: batchId,
        filename,
        category: String(file?.category || ''),
        size_bytes: buf.length,
        sha256,
        file_base64: buf.toString('base64'),
        meta_json: JSON.stringify(meta),
        created_at: now,
    });
    return {
        id: fileId,
        batch_id: batchId,
        name: filename,
        source_key: sourceKey,
        kind: meta.kind,
        size: buf.length,
        sha256,
        parse_status: meta.parse_status,
        created_at: new Date(now).toISOString(),
    };
}

export async function getFile(fileId, includeBlob = false) {
    const rows = await selectTable('import_source_files', {
        whereSql: `\`id\` = ${sqlVal(fileId)}`,
        limit: 1,
        memFilter: (r) => r.id === fileId,
    });
    if (!rows.length) return null;
    const r = rows[0];
    const meta = parseJsonCol(r.meta_json, {});
    return {
        id: r.id,
        batch_id: r.batch_id,
        name: normalizeFileName(r.filename),
        source_key: meta.source_key || deriveSourceKey(r.filename),
        kind: meta.kind || 'original',
        size: Number(r.size_bytes) || 0,
        sha256: r.sha256 || '',
        parse_status: meta.parse_status || 'ready',
        parse_error: meta.parse_error || '',
        library_category: r.category || '',
        created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
        ...(includeBlob ? { original_blob: r.file_base64 ? Buffer.from(r.file_base64, 'base64') : Buffer.alloc(0) } : {}),
    };
}

export async function saveSheets(fileId, sheets = [], parseError = '') {
    const fileRows = await selectTable('import_source_files', {
        whereSql: `\`id\` = ${sqlVal(fileId)}`,
        limit: 1,
        memFilter: (r) => r.id === fileId,
    });
    if (!fileRows.length) fail('Source file not found', 404);
    const fileRow = fileRows[0];
    const meta = parseJsonCol(fileRow.meta_json, {});
    const now = Date.now();
    const list = Array.isArray(sheets) ? sheets : [];
    for (const sheet of list) {
        const sheetName = String(sheet?.name || 'Sheet1').slice(0, 200);
        const headers = Array.isArray(sheet?.headers) ? sheet.headers.map((h) => String(h ?? '')) : [];
        const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
        const existingSheets = await selectTable('import_source_sheets', {
            whereSql: `\`file_id\` = ${sqlVal(fileId)} AND \`sheet_name\` = ${sqlVal(sheetName)}`,
            limit: 1,
            memFilter: (s) => s.file_id === fileId && s.sheet_name === sheetName,
        });
        const sid = existingSheets[0]?.id || `sheet_${crypto.randomUUID().slice(0, 12)}`;
        await upsertRow('import_source_sheets', {
            id: sid,
            file_id: fileId,
            batch_id: fileRow.batch_id,
            sheet_name: sheetName,
            headers_json: JSON.stringify(headers),
            rows_json: JSON.stringify(rows),
            row_count: rows.length,
            meta_json: JSON.stringify(sheet?.meta || {}),
            updated_at: now,
        }, ['id'], ['headers_json', 'rows_json', 'row_count', 'meta_json', 'updated_at']);
    }
    meta.parse_status = parseError ? 'error' : 'ready';
    meta.parse_error = String(parseError || '').slice(0, 500);
    await updateRows('import_source_files', { meta_json: JSON.stringify(meta) }, {
        whereSql: `\`id\` = ${sqlVal(fileId)}`,
        memFilter: (r) => r.id === fileId,
    });
    return { success: true };
}

export async function getSheet(sheetId) {
    const rows = await selectTable('import_source_sheets', {
        whereSql: `\`id\` = ${sqlVal(sheetId)}`,
        limit: 1,
        memFilter: (s) => s.id === sheetId,
    });
    if (!rows.length) return null;
    const r = rows[0];
    return {
        id: r.id,
        fileId: r.file_id,
        batchId: r.batch_id,
        name: r.sheet_name,
        headers: parseJsonCol(r.headers_json, []),
        rows: parseJsonCol(r.rows_json, []),
        rowCount: Number(r.row_count) || 0,
    };
}

export async function getSheetEditor(sheetId) {
    const table = await getSheet(sheetId);
    if (!table) fail('Worksheet not found', 404);
    const file = await getFile(table.fileId);
    if (!file) fail('Source file not found', 404);
    const revision = crypto.createHash('sha256').update(JSON.stringify([table.headers, table.rows])).digest('hex');
    return {
        table,
        file: { id: file.id, name: file.name },
        editable: true,
        typeKey: file.source_key || file.name,
        rules: [],
        revision,
    };
}

export async function updateSheet(sheetId, input = {}) {
    if (input?.confirmed !== true) fail('Confirm source table changes');
    const state = await getSheetEditor(sheetId);
    if (input.revision && input.revision !== state.revision) fail('Source changed; reopen the preview', 409);
    const headers = Array.isArray(input.headers) ? input.headers.map((h) => String(h ?? '').trim()) : state.table.headers;
    const rows = Array.isArray(input.rows) ? input.rows : state.table.rows;
    if (!headers.length || new Set(headers).size !== headers.length || headers.some((h) => !h)) {
        fail('Headers must be unique and nonempty');
    }
    await updateRows('import_source_sheets', {
        headers_json: JSON.stringify(headers),
        rows_json: JSON.stringify(rows),
        row_count: rows.length,
        updated_at: Date.now(),
    }, {
        whereSql: `\`id\` = ${sqlVal(sheetId)}`,
        memFilter: (s) => s.id === sheetId,
    });
    return getSheetEditor(sheetId);
}

export async function setFileCategory(fileId, category = '') {
    const rows = await selectTable('import_source_files', {
        whereSql: `\`id\` = ${sqlVal(fileId)}`,
        limit: 1,
        memFilter: (r) => r.id === fileId,
    });
    if (!rows.length) fail('Source file not found', 404);
    await updateRows('import_source_files', { category: String(category || '').slice(0, 120) }, {
        whereSql: `\`id\` = ${sqlVal(fileId)}`,
        memFilter: (r) => r.id === fileId,
    });
    const map = (await kvGet(SOURCE_CATEGORIES_KEY, {})) || {};
    map[fileId] = String(category || '');
    await kvSet(SOURCE_CATEGORIES_KEY, map);
    return { fileId, category: String(category || '') };
}

export async function getSheetPresentation(sheetId) {
    const map = (await kvGet(SOURCE_PRESENTATIONS_KEY, {})) || {};
    return map[sheetId] || { columns: [], hidden: [], labels: {} };
}

export async function saveSheetPresentation(sheetId, body = {}) {
    const map = (await kvGet(SOURCE_PRESENTATIONS_KEY, {})) || {};
    map[sheetId] = body && typeof body === 'object' ? body : {};
    await kvSet(SOURCE_PRESENTATIONS_KEY, map);
    return map[sheetId];
}

export async function saveQuickMetrics(sheetId, body = {}) {
    const map = (await kvGet(QUICK_METRICS_KEY, {})) || {};
    map[sheetId] = body;
    await kvSet(QUICK_METRICS_KEY, map);
    return { success: true, sheetId, data: body };
}

export async function getSourceCatalog(options = {}) {
    const days = Number(options.days || 0);
    const cutoffMs = days > 0 ? Date.now() - days * 86_400_000 : 0;

    const [batchRows, fileRows, sheetRows, slaSnaps] = await Promise.all([
        selectTable('import_source_batches', { orderBySql: '`created_at` DESC', limit: 300, memSort: (a, b) => (b.created_at || 0) - (a.created_at || 0) }),
        selectTable('import_source_files', {
            columns: ['id', 'batch_id', 'filename', 'category', 'size_bytes', 'sha256', 'meta_json', 'created_at'],
            orderBySql: '`created_at` DESC',
            limit: 1000,
            memSort: (a, b) => (b.created_at || 0) - (a.created_at || 0),
        }),
        selectTable('import_source_sheets', {
            columns: ['id', 'file_id', 'batch_id', 'sheet_name', 'headers_json', 'row_count', 'updated_at'],
            limit: 2000,
        }),
        (!options.stage || options.stage === 'core') ? listSlaSnapshots({ view: 'full' }).catch(() => []) : Promise.resolve([]),
    ]);

    const catMap = (await kvGet(SOURCE_CATEGORIES_KEY, {})) || {};

    const batches = batchRows
        .filter((b) => !cutoffMs || (b.created_at || 0) >= cutoffMs)
        .map((b) => {
            const meta = parseJsonCol(b.meta_json, {});
            return {
                id: b.id,
                created_at: b.created_at ? new Date(b.created_at).toISOString() : '',
                source: meta.source || b.category || 'manual',
                target_month: meta.target_month || null,
            };
        });

    const files = fileRows
        .filter((f) => !cutoffMs || (f.created_at || 0) >= cutoffMs)
        .map((f) => {
            const meta = parseJsonCol(f.meta_json, {});
            const fSheets = sheetRows.filter((s) => s.file_id === f.id).map((s) => ({
                id: s.id,
                name: s.sheet_name,
                headers: parseJsonCol(s.headers_json, []),
                rowCount: Number(s.row_count) || 0,
            }));
            return {
                id: f.id,
                batch_id: f.batch_id,
                name: normalizeFileName(f.filename),
                source_key: meta.source_key || deriveSourceKey(f.filename),
                source_key_aliases: [meta.source_key || deriveSourceKey(f.filename)],
                kind: meta.kind || 'original',
                size: Number(f.size_bytes) || 0,
                sha256: f.sha256 || '',
                parse_status: meta.parse_status || 'ready',
                parse_error: meta.parse_error || '',
                library_category: catMap[f.id] || f.category || '',
                created_at: f.created_at ? new Date(f.created_at).toISOString() : '',
                metricSourceState: 'original',
                unresolvedMetricCount: 0,
                metricLabels: [],
                sheets: fSheets,
            };
        });

    const snapshots = (slaSnaps || [])
        .filter((s) => !cutoffMs || snapshotTime(s.timestamp) >= cutoffMs)
        .map((s) => ({
            id: s.id,
            batch_id: s.sourceBatchId || null,
            captured_at: s.timestamp || new Date().toISOString(),
            target_month: s.selectedTargetMonth || null,
            target_period: s.target_period || null,
            kind: 'extraction',
            metrics: Array.isArray(s.topMetrics) ? s.topMetrics : [],
            sections: (Array.isArray(s.sourceSections) ? s.sourceSections : []).map((sec) => ({
                key: sec.key,
                title: sec.title,
                sheetName: sec.sheetName,
                fileIds: sec.fileIds || [],
                headers: sec.headers || [],
                rowCount: Array.isArray(sec.rows) ? sec.rows.length : 0,
            })),
        }));

    return {
        diagnostics: { stages: [], errors: [], elapsedMs: 0, days },
        batches,
        files,
        snapshots,
    };
}

export async function getSourceRangeCounts(days = 0, period = '') {
    const cat = await getSourceCatalog({ days });
    const periodFiles = period
        ? cat.files.filter((f) => String(f.created_at || '').startsWith(period))
        : cat.files;
    return {
        days,
        period,
        batches: cat.batches.length,
        files: periodFiles.length,
        snapshots: cat.snapshots.length,
    };
}

export async function searchImportSources(query = {}) {
    const q = String(query.q || query.query || '').trim().toLowerCase();
    if (!q) return { query: '', matches: [], total: 0 };
    const sheets = await selectTable('import_source_sheets', { limit: 200 });
    const matches = [];
    for (const s of sheets) {
        const headers = parseJsonCol(s.headers_json, []);
        const rows = parseJsonCol(s.rows_json, []);
        for (let idx = 0; idx < rows.length; idx += 1) {
            const row = rows[idx];
            const text = JSON.stringify(row).toLowerCase();
            if (text.includes(q)) {
                matches.push({ sheetId: s.id, fileId: s.file_id, sheetName: s.sheet_name, rowIndex: idx, headers, row });
                if (matches.length >= 100) break;
            }
        }
        if (matches.length >= 100) break;
    }
    return { query: q, matches, total: matches.length };
}

export async function getArchivedSnapshot(snapshotId) {
    const list = await listSlaSnapshots({ view: 'full' });
    return list.find((s) => s.id === snapshotId) || null;
}

export async function getSection(snapshotId, key) {
    const snap = await getArchivedSnapshot(snapshotId);
    return snap?.sourceSections?.find((sec) => sec.key === key) || null;
}

export async function getMetricTable(snapshotId, metricKey) {
    const snap = await getArchivedSnapshot(snapshotId);
    if (!snap) return null;
    const metric = (snap.topMetrics || []).find((m) => m.key === metricKey);
    if (!metric) return null;
    const selections = Array.isArray(metric.sourceSelections) ? metric.sourceSelections : [];
    const sections = snap.sourceSections || [];
    const headers = new Set();
    const rows = [];
    for (const sel of selections) {
        const sec = sections.find((s) => s.key === sel.sectionKey);
        if (!sec) continue;
        (sec.headers || []).forEach((h) => headers.add(h));
        for (const i of sel.indexes || []) {
            if (Number.isInteger(i) && sec.rows?.[i]) rows.push(sec.rows[i]);
        }
    }
    return { headers: [...headers], rows, title: metric.label || metricKey, hasSelections: selections.length > 0 };
}

// ============================================================
// Monthly Designer Logos, Presets, Default Template, Documents, Drafts
// ============================================================

export async function listLogos() {
    const rows = await selectTable('monthly_logos', {
        columns: ['id', 'filename', 'mime_type', 'created_at'],
        orderBySql: '`created_at` DESC',
        limit: 100,
        memSort: (a, b) => (b.created_at || 0) - (a.created_at || 0),
    });
    return rows.map((r) => ({ id: r.id, name: r.filename, mime: r.mime_type, created_at: r.created_at ? new Date(r.created_at).toISOString() : '' }));
}

export async function saveLogo(file) {
    const buf = Buffer.isBuffer(file?.buffer) ? file.buffer : null;
    if (!buf || !buf.length) fail('缺少图片文件');
    const id = `logo_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();
    await insertRow('monthly_logos', {
        id,
        filename: String(file.originalname || 'logo.png').slice(0, 200),
        mime_type: String(file.mimetype || 'image/png'),
        image_base64: buf.toString('base64'),
        created_at: now,
    });
    return { id, name: file.originalname || 'logo.png', created_at: new Date(now).toISOString() };
}

export async function getLogo(logoId) {
    const rows = await selectTable('monthly_logos', {
        whereSql: `\`id\` = ${sqlVal(logoId)}`,
        limit: 1,
        memFilter: (r) => r.id === logoId,
    });
    if (!rows.length) return null;
    const r = rows[0];
    return { id: r.id, name: r.filename, mime: r.mime_type, image_blob: Buffer.from(r.image_base64 || '', 'base64') };
}

export async function listPresets(type) {
    const pt = PRESET_TYPE_MAP[type];
    if (!pt) fail('未知预设类型');
    const rows = await selectTable('import_source_presets', {
        whereSql: `\`preset_type\` = ${sqlVal(pt)}`,
        orderBySql: '`updated_at` DESC, `id` ASC',
        limit: 200,
        memFilter: (r) => r.preset_type === pt,
        memSort: (a, b) => (b.updated_at || 0) - (a.updated_at || 0),
    });
    return rows.map((r) => ({
        id: r.id,
        name: r.name,
        rules: parseJsonCol(r.payload_json, {}),
        updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : '',
    }));
}

export async function savePreset(type, input = {}, presetId = '') {
    const pt = PRESET_TYPE_MAP[type];
    if (!pt) fail('未知预设类型');
    const name = String(input?.name || '').trim();
    if (!name) fail('Invalid preset name');
    const id = presetId || `preset_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();
    await upsertRow('import_source_presets', {
        id,
        preset_type: pt,
        name: name.slice(0, 200),
        payload_json: JSON.stringify(input.rules || {}),
        updated_at: now,
    }, ['id'], ['name', 'payload_json', 'updated_at']);
    return { id, name, rules: input.rules || {}, updated_at: new Date(now).toISOString() };
}

export async function deletePreset(type, presetId) {
    const pt = PRESET_TYPE_MAP[type];
    if (!pt) fail('未知预设类型');
    await deleteRows('import_source_presets', {
        whereSql: `\`id\` = ${sqlVal(presetId)} AND \`preset_type\` = ${sqlVal(pt)}`,
        memFilter: (r) => r.id === presetId && r.preset_type === pt,
    });
    return { success: true };
}

export async function getDefaultTemplate() {
    const saved = await kvGet(DEFAULT_TEMPLATE_KEY, null);
    if (saved) return saved;
    return {
        source: 'bundled',
        updatedAt: null,
        canSyncRepository: false,
        template: {
            version: 1,
            document: {
                name: '运营运维质量月报',
                logo: './assets/logo.png',
                logoWidth: 120,
                title: { zh: '运营运维 SLA 月度质量报告', en: 'Monthly Operations Quality Report' },
                subtitle: { zh: '数字人云端运行版', en: 'Cloud Edition' },
                meta: [],
                sections: [],
                footer: { zh: '内部运营资料', en: 'Internal Operations Report' },
            },
        },
    };
}

export async function saveDefaultTemplate(template) {
    const payload = { source: 'tenant', template, updatedAt: new Date().toISOString(), canSyncRepository: false };
    await kvSet(DEFAULT_TEMPLATE_KEY, payload);
    return payload;
}

export async function listMonthlyDocuments() {
    const rows = await selectTable('monthly_documents', {
        columns: ['id', 'title', 'report_month', 'created_at', 'updated_at'],
        orderBySql: '`updated_at` DESC',
        limit: 200,
        memSort: (a, b) => (b.updated_at || 0) - (a.updated_at || 0),
    });
    return rows.map((r) => ({
        id: r.id,
        name: r.title,
        report_month: r.report_month,
        created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
        updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : '',
    }));
}

export async function getMonthlyDocument(docId) {
    const rows = await selectTable('monthly_documents', {
        whereSql: `\`id\` = ${sqlVal(docId)}`,
        limit: 1,
        memFilter: (r) => r.id === docId,
    });
    if (!rows.length) return null;
    const r = rows[0];
    const doc = parseJsonCol(r.payload_json, {});
    return {
        id: r.id,
        name: r.title,
        revision: documentRevision(doc),
        document: doc,
        updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : '',
    };
}

export async function saveMonthlyDocument(document = {}, options = {}) {
    const id = document.id || `mdoc_${crypto.randomUUID().slice(0, 12)}`;
    const existing = await getMonthlyDocument(id);
    if (options.expectedRevision !== undefined && options.expectedRevision !== null && existing && existing.revision !== options.expectedRevision) {
        fail('Monthly report changed since it was opened', 409, 'MONTHLY_SAVE_CONFLICT');
    }
    const now = Date.now();
    const docToSave = { ...document, id };
    await upsertRow('monthly_documents', {
        id,
        title: String(docToSave.name || '月度报告').slice(0, 240),
        report_month: String(docToSave.reportMonth || docToSave.month || ''),
        payload_json: JSON.stringify(docToSave),
        created_at: now,
        updated_at: now,
    }, ['id'], ['title', 'report_month', 'payload_json', 'updated_at']);
    return getMonthlyDocument(id);
}

export async function deleteMonthlyDocuments(ids = []) {
    for (const id of Array.isArray(ids) ? ids : []) {
        await deleteRows('monthly_documents', {
            whereSql: `\`id\` = ${sqlVal(id)}`,
            memFilter: (r) => r.id === id,
        });
    }
    return { success: true, deleted: Array.isArray(ids) ? ids.length : 0 };
}

export async function listDrafts(ownerId = 'default', { archived = false } = {}) {
    const rows = await selectTable('monthly_drafts', {
        whereSql: `\`owner_id\` = ${sqlVal(ownerId)} AND \`archived\` = ${archived ? 1 : 0}`,
        orderBySql: '`updated_at` DESC',
        limit: 200,
        memFilter: (r) => r.owner_id === ownerId && Number(r.archived || 0) === (archived ? 1 : 0),
        memSort: (a, b) => (b.updated_at || 0) - (a.updated_at || 0),
    });
    return rows.map((r) => ({
        id: r.id,
        name: r.title,
        archived: Boolean(r.archived),
        updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : '',
    }));
}

export async function readDraft(ownerId = 'default', draftId) {
    const rows = await selectTable('monthly_drafts', {
        whereSql: `\`id\` = ${sqlVal(draftId)} AND \`owner_id\` = ${sqlVal(ownerId)}`,
        limit: 1,
        memFilter: (r) => r.id === draftId && r.owner_id === ownerId,
    });
    if (!rows.length) fail('Draft not found', 404);
    const r = rows[0];
    const doc = parseJsonCol(r.payload_json, {});
    return {
        id: r.id,
        document: doc,
        version: documentRevision(doc),
        updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : '',
    };
}

export async function saveDraft(ownerId = 'default', draftId, input = {}) {
    const now = Date.now();
    const doc = input?.document || input || {};
    await upsertRow('monthly_drafts', {
        id: String(draftId),
        owner_id: String(ownerId),
        title: String(doc.name || '草稿').slice(0, 240),
        archived: 0,
        payload_json: JSON.stringify(doc),
        created_at: now,
        updated_at: now,
    }, ['id'], ['title', 'archived', 'payload_json', 'updated_at']);
    return { id: draftId, updated_at: new Date(now).toISOString(), version: documentRevision(doc) };
}

export async function removeDraft(ownerId = 'default', draftId) {
    await deleteRows('monthly_drafts', {
        whereSql: `\`id\` = ${sqlVal(draftId)} AND \`owner_id\` = ${sqlVal(ownerId)}`,
        memFilter: (r) => r.id === draftId && r.owner_id === ownerId,
    });
    return { success: true };
}

export async function cleanupDrafts(ownerId = 'default', { mode = 'safe' } = {}) {
    if (mode === 'older') {
        const rows = await selectTable('monthly_drafts', {
            whereSql: `\`owner_id\` = ${sqlVal(ownerId)} AND \`archived\` = 0`,
            orderBySql: '`updated_at` DESC',
            limit: 200,
        });
        let archived = 0;
        for (let i = 1; i < rows.length; i += 1) {
            await updateRows('monthly_drafts', { archived: 1 }, {
                whereSql: `\`id\` = ${sqlVal(rows[i].id)}`,
                memFilter: (r) => r.id === rows[i].id,
            });
            archived += 1;
        }
        return { success: true, removed: 0, archived };
    }
    return { success: true, removed: 0, archived: 0 };
}
