// 纯内存回退存储（仅当 LOCAL_DEV_MEMORY=1 / 未注入 BASE_QUERY_URL 时用于本机离线测试与预览）
// 无任何数据库驱动依赖，严格符合规范 R1。

const TABLES = new Map();
const CACHE = new Map();
const AUTO_INC = new Map();

const KNOWN_TABLES = [
    'sys_kv_store', 'debug_audit_test', 'platform_metrics_events', 'dh_blob_assets',
    'ai_chat_sessions', 'ai_chat_messages', 'ai_settings_profiles',
    'uiv_categories', 'uiv_scripts', 'dh_uiv_import_sessions',
    'sla_config_items', 'sla_categories', 'sla_groups', 'sla_group_items',
    'sla_targets', 'sla_snapshots', 'upload_history',
    'import_source_batches', 'import_source_files', 'import_source_sheets', 'import_source_presets',
    'monthly_logos', 'monthly_documents', 'monthly_drafts',
    'report_snapshots', 'report_category_scores', 'report_metric_data', 'bigscreen_owners',
    'monthly_snapshots', 'ai_report_documents', 'ai_report_images', 'ai_report_image_deletions',
];

for (const t of KNOWN_TABLES) TABLES.set(t, []);

function ensureTable(name) {
    const key = String(name || '').replace(/`/g, '').trim();
    if (!TABLES.has(key)) TABLES.set(key, []);
    return TABLES.get(key);
}

export function resetMemoryStore() {
    for (const key of TABLES.keys()) TABLES.set(key, []);
    CACHE.clear();
    AUTO_INC.clear();
}

export function listMemoryTables() {
    return Array.from(TABLES.keys()).map((name) => ({ name, rows: TABLES.get(name).length }));
}

export function memInsert(table, row, uniqueCols = []) {
    const rows = ensureTable(table);
    const nextRow = { ...row };
    if (uniqueCols.length > 0) {
        const idx = rows.findIndex((existing) => uniqueCols.every((c) => String(existing[c]) === String(nextRow[c])));
        if (idx >= 0) {
            rows[idx] = { ...rows[idx], ...nextRow };
            return 1;
        }
    }
    if (nextRow.id === undefined) {
        const nextId = (AUTO_INC.get(table) || 0) + 1;
        AUTO_INC.set(table, nextId);
        nextRow.id = nextId;
    }
    if (nextRow.seq === undefined) {
        const nextSeq = (AUTO_INC.get(`${table}::seq`) || 0) + 1;
        AUTO_INC.set(`${table}::seq`, nextSeq);
        nextRow.seq = nextSeq;
    }
    rows.push(nextRow);
    return 1;
}

export function memSelect(table, predicate = null, { orderBy = null, limit = 1000 } = {}) {
    let rows = [...ensureTable(table)];
    if (typeof predicate === 'function') rows = rows.filter(predicate);
    if (typeof orderBy === 'function') rows.sort(orderBy);
    return rows.slice(0, limit).map((r) => ({ ...r }));
}

export function memUpdate(table, predicate, patch) {
    const rows = ensureTable(table);
    let affected = 0;
    for (let i = 0; i < rows.length; i += 1) {
        if (predicate(rows[i])) {
            rows[i] = { ...rows[i], ...patch };
            affected += 1;
        }
    }
    return affected;
}

export function memDelete(table, predicate) {
    const rows = ensureTable(table);
    const before = rows.length;
    const kept = rows.filter((r) => !predicate(r));
    TABLES.set(String(table).replace(/`/g, '').trim(), kept);
    return before - kept.length;
}

export function memCacheSet(key, value, ttlSeconds = 3600) {
    const ttl = Math.min(Math.max(Number(ttlSeconds) || 3600, 1), 86400);
    CACHE.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return { key, ttlSeconds: ttl };
}

export function memCacheGet(key) {
    const entry = CACHE.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
        CACHE.delete(key);
        return null;
    }
    return entry.value;
}

export function memCacheDel(key) {
    return CACHE.delete(key) ? 1 : 0;
}

export function memCacheScan(pattern = '*', limit = 100) {
    const now = Date.now();
    const regexStr = '^' + String(pattern || '*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
    const re = new RegExp(regexStr);
    const out = [];
    for (const [k, v] of CACHE.entries()) {
        if (v.expiresAt && v.expiresAt < now) {
            CACHE.delete(k);
            continue;
        }
        if (re.test(k)) out.push(k);
        if (out.length >= limit) break;
    }
    return out;
}
