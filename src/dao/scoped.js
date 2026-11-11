// ★ 唯一数据访问入口（合规红线 R5：routes / services 禁止直接引用 dao/base.js）
import { config, endpoints } from '../config.js';
import { BusinessError, DatabaseError } from '../core/errors.js';
import { pushLog } from '../core/log-ring.js';
import {
    queryAppSchema,
    executeAppSchema,
    queryBusiness,
    checkBaseApi,
    rawBaseGet,
    rawBasePost,
    rawBaseDelete,
    requestContext,
} from './base.js';
import {
    memInsert,
    memSelect,
    memUpdate,
    memDelete,
    memCacheSet,
    memCacheGet,
    memCacheDel,
    memCacheScan,
    listMemoryTables,
    resetMemoryStore,
} from './memory-store.js';

export { resetMemoryStore, requestContext };

export function isMemoryMode() {
    return Boolean(config.localDevMemory);
}

export function escapeSql(value) {
    return String(value ?? '')
        .replace(/\0/g, '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
}

export function sqlVal(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
    if (typeof value === 'object') return `'${escapeSql(JSON.stringify(value))}'`;
    return `'${escapeSql(value)}'`;
}

export function parseJsonCol(value, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(String(value));
    } catch {
        return fallback;
    }
}

function ident(name) {
    const clean = String(name || '').trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(clean)) {
        throw new DatabaseError(`非法 SQL 标识符: ${clean}`);
    }
    return `\`${clean}\``;
}

const PAGE = Math.min(Math.max(config.maxPageSize || 1000, 1), 1000); // 基座单页上限
const MAX_ROWS = 50_000;

