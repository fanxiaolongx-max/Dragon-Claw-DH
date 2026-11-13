// NetCare 数据探查访问业务库的出入口。主线版要自己连基座的 REST 接口（配置地址、身份头、证书）；
// 基座 Web 版本身就运行在基座上，业务数据源由平台注入（BUSINESS_DATASOURCE_NAME），这里只是把主线版
// 表目录代码用到的那几个调用接到数据访问层上：只读、单条语句、单页最多 1000 行、超出自动翻页。
import { config } from '../../config.js';
import { businessQuery, hasBusinessDatasource } from '../../dao/scoped.js';

export const PAGE_SIZE = 1000;
const MAX_ROWS = 5000;

export function dhError(code, message, extra = {}) {
    return Object.assign(new Error(message), { code, status: extra.statusCode || 424, ...extra });
}

export const netcareConfig = () => ({
    enabled: hasBusinessDatasource(),
    businessSchema: config.businessSchema,
    businessDatasourceName: config.businessDatasourceName,
    maxRows: MAX_ROWS,
    updatedAt: '',
});
const NOT_ENABLED = '平台还没有给本应用授权业务数据源（未注入 BUSINESS_DATASOURCE_NAME），NetCare 数据暂时查不了；请联系平台管理员授权';
function requireEnabled() {
    if (!hasBusinessDatasource()) throw dhError('DH_DISABLED', NOT_ENABLED, { statusCode: 409 });
}
function requireBusiness(scope) {
    if (scope && scope !== 'business') throw dhError('DH_BAD_SCOPE', 'NetCare 数据探查只查业务库；本应用自己的表请用 query_database', { statusCode: 400 });
}

// ── SQL 守卫（与主线版 base-client.js 一致）：去掉字面量和注释后再判断关键字 ──
function skeleton(sql) {
    return String(sql || '')
        .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/`[^`]*`/g, '``')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(--|#)[^\n]*/g, ' ');
}
const READ_START_RE = /^\s*\(?\s*(select|with|show|desc|describe|explain)\b/i;
const WRITE_WORD_RE = /\b(insert|update|delete|replace|merge|create|alter|drop|truncate|rename|grant|revoke|call|lock|unlock|load|handler|set|sleep|benchmark|into\s+outfile|into\s+dumpfile|for\s+update)\b/i;

/** 只读 SQL：单条，SELECT / WITH / SHOW / DESC / EXPLAIN 开头，不含写入关键字 */
export function assertReadOnly(sql) {
    const text = String(sql || '').trim().replace(/;\s*$/, '');
    if (!text) throw dhError('DH_SQL_EMPTY', 'SQL 不能为空', { statusCode: 400 });
    if (text.length > 20_000) throw dhError('DH_SQL_TOO_LONG', 'SQL 过长', { statusCode: 400 });
    const bare = skeleton(text);
    if (bare.includes(';')) throw dhError('DH_SQL_MULTI', '一次只能执行一条 SQL', { statusCode: 400 });
    if (!READ_START_RE.test(bare)) throw dhError('DH_SQL_NOT_READ', '只允许查询语句（SELECT / WITH / SHOW / DESC / EXPLAIN）', { statusCode: 400 });
    const word = WRITE_WORD_RE.exec(bare);
    if (word) throw dhError('DH_SQL_NOT_READ', `查询语句不能包含 ${word[1].toUpperCase()}`, { statusCode: 400 });
    return text;
}

function hasTopLevelLimit(sql) {
    let depth = 0;
    let outer = '';
    for (const char of skeleton(sql)) {
        if (char === '(') depth += 1;
        else if (char === ')') depth = Math.max(0, depth - 1);
        else if (depth === 0) outer += char;
    }
    return /\blimit\s+\d+/i.test(outer);
}

/** 单页查询（≤1000 行） */
export async function queryPage(sql, { scope = 'business', limit = PAGE_SIZE } = {}) {
    requireBusiness(scope);
    requireEnabled();
    const text = assertReadOnly(sql);
    const startedAt = Date.now();
    const rows = await businessQuery(text, Math.min(PAGE_SIZE, Math.max(1, Number(limit) || PAGE_SIZE)));
    return { rows, durationMs: Date.now() - startedAt };
}

/** 自动翻页：SQL 自带顶层 LIMIT 时只取一页；否则追加 LIMIT/OFFSET 直到不足一页或达到 maxRows */
export async function queryAll(sql, { scope = 'business', maxRows } = {}) {
    requireBusiness(scope);
    requireEnabled();
    const text = assertReadOnly(sql);
    const cap = Math.min(MAX_ROWS, Math.max(1, Number(maxRows) || MAX_ROWS));
    const startedAt = Date.now();
    if (hasTopLevelLimit(text) || !/^\s*\(?\s*(select|with)\b/i.test(skeleton(text))) {
        const page = await queryPage(text, { scope });
        return { rows: page.rows.slice(0, cap), truncated: page.rows.length > cap, pages: 1, durationMs: Date.now() - startedAt };
    }
    const rows = [];
    let pages = 0;
    while (rows.length < cap) {
        const size = Math.min(PAGE_SIZE, cap - rows.length);
        const page = await queryPage(`${text} LIMIT ${size} OFFSET ${rows.length}`, { scope, limit: size });
        pages += 1;
        rows.push(...page.rows);
        if (page.rows.length < size) return { rows, truncated: false, pages, durationMs: Date.now() - startedAt };
    }
    return { rows, truncated: true, pages, durationMs: Date.now() - startedAt };
}

export function quote(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? '1' : '0';
    return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

export function ident(name) {
    const text = String(name || '');
    if (!/^[A-Za-z0-9_一-龥$-]{1,128}$/.test(text) || /^\d/.test(text)) throw dhError('DH_BAD_IDENT', `不支持的表名或字段名：${text.slice(0, 80)}`, { statusCode: 400 });
    return `\`${text}\``;
}
