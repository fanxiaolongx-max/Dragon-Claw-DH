// 表字典与派生表（数据探索 → 数据治理）。
//
// 表字典：管理员导入的表字典（Excel / CSV / JSON，表头自动识别）覆盖在业务库实时目录之上，给每张表定中文名、英文名、
// 分类 / 子分类 / 分层、说明和字段中英文映射。没有导入的表退回 NetCare 目录里的种子名称、管理员标注和库里的注释。
//
// 派生表：用一条只读 SELECT 从业务表算出一张“新表”。业务库只读，结果物化存在应用库（biz_records，单表最多 5000 行）。
// 联动刷新：
//   1) 每轮行数巡检结束，源表行数有变化的派生表立即重算；
//   2) 每隔几分钟做一次轻量“指纹”检查（information_schema 的行数估计 / 更新时间 / 数据量 + 源表精确行数），指纹变了就重算；
//   3) 也可设为按固定间隔重算，或只手动。
// 存储：dw_dict（每表一条字典）、dw_derived（派生表定义）、dw_derived_data（派生表结果）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { hasBusinessDatasource, kvGet, kvSet } from '../dao/scoped.js';
import { listRecords, getRecord, putRecord, deleteRecord } from './record-store.js';
import * as client from './netcare/base-adapter.js';
import * as catalog from './netcare/table-catalog.js';
import * as watch from './data-watch-service.js';
import { datafabToMysql, splitBoardSql } from './sql-dialect.js';
import { pushLog } from '../core/log-ring.js';

const DICT_KIND = 'dw_dict';
const DERIVED_KIND = 'dw_derived';
const DATA_KIND = 'dw_derived_data';
const MAX_DERIVED_ROWS = 5000;
const MAX_SOURCES = 30;

const hash = (text) => crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const pick = (row, key) => {
    if (!row) return undefined;
    if (key in row) return row[key];
    const found = Object.keys(row).find((name) => name.toLowerCase() === key.toLowerCase());
    return found ? row[found] : undefined;
};
/** 表键就是业务库里的表名（业务库只有一个）。字典或 SQL 里写了 库名.表名 / "库"."模式"."表" 时只取最后的表名 */
export function normalizeKey(name) {
    const text = String(name || '').trim().replace(/[`"]/g, '');
    if (!text) return '';
    return text.split('.').pop();
}

// ── 表字典解析 ──
const HEADER_ALIASES = {
    table: ['表名', '表英文名', '英文表名', '物理表名', '表物理名', 'table', 'tablename', 'table_name', '数据表', '表'],
    nameCn: ['中文名', '表中文名', '中文表名', '表名称', '表中文名称', '中文名称', '业务名称', 'namecn', 'name_cn', 'cnname', 'cn_name', 'chinesename'],
    nameEn: ['英文名', '英文名称', '表英文名称', '英文描述', 'nameen', 'name_en', 'enname', 'en_name', 'englishname'],
    category: ['分类', '类别', '一级分类', '主题域', '业务域', '数据域', '看板', '所属看板', 'category', 'domain'],
    upstream: ['源表', '上游表', '来源表', '数据来源', 'upstream', 'source_tables'],
    subCategory: ['子分类', '二级分类', '子类', '子主题', 'subcategory', 'sub_category'],
    layer: ['层级', '分层', '数据分层', '数仓分层', 'layer'],
    module: ['模块', '所属模块', '系统', '来源系统', 'module', 'system'],
    description: ['说明', '描述', '备注', '用途', '表说明', '表描述', 'description', 'comment', 'remark'],
    owner: ['负责人', '责任人', 'owner'],
    column: ['字段名', '字段', '列名', '字段英文名', '英文字段名', 'column', 'column_name', 'columnname', 'field'],
    columnCn: ['字段中文名', '字段说明', '列中文名', '字段含义', '字段描述', '中文字段名', 'column_cn', 'columncn', 'field_cn'],
    columnType: ['字段类型', '数据类型', 'data_type', 'datatype', 'column_type'],
};
const normHeader = (text) => String(text ?? '').toLowerCase().replace(/[\s()（）:：*#\-_/]/g, '');
const ALIAS_INDEX = new Map(Object.entries(HEADER_ALIASES).flatMap(([field, names]) => names.map((n) => [normHeader(n), field])));

/** 给一行表头找字段；至少认出“表名”才算表头 */
export function mapHeaders(cells) {
    const map = {};
    cells.forEach((cell, index) => {
        const field = ALIAS_INDEX.get(normHeader(cell));
        if (field && map[field] === undefined) map[field] = index;
    });
    return map.table === undefined && map.nameCn === undefined ? null : map;
}

// 字典按表名不区分大小写对上库里的表（DataFab 里写 Rectification_Overdue，库里是 rectification_overdue）
const dictId = (key) => hash(String(key).toLowerCase());
const isIdent = (v) => /^[A-Za-z_][A-Za-z0-9_$.`-]*$/.test(String(v || '').trim());

/** 二维表（含表头）→ 字典条目。字段级行（有“字段名”）汇总到所属表下 */
export function rowsToEntries(grid) {
    const headerAt = grid.slice(0, 15).findIndex((row) => mapHeaders(row || []));
    if (headerAt < 0) return [];
    let map = mapHeaders(grid[headerAt]);
    const body = grid.slice(headerAt + 1).filter((row) => row && row.some((c) => String(c ?? '').trim()));
    // “表名”一列里装的其实是中文名、而另有英文列：互换
    const filledTable = map.table === undefined ? [] : body.filter((r) => String(r[map.table] ?? '').trim());
    if (filledTable.length) {
        // 只看填了值的单元格：字段级字典“表名只写第一行”时空格很多，不能算进去
        const ascii = filledTable.filter((r) => isIdent(r[map.table])).length / filledTable.length;
        if (ascii < 0.5 && map.nameEn !== undefined) map = { ...map, nameCn: map.table, table: map.nameEn, nameEn: undefined };
        else if (ascii < 0.5 && map.nameCn === undefined) map = { ...map, nameCn: map.table, table: undefined };
    }
    if (map.table === undefined) return [];
    const get = (row, field) => (map[field] === undefined ? '' : clip(row[map[field]], 2000));
    // 「看板」列常只在每组第一行写：同组后面的表沿用上一行的看板
    const carryCategory = map.category !== undefined && /看板/.test(String(grid[headerAt][map.category] || ''));
    let lastCategory = '';
    const tables = new Map();
    let current = null;
    for (let row of body) {
        const tableCell = get(row, 'table');
        // 字段级字典常见“表名只写第一行、下面留空”：沿用上一张表
        const key = tableCell ? normalizeKey(tableCell) : current;
        if (!key || !isIdent(key)) continue;
        current = key;
        const entry = tables.get(key) || { key, columns: [] };
        if (carryCategory) { const c = get(row, 'category'); if (c) lastCategory = c; else if (lastCategory && tableCell) row = Object.assign([...row], { [map.category]: lastCategory }); }
        for (const field of ['nameCn', 'nameEn', 'category', 'subCategory', 'layer', 'module', 'description', 'owner', 'upstream']) {
            const value = get(row, field);
            if (value && !(field === 'description' && map.column !== undefined && get(row, 'column'))) entry[field] = entry[field] || value;
        }
        const column = get(row, 'column');
        if (column) {
            entry.columns.push({ name: column, nameCn: get(row, 'columnCn'), type: get(row, 'columnType'), description: map.column !== undefined ? get(row, 'description') : '' });
        }
        tables.set(key, entry);
    }
    return [...tables.values()];
}

function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    const src = String(text || '').replace(/^﻿/, '');
    const sep = (src.split('\n')[0].match(/\t/g) || []).length > (src.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
    for (let i = 0; i < src.length; i += 1) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && src[i + 1] === '\n') i += 1;
            row.push(cell); rows.push(row); row = []; cell = '';
        } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
}