function warnIfTruncated(rows, limit, sql) {
    if (rows.length >= limit && limit >= 100) {
        pushLog({ level: 'WARN', category: 'DAO', message: `查询返回行数达到 limit=${limit}，结果可能被截断`, detail: { sql: String(sql).replace(/'(?:[^'\\]|\\.)*'/g, '?').slice(0, 160) } });
    }
    return rows;
}

export async function scopedQuery(sql, limit = 500) {
    if (isMemoryMode()) return [];
    const capped = Math.min(Number(limit) || 500, PAGE);
    return warnIfTruncated(await queryAppSchema(sql, capped), capped, sql);
}

export async function scopedExecute(sql) {
    if (isMemoryMode()) return 0;
    return executeAppSchema(sql);
}

export async function scopedCheckHealth() {
    if (isMemoryMode()) return { healthy: true, latencyMs: 0, mode: 'memory' };
    const started = Date.now();
    const healthy = await checkBaseApi();
    return { healthy: Boolean(healthy), latencyMs: Date.now() - started, mode: 'base-api' };
}

export async function selectTable(table, {
    columns = ['*'],
    whereSql = '',
    orderBySql = '',
    limit = 1000,
    memFilter = null,
    memSort = null,
} = {}) {
    if (isMemoryMode()) {
        return memSelect(table, memFilter, { orderBy: memSort, limit });
    }
    const cols = columns.length === 1 && columns[0] === '*' ? '*' : columns.map(ident).join(', ');
    const whereClause = whereSql ? ` WHERE ${whereSql}` : '';
    const orderClause = orderBySql ? ` ORDER BY ${orderBySql}` : '';
    const sql = `SELECT ${cols} FROM ${ident(table)}${whereClause}${orderClause}`;
    const want = Number(limit) || PAGE;
    if (want < PAGE) return queryAppSchema(sql, want);
    // 调用方要“全部”或 ≥ 单页上限：首页拿满就继续翻页，避免超过 1000 行时被静默截断
    const rows = await queryAppSchema(sql, PAGE);
    if (rows.length < PAGE) return rows;
    if (!orderBySql) {
        pushLog({ level: 'WARN', category: 'DAO', message: `${table} 超过 ${PAGE} 行但查询没有 ORDER BY，翻页结果可能重复或遗漏` });
    }
    while (rows.length < Math.min(want > PAGE ? want : MAX_ROWS, MAX_ROWS)) {
        const page = await queryAppSchema(`${sql} LIMIT ${PAGE} OFFSET ${rows.length}`, PAGE);
        rows.push(...page);
        if (page.length < PAGE) break;
    }
    return rows;
}

export async function insertRow(table, row) {
    const keys = Object.keys(row);
    if (!keys.length) return 0;
    if (isMemoryMode()) {
        return memInsert(table, row);
    }
    const colSql = keys.map(ident).join(', ');
    const valSql = keys.map((k) => sqlVal(row[k])).join(', ');
    return executeAppSchema(`INSERT INTO ${ident(table)} (${colSql}) VALUES (${valSql})`);
}

export async function upsertRow(table, row, keyCols = ['id'], updateCols = null) {
    const keys = Object.keys(row);
    if (!keys.length) return 0;
    if (isMemoryMode()) {
        return memInsert(table, row, keyCols);
    }
    const colSql = keys.map(ident).join(', ');
    const valSql = keys.map((k) => sqlVal(row[k])).join(', ');
    const mutableCols = updateCols || keys.filter((k) => !keyCols.includes(k));
    const updates = (mutableCols.length ? mutableCols : [keys[0]])
        .map((k) => `${ident(k)} = ${sqlVal(row[k])}`)
        .join(', ');
    return executeAppSchema(
        `INSERT INTO ${ident(table)} (${colSql}) VALUES (${valSql}) ON DUPLICATE KEY UPDATE ${updates}`,
    );
}

export async function updateRows(table, patch, { whereSql, memFilter }) {
    if (!whereSql || !String(whereSql).trim()) {
        throw new DatabaseError('禁止无 WHERE 条件的 UPDATE');
    }
    const keys = Object.keys(patch);
    if (!keys.length) return 0;
    if (isMemoryMode()) {
        return memUpdate(table, memFilter || (() => false), patch);
    }
    const setSql = keys.map((k) => `${ident(k)} = ${sqlVal(patch[k])}`).join(', ');
    return executeAppSchema(`UPDATE ${ident(table)} SET ${setSql} WHERE ${whereSql}`);
}

export async function deleteRows(table, { whereSql, memFilter }) {
    if (!whereSql || !String(whereSql).trim()) {
        throw new DatabaseError('禁止无 WHERE 条件的 DELETE');
    }
    if (isMemoryMode()) {
        return memDelete(table, memFilter || (() => false));
    }
    return executeAppSchema(`DELETE FROM ${ident(table)} WHERE ${whereSql}`);
}

export async function kvGet(key, fallback = null) {
    const rows = await selectTable('sys_kv_store', {
        whereSql: `\`kv_key\` = ${sqlVal(key)}`,
        limit: 1,
        memFilter: (r) => r.kv_key === key,
    });
    if (!rows.length) return fallback;
    return parseJsonCol(rows[0].kv_value, rows[0].kv_value ?? fallback);
}

export async function kvSet(key, value) {
    const now = Date.now();
    await upsertRow('sys_kv_store', {
        kv_key: String(key),
        kv_value: typeof value === 'string' ? value : JSON.stringify(value),
        updated_at: now,
    }, ['kv_key']);
    return value;
}

// ============================================================
// Redis 缓存封装（自动剥离 app:{UUID}: 前缀）
// ============================================================

function stripCachePrefix(fullKey) {
    const prefix = config.appUuid ? `app:${config.appUuid}:` : '';
    const text = String(fullKey || '');
    if (prefix && text.startsWith(prefix)) return text.slice(prefix.length);
    const m = text.match(/^app:[^:]+:(.+)$/);
    return m ? m[1] : text;
}

export async function cacheSet(key, value, ttlSeconds = 3600) {
    if (isMemoryMode() || !endpoints.cacheExecute) {
        memCacheSet(key, value, ttlSeconds);
        return { code: 0, data: { success: true, mode: 'memory', key } };
    }
    return rawBasePost(endpoints.cacheExecute, {
        datasourceId: config.appCacheDatasourceId,
        key,
        value: typeof value === 'string' ? value : JSON.stringify(value),
        ttlSeconds,
    }, `cache_set:${key}`);
}

export async function cacheGet(key) {
    const cleanKey = stripCachePrefix(key);
    if (isMemoryMode() || !endpoints.cacheQuery) {
        const val = memCacheGet(cleanKey);
        return { code: 0, data: { exists: val !== null, key: cleanKey, value: val, mode: 'memory' } };
    }
    return rawBasePost(`${endpoints.cacheQuery}/key`, {
        datasourceId: config.appCacheDatasourceId,
        key: cleanKey,
    }, `cache_get:${cleanKey}`);
}

export async function cacheScan(pattern = '*', limit = 100) {
    if (isMemoryMode() || !endpoints.cacheQuery) {
        const keys = memCacheScan(pattern, limit);
        return { code: 0, data: { keys, count: keys.length, mode: 'memory' } };
    }
    const res = await rawBasePost(endpoints.cacheQuery, {
        datasourceId: config.appCacheDatasourceId,
        pattern,
        limit,
    }, `cache_scan:${pattern}`);
    if (res?.data && Array.isArray(res.data.keys)) {
        res.data.strippedKeys = res.data.keys.map(stripCachePrefix);
    }
    return res;
}

export async function cacheDelete(key) {
    const cleanKey = stripCachePrefix(key);
    if (isMemoryMode() || !endpoints.cacheExecute) {
        memCacheDel(cleanKey);
        return { code: 0, data: { deleted: true, key: cleanKey, mode: 'memory' } };
    }
    return rawBaseDelete(`${endpoints.cacheExecute}/key`, {
        datasourceId: config.appCacheDatasourceId,
        key: cleanKey,
    }, `cache_del:${cleanKey}`);
}

// ============================================================
// 消息通知 & 基座联调探针 (Debug Console 与 催办通知)
// ============================================================

export async function sendBaseNotify(payload) {
    if (isMemoryMode() || !endpoints.notify) {
        return {
            code: 0,
            message: 'ok (local memory simulation)',
            data: { success: true, mode: 'memory', payload },
        };
    }
    const r = await rawBasePost(endpoints.notify, payload, 'notify_send', 30_000);
    return r;
}

export async function debugProbeAction(action, params = {}) {
    if (isMemoryMode() && !config.baseQueryUrl) {
        switch (action) {
        case 'db-tables':
            return { mode: 'memory', tables: listMemoryTables() };
        case 'query-self': {
            const rows = await selectTable('debug_audit_test', { limit: 20 });
            return { mode: 'memory', action, rows, rowCount: rows.length };
        }
        case 'write-self': {
            const affectedRows = await insertRow('debug_audit_test', {
                user_id: String(params.userId || 'local'),
                msg: String(params.msg || `调试写入测试 ${new Date().toISOString()}`),
                created_at: new Date().toISOString(),
            });
            return { mode: 'memory', action, affectedRows, success: true };
        }
        case 'query-base':
            return { mode: 'memory', action, simulated: true, message: '离线内存模式：未连接真实 netcare_base' };
        case 'write-base':
            return { mode: 'memory', action, code: 409, message: '预期拒绝：写 netcare_base 仅允许基础应用携带自身 x-app-id 执行' };
        case 'query-netcare':
            return { mode: 'memory', action, code: 400, message: '预期拒绝：基座库 [netcare] 仅允许基础应用查询' };
        case 'write-netcare':
            return { mode: 'memory', action, code: 409, message: '预期拒绝：基座 schema [netcare] 不允许任何应用写操作' };
        case 'cache-set':
            return cacheSet(params.key || 'debug_probe_key', params.value || `probe_${Date.now()}`, Number(params.ttl) || 300);
        case 'cache-get':
            return cacheGet(params.key || 'debug_probe_key');
        case 'cache-scan':
            return cacheScan(params.pattern || '*', Number(params.limit) || 50);
        case 'cache-delete':
            return cacheDelete(params.key || 'debug_probe_key');
        case 'rep-offices':
        case 'app-menus':
        case 'datasources':
        case 'row-limit':
        case 'sql-size':
            return { mode: 'memory', action, simulated: true, message: '离线内存模式：该探针只在连接真实基座时有意义', items: [] };
        default:
            throw new BusinessError(`未知调试动作: ${action}`);
        }
    }

    // 在线真实基座联调
    switch (action) {
    case 'query-self':
        return rawBasePost(endpoints.query, {
            datasourceId: config.appDatasourceId,
            schema: config.appSchema,
            sql: 'SELECT * FROM debug_audit_test ORDER BY id DESC LIMIT 10',
            limit: 10,
        }, 'debug:query_self');
    case 'write-self':
        return rawBasePost(endpoints.execute, {
            datasourceId: config.appDatasourceId,
            schema: config.appSchema,
            sql: `INSERT INTO \`debug_audit_test\` (\`user_id\`, \`msg\`) VALUES (${sqlVal(params.userId || 'debug')}, ${sqlVal(params.msg || `调试自检 ${new Date().toISOString()}`)})`,
        }, 'debug:write_self');
    case 'db-tables': {
        const rows = await queryAppSchema(
            `SELECT TABLE_NAME, TABLE_ROWS, CREATE_TIME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${sqlVal(config.appSchema)} ORDER BY TABLE_NAME`,
            200,
        );
        return { schema: config.appSchema, tables: rows, count: rows.length };
    }
    case 'query-base':
        return rawBasePost(endpoints.query, {
            datasourceId: config.appDatasourceId,
            schema: 'netcare_base',
            sql: 'SELECT * FROM demo_base_test ORDER BY id DESC LIMIT 10',
            limit: 10,
        }, 'debug:query_base');
    case 'write-base':
        return rawBasePost(endpoints.execute, {
            datasourceId: config.appDatasourceId,
            schema: 'netcare_base',
            sql: "INSERT INTO demo_test (msg) VALUES ('越权写netcare_base测试')",
        }, 'debug:write_base');
    case 'query-netcare':
        return rawBasePost(endpoints.query, {
            datasourceId: config.appDatasourceId,
            schema: 'netcare',
            sql: 'SELECT 1 AS test_col',
            limit: 1,
        }, 'debug:query_netcare');
    case 'write-netcare':
        return rawBasePost(endpoints.execute, {
            datasourceId: config.appDatasourceId,
            schema: 'netcare',
            sql: "INSERT INTO demo_test (msg) VALUES ('越权写netcare测试')",
        }, 'debug:write_netcare');
    case 'row-limit': {
        // 基座省略 limit 时返回多少行、单页上限是多少：决定报表类查询是否会被静默截断
        const base = { datasourceId: config.appDatasourceId, schema: config.appSchema, sql: 'SELECT COLUMN_NAME FROM information_schema.COLUMNS' };
        const out = {};
        for (const [label, limit] of [['省略 limit', undefined], ['limit=1000', 1000], ['limit=5000', 5000]]) {
            try {
                const r = await rawBasePost(endpoints.query, limit ? { ...base, limit } : base, `debug:row_limit:${limit || 'default'}`);
                out[label] = r.code === 0 ? { 返回行数: r.data?.rows?.length ?? r.data?.rowCount ?? null } : { code: r.code, message: r.message };
            } catch (error) {
                out[label] = { error: error.message };
            }
        }
        return { action, 说明: '本应用按单页 1000 行自动翻页；若“limit=5000”返回超过 1000 行，可把 MAX_PAGE_SIZE 调大', 结果: out };
    }
    case 'sql-size': {
        // 单条 SQL 请求体上限：决定快照 / 月报 / 图片这类大字段能否一次写入
        const key = 'dh_probe_blob';
        const steps = [];
        try {
            for (const kb of [64, 512, 1024, 4096, 8192]) {
                const started = Date.now();
                try {
                    await kvSet(key, 'x'.repeat(kb * 1024));
                    steps.push({ 大小: `${kb}KB`, 写入: '成功', 耗时ms: Date.now() - started });
                } catch (error) {
                    steps.push({ 大小: `${kb}KB`, 写入: '失败', 原因: error.message.slice(0, 200), 耗时ms: Date.now() - started });
                    break;
                }
            }
        } finally {
            await deleteRows('sys_kv_store', { whereSql: `\`kv_key\` = ${sqlVal(key)}`, memFilter: (r) => r.kv_key === key }).catch(() => {});
        }
        const okSteps = steps.filter((s) => s.写入 === '成功');
        return { action, 最大成功写入: okSteps.length ? okSteps[okSteps.length - 1].大小 : '无', 明细: steps };
    }
    case 'datasources':
        return rawBaseGet(endpoints.datasources, 'debug:datasources');
    case 'rep-offices':
        return rawBaseGet(endpoints.repOffices, 'debug:rep_offices');
    case 'app-menus':
        return rawBaseGet(endpoints.appMenus, 'debug:app_menus');
    case 'query-business':
        return { rows: await queryBusiness(String(params.sql || 'SELECT 1 AS ok'), Number(params.limit) || 10) };
    case 'cache-set':
        return cacheSet(params.key || 'debug_probe_key', params.value || `probe_${Date.now()}`, Number(params.ttl) || 300);
    case 'cache-get':
        return cacheGet(params.key || 'debug_probe_key');
    case 'cache-scan':
        return cacheScan(params.pattern || '*', Number(params.limit) || 50);
    case 'cache-delete':
        return cacheDelete(params.key || 'debug_probe_key');
    default:
        throw new BusinessError(`未知调试动作: ${action}`);
    }
}