async function parseXlsx(buffer) {
    let ExcelJS;
    try { ExcelJS = (await import('exceljs')).default; } catch { throw client.dhError('DW_NO_EXCEL', '当前安装包不含 Excel 解析组件，请把表字典另存为 CSV 后导入', { statusCode: 400 }); }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const entries = [];
    wb.eachSheet((sheet) => {
        const grid = [];
        sheet.eachRow({ includeEmpty: false }, (row) => {
            const values = [];
            row.eachCell({ includeEmpty: true }, (cell, col) => {
                const v = cell.value;
                values[col - 1] = v && typeof v === 'object' ? (v.text ?? v.result ?? (Array.isArray(v.richText) ? v.richText.map((t) => t.text).join('') : '')) : v;
            });
            grid.push(values);
        });
        entries.push(...rowsToEntries(grid));
    });
    return entries;
}

function fromJson(data) {
    const list = Array.isArray(data) ? data : Array.isArray(data?.tables) ? data.tables : [];
    return list.map((t) => ({
        key: normalizeKey(t.key || t.table || t.tableName || t.name),
        nameCn: clip(t.nameCn || t.cnName || t['中文名'], 200), nameEn: clip(t.nameEn || t.enName || t['英文名'], 200),
        category: clip(t.category || t['分类'], 100), subCategory: clip(t.subCategory || t['子分类'], 100), layer: clip(t.layer || t['分层'], 50),
        module: clip(t.module || t['模块'], 100), description: clip(t.description || t['说明'], 2000), owner: clip(t.owner, 100),
        columns: (Array.isArray(t.columns) ? t.columns : []).map((c) => ({ name: clip(c.name || c.column, 128), nameCn: clip(c.nameCn || c.cnName || c['中文名'], 200), type: clip(c.type, 60), description: clip(c.description, 500) })).filter((c) => c.name),
    })).filter((t) => t.key && isIdent(t.key));
}

/** 解析上传的字典文件 → 条目列表（不写库） */
export async function parseDictionary({ filename = '', contentBase64 = '', text = '', items = null } = {}) {
    if (Array.isArray(items)) return fromJson(items);
    const name = String(filename || '').toLowerCase();
    const buffer = contentBase64 ? Buffer.from(String(contentBase64), 'base64') : Buffer.from(String(text || ''), 'utf8');
    if (!buffer.length) throw client.dhError('DW_EMPTY', '文件是空的', { statusCode: 400 });
    if (buffer.length > 20 * 1024 * 1024) throw client.dhError('DW_TOO_BIG', '字典文件超过 20MB', { statusCode: 400 });
    if (/\.xlsx$/.test(name) || buffer.subarray(0, 2).toString() === 'PK') return parseXlsx(buffer);
    const textValue = buffer.toString('utf8');
    if (/\.json$/.test(name) || /^\s*[[{]/.test(textValue)) {
        try { return fromJson(JSON.parse(textValue)); } catch { throw client.dhError('DW_BAD_JSON', 'JSON 解析失败', { statusCode: 400 }); }
    }
    return rowsToEntries(parseCsv(textValue));
}

export async function importDictionary(input = {}, { actor = '', mode = 'merge' } = {}) {
    const entries = await parseDictionary(input);
    if (!entries.length) throw client.dhError('DW_NO_ENTRIES', '没有认出表字典内容：表头至少要有「表名」（或 table / table_name），可选 中文名、英文名、分类、子分类、分层、说明、字段名、字段中文名', { statusCode: 400 });
    const existing = new Map((await listRecords(DICT_KIND, { withPayload: true, limit: 5000, maxRows: 5000 })).map((r) => [String(r.payload?.key || '').toLowerCase(), r.payload]));
    if (mode === 'replace') {
        const keep = new Set(entries.map((e) => e.key.toLowerCase()));
        for (const key of existing.keys()) if (!keep.has(key)) await deleteRecord(DICT_KIND, dictId(key));
    }
    let created = 0, updated = 0, columns = 0;
    const importedAt = new Date().toISOString();
    for (const entry of entries) {
        const prev = mode === 'merge' ? existing.get(entry.key.toLowerCase()) : null;
        const merged = { ...(prev || {}), ...Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== '' && v !== undefined)) };
        if (prev && !entry.columns.length) merged.columns = prev.columns || [];
        merged.table = entry.key;
        merged.source = clip(input.filename || 'manual', 200);
        merged.importedAt = importedAt;
        merged.updatedBy = actor;
        columns += merged.columns.length;
        await putRecord(DICT_KIND, { id: dictId(entry.key), name: entry.key, sortKey: entry.key, summary: { nameCn: merged.nameCn || '', category: merged.category || '', columns: merged.columns.length }, payload: merged, updatedBy: actor });
        if (prev) updated += 1; else created += 1;
    }
    return { tables: entries.length, created, updated, columns, mode };
}

export async function saveDictionaryEntry(key, patch = {}, actor = '') {
    const k = normalizeKey(key);
    if (!isIdent(k)) throw client.dhError('DW_BAD_KEY', '表名无效', { statusCode: 400 });
    const prev = (await getRecord(DICT_KIND, dictId(k)))?.payload || { key: k, columns: [] };
    const next = { ...prev, key: k, table: k };
    for (const field of ['nameCn', 'nameEn', 'category', 'subCategory', 'layer', 'module', 'description', 'owner', 'upstream']) if (patch[field] !== undefined) next[field] = clip(patch[field], field === 'description' || field === 'upstream' ? 2000 : 200);
    if (Array.isArray(patch.columns)) next.columns = patch.columns.map((c) => ({ name: clip(c.name, 128), nameCn: clip(c.nameCn, 200), type: clip(c.type, 60), description: clip(c.description, 500) })).filter((c) => c.name);
    next.updatedBy = actor; next.updatedAt = new Date().toISOString();
    await putRecord(DICT_KIND, { id: dictId(k), name: k, sortKey: k, summary: { nameCn: next.nameCn || '', category: next.category || '', columns: next.columns.length }, payload: next, updatedBy: actor });
    return next;
}

export async function dictionaryMap() {
    const recs = await listRecords(DICT_KIND, { withPayload: true, limit: 5000, maxRows: 5000 });
    return new Map(recs.map((r) => [String(r.payload?.key || '').toLowerCase(), r.payload]).filter(([k]) => k));
}

/** 字典导出成 CSV（字段级，一行一个字段；没字段的表一行），也当导入模板用 */
export async function exportDictionaryCsv() {
    const view = await catalogView();
    const dict = await dictionaryMap();
    const esc = (v) => { const t = String(v ?? ''); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const lines = [['表名', '中文名', '英文名', '分类', '子分类', '分层', '说明', '字段名', '字段中文名', '字段类型'].join(',')];
    for (const t of view.tables) {
        const cols = dict.get(t.key.toLowerCase())?.columns || [];
        const head = [t.key, t.nameCn, t.nameEn, t.category, t.subCategory, t.layer, t.description];
        if (!cols.length) lines.push([...head, '', '', ''].map(esc).join(','));
        cols.forEach((c, i) => lines.push([...(i ? [t.key, '', '', '', '', '', ''] : head), c.name, c.nameCn, c.type].map(esc).join(',')));
    }
    return `﻿${lines.join('\r\n')}`;
}

// ── 派生表 ──
/** SQL 里 FROM / JOIN 后面引用的表（按原样写法，CTE 名除外） */
export function parseRefs(sql) {
    const bare = String(sql || '').replace(/'(?:[^'\\]|\\.)*'/g, "''");
    const ctes = new Set([...bare.matchAll(/(?:\bWITH\b(?:\s+RECURSIVE)?|,)\s*`?(\w+)`?\s+AS\s*\(/gi)].map((m) => m[1].toLowerCase()));
    const refs = [...bare.matchAll(/\b(?:FROM|JOIN)\s+((?:`?[\w$]+`?\.)?`?[\w$]+`?)/gi)].map((m) => m[1].replace(/`/g, ''));
    return [...new Set(refs.filter((r) => !ctes.has(r.toLowerCase()) && !/^(select|dual|lateral)$/i.test(r)))];
}

/** 引用的业务表（库.表）：不区分是否派生表时用 */
export function parseSources(sql) {
    return [...new Set(parseRefs(sql).map(normalizeKey))].slice(0, MAX_SOURCES);
}

/**
 * 派生表可以引用别的派生表（“新表 → 看板指标”两层）。业务库只读、应用库不允许运行时建表，所以不落真表：
 * 执行时把被引用的派生表展开成同名 CTE（WITH 新表 AS (新表的 SQL) 看板 SQL），整条在业务库上只读执行，结果再存应用库。
 * resolve 给每张派生表算出：dependsOn（直接引用的派生表）、sources（最终依赖的业务表，用于联动）、compiledSql、cycle。
 */
export function resolveDefs(defs) {
    const byLower = new Map(defs.map((d) => [d.name.toLowerCase(), d]));
    const memo = new Map();
    const visit = (def, stack) => {
        if (memo.has(def.id)) return memo.get(def.id);
        if (stack.includes(def.id)) return { cycle: [...stack, def.id].map((id) => defs.find((d) => d.id === id)?.name || id).join(' → ') };
        const refs = parseRefs(def.sql);
        const deps = [], business = new Set(), spellings = new Map();
        for (const ref of refs) {
            const bare = ref.includes('.') ? '' : ref;
            const dep = bare && byLower.get(bare.toLowerCase());
            if (dep && dep.id !== def.id) {
                if (!deps.includes(dep)) deps.push(dep);
                spellings.set(dep.id, [...new Set([...(spellings.get(dep.id) || []), bare])]);
            } else business.add(normalizeKey(ref));
        }
        let cycle = '';
        const ctes = [];
        for (const dep of deps) {
            const r = visit(dep, [...stack, def.id]);
            if (r.cycle) { cycle = r.cycle; break; }
            r.sources.forEach((k) => business.add(k));
            for (const spelling of spellings.get(dep.id)) ctes.push(`\`${spelling}\` AS (${r.compiledSql})`);
        }
        const body = String(def.sql).trim();
        let compiledSql = body;
        if (ctes.length) {
            const lead = /^\s*WITH\s+(RECURSIVE\s+)?/i.exec(body);
            compiledSql = lead ? `WITH ${lead[1] || ''}${ctes.join(', ')}, ${body.slice(lead[0].length)}` : `WITH ${ctes.join(', ')} ${body}`;
        }
        const out = cycle ? { cycle } : { dependsOn: deps.map((d) => d.name), sources: [...business].slice(0, MAX_SOURCES), compiledSql };
        memo.set(def.id, out);
        return out;
    };
    return new Map(defs.map((d) => [d.id, visit(d, [])]));
}

const withResolution = (rawDefs) => {
    // DataFab 写法的派生表每次都从原文按最新的改写规则重新改写：改写器修了问题，已导入的不用重新导入
    const defs = rawDefs.map((d) => {
        if (d.dialect !== 'datafab' || !d.sourceSql) return d;
        try { const c = datafabToMysql(d.sourceSql); return { ...d, sql: c.sql, dialectNotes: c.notes }; } catch { return d; }
    });
    const resolved = resolveDefs(defs);
    return defs.map((d) => {
        const r = resolved.get(d.id) || {};
        return r.cycle ? { ...d, cycle: r.cycle, dependsOn: [], sources: d.sources || [] } : { ...d, cycle: '', dependsOn: r.dependsOn, sources: r.sources, compiledSql: r.compiledSql };
    });
};

const REFRESH_MODES = new Set(['linked', 'interval', 'manual']);
function normalizeDef(input = {}, prev = null) {
    const name = clip(input.name ?? prev?.name, 64);
    if (!/^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(name)) throw client.dhError('DW_BAD_NAME', '英文表名只能用字母、数字、下划线，字母开头，2~64 个字符', { statusCode: 400 });
    const nameCn = clip(input.nameCn ?? prev?.nameCn, 100);
    if (!nameCn) throw client.dhError('DW_NO_CN', '请填写中文名', { statusCode: 400 });
    // 写法：mysql 原样执行；datafab 存原文、执行改写后的 MySQL（看板 SQL 多从 DataFab 抄来）
    const dialect = (input.dialect ?? prev?.dialect) === 'datafab' ? 'datafab' : 'mysql';
    const sourceSql = String(input.sourceSql ?? input.sql ?? prev?.sourceSql ?? prev?.sql ?? '').trim();
    const converted = dialect === 'datafab' ? datafabToMysql(sourceSql) : { sql: sourceSql, notes: [] };
    const sql = client.assertReadOnly(converted.sql);
    if (!/^\s*\(?\s*(select|with)\b/i.test(sql)) throw client.dhError('DW_BAD_SQL', '派生表只能用 SELECT / WITH 计算', { statusCode: 400 });
    const sources = parseSources(sql);
    if (!sources.length) throw client.dhError('DW_NO_SOURCE', 'SQL 里没有找到引用的表', { statusCode: 400 });
    const refresh = REFRESH_MODES.has(input.refresh) ? input.refresh : prev?.refresh || 'linked';
    return {
        id: prev?.id || `dv_${name.toLowerCase()}`,
        name, nameCn,
        category: clip(input.category ?? prev?.category, 100),
        description: clip(input.description ?? prev?.description, 2000),
        sql, sourceSql: dialect === 'datafab' ? sourceSql : '', dialect, dialectNotes: converted.notes, sources, refresh,
        intervalMinutes: Math.round(Math.min(10080, Math.max(5, Number(input.intervalMinutes ?? prev?.intervalMinutes) || 60))),
        maxRows: Math.round(Math.min(MAX_DERIVED_ROWS, Math.max(1, Number(input.maxRows ?? prev?.maxRows) || MAX_DERIVED_ROWS))),
        enabled: (input.enabled ?? prev?.enabled) !== false,
        columns: Array.isArray(input.columns) ? input.columns.map((c) => ({ name: clip(c.name, 128), nameCn: clip(c.nameCn, 200) })).filter((c) => c.name) : prev?.columns || [],
    };
}

async function storedDefs() {
    const recs = await listRecords(DERIVED_KIND, { withPayload: true, limit: 500, maxRows: 500 });
    return recs.map((r) => r.payload).filter(Boolean);
}

/** 所有派生表（已解析依赖：dependsOn / sources / compiledSql） */
export async function listDerived() {
    return withResolution(await storedDefs()).sort((a, b) => String(a.category).localeCompare(String(b.category)) || a.name.localeCompare(b.name));
}

export async function getDerived(id) {
    return (await listDerived()).find((d) => d.id === id) || null;
}

async function putDerived(def, actor) {
    const { compiledSql, cycle, ...stored } = def;
    await putRecord(DERIVED_KIND, { id: def.id, name: def.name, sortKey: def.name, summary: { nameCn: def.nameCn, status: def.status || '', rowCount: def.rowCount ?? null }, payload: stored, updatedBy: actor || 'system' });
    return def;
}

/** 把待保存 / 试算的定义放进全部定义里一起解析，检查循环引用、算出展开后的 SQL */
async function resolveCandidate(def) {
    const all = (await storedDefs()).filter((d) => d.id !== def.id);
    if (all.some((d) => d.name.toLowerCase() === def.name.toLowerCase())) throw client.dhError('DW_EXISTS', `已有同名派生表 ${def.name}`, { statusCode: 409 });
    const resolved = withResolution([def, ...all]).find((d) => d.id === def.id);
    if (resolved.cycle) throw client.dhError('DW_CYCLE', `派生表之间循环引用：${resolved.cycle}`, { statusCode: 400 });
    if (!resolved.sources.length) throw client.dhError('DW_NO_SOURCE', 'SQL 里没有找到引用的业务表', { statusCode: 400 });
    return resolved;
}

/** 试算：不保存，返回前 20 行和识别到的源表 */
export async function previewDerived(input = {}) {
    // 编辑已有派生表时按它自己的身份试算（排除自身、允许引用别的派生表）；新建时用临时名
    const base = normalizeDef({ name: input.id ? input.name : 'preview_only_tmp', nameCn: '试算', refresh: 'manual', sql: input.sql, dialect: input.dialect });
    const def = await resolveCandidate({ ...base, id: input.id || 'dv__preview' });
    const started = Date.now();
    const { rows } = await client.queryPage(`SELECT * FROM (${def.compiledSql}) AS dv_preview LIMIT 20`, { limit: 20 });
    return { sql: def.sql, dialectNotes: def.dialectNotes, sources: def.sources, dependsOn: def.dependsOn, rows, columns: rows.length ? Object.keys(rows[0]) : [], durationMs: Date.now() - started };
}

export async function saveDerived(input = {}, actor = '', { refreshNow = true } = {}) {
    const prev = input.id ? await getDerived(input.id) : null;
    if (input.id && !prev) throw client.dhError('DW_NOT_FOUND', '派生表不存在', { statusCode: 404 });
    const def = await resolveCandidate(normalizeDef(input, prev));
    const sqlChanged = !prev || prev.sql !== def.sql;
    const next = { ...(prev || {}), ...def, createdAt: prev?.createdAt || new Date().toISOString(), createdBy: prev?.createdBy || actor, updatedAt: new Date().toISOString(), updatedBy: actor, ...(sqlChanged ? { sourceFingerprints: {} } : {}) };
    await putDerived(next, actor);
    if (refreshNow && sqlChanged && next.enabled) refreshDerived(next.id, { reason: prev ? 'SQL 已修改' : '新建' }).catch(() => {});
    return next;
}

export async function deleteDerived(id) {
    await deleteRecord(DATA_KIND, id);
    return deleteRecord(DERIVED_KIND, id);
}

/**
 * 批量导入看板 SQL：文本里一段段「看板--指标」标题 + SQL（可以直接粘贴需求里从 Excel 复制的内容）。
 * 每段成为一张派生表：分类 = 看板，中文名 = 指标，按 DataFab 写法改写成 MySQL；同一标题再导入就更新。
 * dryRun 只返回拆分和改写结果。导入后在后台逐张计算（不会一次压上业务库）。
 */
export async function importBoardSql({ text = '', dryRun = false } = {}, actor = '') {
    const blocks = splitBoardSql(text);
    if (!blocks.length) throw client.dhError('DW_NO_BLOCKS', '没有认出看板 SQL：每段第一行写「看板--指标」，下面跟 SELECT 语句', { statusCode: 400 });
    const existing = new Map((await storedDefs()).map((d) => [d.id, d]));
    const items = [];
    for (const b of blocks) {
        const id = `dv_kb_${hash(b.title).slice(0, 10)}`;
        const prev = existing.get(id);
        const input = { id: prev ? id : undefined, name: prev?.name || `kb_${hash(b.title).slice(0, 10)}`, nameCn: b.metric || b.title, category: b.board, description: `看板「${b.board}」指标「${b.metric}」（导入自看板 SQL）`, sql: b.sql, dialect: 'datafab', refresh: prev?.refresh || 'linked' };
        let item;
        try {
            const def = normalizeDef(input, prev);
            item = { title: b.title, board: b.board, metric: b.metric, id: prev ? id : def.id, action: prev ? (prev.sourceSql === def.sourceSql ? 'same' : 'update') : 'create', sources: def.sources, notes: def.dialectNotes, sql: def.sql };
            if (!dryRun && item.action !== 'same') {
                // 英文名 kb_<标题哈希>，id 随之是 dv_kb_<标题哈希>：重复导入能对上同一张
                const saved = await saveDerived(input, actor, { refreshNow: false });
                item.id = saved.id;
            }
        } catch (error) {
            item = { title: b.title, board: b.board, metric: b.metric, action: 'error', error: error.message };
        }
        items.push(item);
    }
    // 没授权业务数据源时先不算：授权后联动检查会把“从没算过”的派生表补算一遍
    if (!dryRun && hasBusinessDatasource()) {
        const toRun = items.filter((i) => i.action === 'create' || i.action === 'update').map((i) => i.id);
        (async () => { for (const id of toRun) await refreshDerived(id, { reason: '导入看板 SQL' }).catch(() => {}); })();
    }
    return { total: items.length, created: items.filter((i) => i.action === 'create').length, updated: items.filter((i) => i.action === 'update').length, unchanged: items.filter((i) => i.action === 'same').length, errors: items.filter((i) => i.action === 'error').length, items };
}

const refreshing = new Map();
/** 重算一张派生表（同一张表同时只跑一次） */
export function refreshDerived(id, { reason = '手动', fingerprints = null } = {}) {
    if (refreshing.has(id)) return refreshing.get(id);
    const job = (async () => {
        const def = await getDerived(id);
        if (!def) throw client.dhError('DW_NOT_FOUND', '派生表不存在', { statusCode: 404 });
        const started = Date.now();
        const fps = fingerprints || await sourceFingerprints(def.sources).catch(() => ({}));
        try {
            if (def.cycle) throw new Error(`派生表之间循环引用：${def.cycle}`);
            const { rows, truncated } = await client.queryAll(def.compiledSql, { maxRows: def.maxRows });
            const columns = rows.length ? Object.keys(rows[0]) : [];
            await putRecord(DATA_KIND, { id, name: def.name, sortKey: def.name, summary: { rows: rows.length, truncated }, payload: { columns, rows, refreshedAt: new Date().toISOString(), truncated } });
            const next = { ...def, status: 'ok', lastError: '', lastRunAt: new Date().toISOString(), lastReason: reason, durationMs: Date.now() - started, rowCount: rows.length, truncated, columnsSeen: columns, sourceFingerprints: { ...(def.sourceFingerprints || {}), ...fps } };
            await putDerived(next);
            return next;
        } catch (error) {
            const next = { ...def, status: 'error', lastError: String(error.message || error).slice(0, 500), lastRunAt: new Date().toISOString(), lastReason: reason, durationMs: Date.now() - started };
            await putDerived(next);
            pushLog({ level: 'WARN', category: 'DATA_WATCH', message: `派生表 ${def.name} 计算失败：${next.lastError}` });
            return next;
        }
    })().finally(() => refreshing.delete(id));
    refreshing.set(id, job);
    return job;
}

export async function derivedData(id, { limit = 200, offset = 0 } = {}) {
    const rec = await getRecord(DATA_KIND, id);
    if (!rec?.payload) return { columns: [], rows: [], total: 0 };
    const rows = rec.payload.rows || [];
    const start = Math.max(0, Number(offset) || 0);
    return { columns: rec.payload.columns || [], rows: rows.slice(start, start + Math.min(1000, Number(limit) || 200)), total: rows.length, refreshedAt: rec.payload.refreshedAt, truncated: rec.payload.truncated };
}

/** 源表指纹：行数估计 + 更新时间 + 数据量（一条 information_schema 查询）再加精确行数 */
export async function sourceFingerprints(keys) {
    const list = [...new Set(keys)].slice(0, MAX_SOURCES);
    if (!list.length) return {};
    const parts = list.map((k) => ({ key: k, name: k }));
    const meta = new Map();
    try {
        const { rows } = await client.queryAll(`SELECT TABLE_NAME AS n, TABLE_ROWS AS r, UPDATE_TIME AS u, DATA_LENGTH AS d FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${client.businessSchemaExpr()} AND TABLE_NAME IN (${parts.map((p) => client.quote(p.name)).join(', ')})`, { maxRows: 1000 });
        for (const row of rows) meta.set(String(pick(row, 'n')), `${pick(row, 'r') ?? ''}|${pick(row, 'u') ?? ''}|${pick(row, 'd') ?? ''}`);
    } catch { /* 拿不到元数据时只看精确行数 */ }
    const out = {};
    for (const p of parts) {
        let count = '';
        try {
            const { rows } = await client.queryPage(`SELECT COUNT(*) AS c FROM ${client.businessTableRef(p.name)}`, { limit: 1 });
            count = String(pick(rows[0], 'c') ?? '');
        } catch (error) { count = `err:${watch.classifyError(error).kind}`; }
        out[p.key] = `${count}|${meta.get(p.key) || ''}`;
    }
    return out;
}

/** 联动检查：源表指纹变了、或按间隔到期的派生表重算 */
export async function linkCheck() {
    if (!hasBusinessDatasource()) return { checked: 0, refreshed: [] };
    const defs = (await listDerived()).filter((d) => d.enabled && d.refresh !== 'manual');
    const linked = defs.filter((d) => d.refresh === 'linked');
    const fps = await sourceFingerprints(linked.flatMap((d) => d.sources));
    const refreshed = [];
    for (const def of defs) {
        let reason = '';
        if (def.refresh === 'linked') {
            const changed = def.sources.filter((k) => fps[k] !== undefined && (def.sourceFingerprints || {})[k] !== fps[k]);
            if (!def.lastRunAt) reason = '首次计算';
            else if (changed.length) reason = `源表有变化：${changed.slice(0, 3).join('、')}${changed.length > 3 ? ' 等' : ''}`;
        } else if (!def.lastRunAt || Date.now() - Date.parse(def.lastRunAt) >= def.intervalMinutes * 60_000) reason = `按间隔（每 ${def.intervalMinutes} 分钟）`;
        if (!reason) continue;
        const ownFps = Object.fromEntries(def.sources.map((k) => [k, fps[k]]).filter(([, v]) => v !== undefined));
        await refreshDerived(def.id, { reason, fingerprints: def.refresh === 'linked' ? ownFps : null });
        refreshed.push(def.id);
    }
    return { checked: defs.length, refreshed };
}

/** 一轮行数巡检结束：源表行数变了的联动派生表立刻重算（不等下一次指纹检查） */
async function afterRun({ results, previous }) {
    if (!previous) return;
    const prev = new Map((previous.results || []).map((r) => [r.key, r.count]));
    const changed = new Set(results.filter((r) => r.count != null && prev.has(r.key) && prev.get(r.key) !== r.count).map((r) => r.key));
    if (!changed.size) return;
    for (const def of await listDerived()) {
        if (!def.enabled || def.refresh !== 'linked') continue;
        const hit = def.sources.filter((k) => changed.has(k));
        if (hit.length) await refreshDerived(def.id, { reason: `巡检发现源表行数变化：${hit.slice(0, 3).join('、')}` });
    }
}
watch.onRunFinished(afterRun);
watch.onLinkTick(() => linkCheck());

// ── 治理总览：业务库所有表 × 字典 × 巡检 × 收集 × 派生表 ──
export async function catalogView() {
    const settings = await watch.getSettings();
    const [run, dict, collection, derived, cat] = await Promise.all([
        watch.latestRun().catch(() => null),
        dictionaryMap(),
        watch.latestCollection().catch(() => null),
        listDerived(),
        catalog.listTables({ scope: 'business' }).catch(() => null),
    ]);
    const samples = collection ? new Map((await watch.collectionTables(collection.id)).map((s) => [s.key, s])) : new Map();
    const anomalies = new Map((run?.anomalies || []).map((a) => [a.key, a]));
    const results = new Map((run?.results || []).map((r) => [r.key, r]));
    // 目录（441 张盘点种子 + 管理员标注）只用来给库里真有的表补中文名 / 分类，不决定有哪些表
    const catMap = new Map((cat?.tables || []).map((t) => [normalizeKey(t.name), t]));
    const dependents = new Map();
    for (const d of derived) for (const k of d.sources) dependents.set(k, [...(dependents.get(k) || []), { id: d.id, name: d.name, nameCn: d.nameCn }]);
    // 表清单以实际查到的业务库为准：上一轮巡检看到的表；还没巡检过就现查一次库里有哪些表
    const keys = new Set([...results.keys()]);
    let liveError = '';
    if (!keys.size && hasBusinessDatasource()) {
        try { for (const t of await watch.inventory(settings)) keys.add(t.key); } catch (error) { liveError = String(error.message || error).slice(0, 200); }
    }
    const liveKeys = new Set(keys);
    // 字典里有、库里没有的表也列出来（标“库里没有”），提醒字典过期或表已下线
    const liveLower = new Set([...liveKeys].map((k) => k.toLowerCase()));
    for (const [k, entry] of dict) if (!liveLower.has(k)) keys.add(entry.key);
    const tables = [...keys].sort().map((key) => {
        const r = results.get(key), d = dict.get(key.toLowerCase()), c = catMap.get(key), s = samples.get(key), a = anomalies.get(key);
        const inLive = liveKeys.has(key);
        const status = !inLive ? 'missing' : a ? 'anomaly' : r?.count == null && r ? 'error' : r?.count === 0 ? 'empty' : r ? 'ok' : 'unchecked';
        return {
            key, name: key,
            nameCn: d?.nameCn || c?.nameCn || r?.comment || '',
            nameCnSource: d?.nameCn ? 'dictionary' : c?.nameCn ? (c.nameCnSource || 'catalog') : r?.comment ? 'comment' : '',
            nameEn: d?.nameEn || '',
            category: d?.category || c?.category || '未分类',
            subCategory: d?.subCategory || c?.module || '',
            layer: d?.layer || c?.grain || '',
            description: d?.description || c?.description || '',
            inDictionary: Boolean(d), dictColumns: d?.columns?.length || 0,
            type: r?.type || 'table',
            count: r ? r.count : null, error: r?.error || '',
            status, anomaly: a || null,
            sample: s ? { status: s.status, sampled: s.sampled, reason: s.reason, errorKind: s.errorKind, columns: s.columns } : null,
            inLive,
            derivedBy: dependents.get(key) || [],
        };
    });
    const categories = {};
    for (const t of tables) {
        const node = categories[t.category] || (categories[t.category] = { name: t.category, total: 0, anomalies: 0, empty: 0, errors: 0, sub: {} });
        node.total += 1;
        if (t.status === 'anomaly') node.anomalies += 1;
        if (t.status === 'empty') node.empty += 1;
        if (t.status === 'error') node.errors += 1;
        if (t.subCategory) node.sub[t.subCategory] = (node.sub[t.subCategory] || 0) + 1;
    }
    return {
        schemas: watch.schemasOf(settings),
        lastRun: run ? { id: run.id, ...run.summary } : null,
        lastCollection: collection,
        liveError,
        stats: {
            tables: liveKeys.size,
            missing: tables.filter((t) => !t.inLive).length,
            withCn: tables.filter((t) => t.nameCn).length,
            withEn: tables.filter((t) => t.nameEn).length,
            inDictionary: tables.filter((t) => t.inDictionary).length,
            anomalies: tables.filter((t) => t.status === 'anomaly').length,
            empty: tables.filter((t) => t.status === 'empty').length,
            errors: tables.filter((t) => t.status === 'error').length,
            unchecked: tables.filter((t) => t.status === 'unchecked').length,
            derived: derived.length,
            derivedErrors: derived.filter((d) => d.status === 'error').length,
        },
        categories: Object.values(categories).sort((a, b) => (a.name === '未分类') - (b.name === '未分类') || b.total - a.total),
        tables,
    };
}

/** 单表详情：字典、字段中英文映射（字典 × 实际字段）、行数趋势、最近一次样例、下游派生表 */
export async function tableDetail(key) {
    const k = normalizeKey(key);
    const [dict, sample, history, derived] = await Promise.all([
        getRecord(DICT_KIND, dictId(k)).then((r) => r?.payload || null),
        watch.getSample(k).catch(() => null),
        watch.countHistory(k, 30).catch(() => []),
        listDerived(),
    ]);
    const live = sample?.columns || [];
    const dictCols = new Map((dict?.columns || []).map((c) => [c.name.toLowerCase(), c]));
    const columns = live.map((c) => ({ name: c.name, type: c.type || '', comment: c.comment || '', nameCn: dictCols.get(c.name.toLowerCase())?.nameCn || c.comment || '', description: dictCols.get(c.name.toLowerCase())?.description || '', inDictionary: dictCols.has(c.name.toLowerCase()) }));
    // 字典里有、库里已没有的字段也列出来，提醒字典过期
    const liveNames = new Set(live.map((c) => c.name.toLowerCase()));
    for (const c of dict?.columns || []) if (!liveNames.has(c.name.toLowerCase())) columns.push({ name: c.name, type: c.type || '', nameCn: c.nameCn || '', description: c.description || '', inDictionary: true, missingInDb: true });
    return { key: k, dictionary: dict, columns, sample, history, derivedBy: derived.filter((d) => d.sources.includes(k)).map((d) => ({ id: d.id, name: d.name, nameCn: d.nameCn, status: d.status })) };
}

// ── 内置默认数据（src/defaults/data-governance/）：表字典与看板 SQL，服务启动时自动导入 ──
// 只在文件内容变了时导入（按内容哈希记在键值表），所以页面上改过的内容不会每次重启都被覆盖；
// 字典按“合并”导入，看板 SQL 按标题对上原来那张派生表。
const BUNDLE_DIR = new URL('../defaults/data-governance/', import.meta.url);
const BUNDLE_KEY = 'data_governance_bundle_hash';
const BUNDLE_FILES = [
    { file: 'netcare-script-tables.csv', kind: 'dictionary' },
    { file: 'board-tables.txt', kind: 'dictionary' },
    { file: 'board-sql.txt', kind: 'boards' },
];

export async function applyBundledDefaults({ force = false } = {}) {
    const files = BUNDLE_FILES.map((f) => {
        try { return { ...f, text: fs.readFileSync(new URL(f.file, BUNDLE_DIR), 'utf8') }; } catch { return null; }
    }).filter(Boolean);
    if (!files.length) return { skipped: 'no-bundle' };
    const digest = hash(files.map((f) => `${f.file}\n${f.text}`).join('\n\u0000'));
    if (!force && (await kvGet(BUNDLE_KEY, '')) === digest) return { skipped: 'unchanged' };
    const out = {};
    for (const f of files) {
        try {
            out[f.file] = f.kind === 'dictionary'
                ? await importDictionary({ filename: f.file, text: f.text }, { actor: 'system', mode: 'merge' })
                : await importBoardSql({ text: f.text }, 'system').then((r) => ({ total: r.total, created: r.created, updated: r.updated, unchanged: r.unchanged, errors: r.errors }));
        } catch (error) {
            out[f.file] = { error: error.message };
        }
    }
    if (!Object.values(out).some((r) => r.error)) await kvSet(BUNDLE_KEY, digest);
    pushLog({ level: 'INFO', category: 'DATA_WATCH', message: '已导入内置的表字典与看板 SQL', detail: out });
    return out;
}
