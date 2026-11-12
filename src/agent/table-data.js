// 表格分析：把对话附件里的 Excel / CSV 解析成行列，在服务端做筛选、分组、聚合，只把结果交给模型。
// 不引入 SQL 引擎（规范禁止动态执行），用结构化参数表达查询。
const MAX_ROWS = 200_000;
const cache = new Map(); // 附件 id → 解析结果；只留最近几个
const CACHE_LIMIT = 6;

function uniqueHeaders(raw) {
    const seen = new Map();
    return raw.map((h, i) => {
        let name = String(h ?? '').replace(/\s+/g, ' ').trim() || `第${i + 1}列`;
        const n = seen.get(name) || 0;
        seen.set(name, n + 1);
        if (n) name = `${name}_${n + 1}`;
        return name;
    });
}

function cellValue(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ').replace(/ 00:00:00$/, '');
    if (typeof value === 'object') {
        if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
        if (value.result !== undefined) return cellValue(value.result);
        if (value.text !== undefined) return String(value.text);
        if (value.error) return String(value.error);
        return JSON.stringify(value);
    }
    return value;
}

function parseCsv(text) {
    const src = text.replace(/^﻿/, '');
    const firstLine = src.slice(0, src.indexOf('\n') === -1 ? src.length : src.indexOf('\n'));
    const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < src.length; i += 1) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"') {
                if (src[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
            } else cell += ch;
        } else if (ch === '"' && cell === '') quoted = true;
        else if (ch === delim) { row.push(cell); cell = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && src[i + 1] === '\n') i += 1;
            row.push(cell); cell = '';
            rows.push(row); row = [];
            if (rows.length > MAX_ROWS) break;
        } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
}

function toSheet(name, matrix) {
    const start = matrix.findIndex((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ''));
    if (start === -1) return { name, columns: [], rows: [] };
    const width = Math.max(...matrix.slice(start, start + 50).map((r) => r.length));
    const columns = uniqueHeaders(Array.from({ length: width }, (_, i) => matrix[start][i]));
    const rows = matrix.slice(start + 1)
        .filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ''))
        .slice(0, MAX_ROWS)
        .map((r) => columns.map((_, i) => {
            const v = r[i];
            return v === '' || v === undefined ? null : v;
        }));
    return { name, columns, rows };
}

export async function loadTables(file) {
    if (cache.has(file.id)) return cache.get(file.id);
    const name = String(file.name || '').toLowerCase();
    let sheets;
    if (/\.(csv|tsv|txt)$/.test(name)) {
        sheets = [toSheet(file.name.replace(/\.[^.]+$/, ''), parseCsv(file.buffer.toString('utf8')))];
    } else if (/\.(xlsx|xlsm)$/.test(name)) {
        let ExcelJS;
        try { ExcelJS = (await import('exceljs')).default; } catch { throw new Error('当前安装包（精简包）不含 Excel 解析组件，无法分析 Excel；可以改传 CSV，或改用完整包'); }
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(file.buffer);
        sheets = wb.worksheets.map((ws) => {
            const matrix = [];
            ws.eachRow({ includeEmpty: true }, (row, n) => {
                if (n > MAX_ROWS + 50) return;
                const cells = [];
                for (let c = 1; c <= ws.columnCount; c += 1) cells.push(cellValue(row.getCell(c).value));
                matrix[n - 1] = cells;
            });
            return toSheet(ws.name, Array.from(matrix, (r) => r || []));
        });
    } else {
        throw new Error('只支持 Excel（.xlsx）和 CSV 文件');
    }
    cache.set(file.id, sheets);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return sheets;
}

// 数字识别：1,234.5、-3、91.2%（按 91.2 处理）
export function toNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    const m = /^\s*(-?[\d,]*\.?\d+)\s*%?\s*$/.exec(v);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}
const text = (v) => (v === null || v === undefined ? '' : String(v));
const isEmpty = (v) => v === null || v === undefined || String(v).trim() === '';

function compare(a, b) {
    const na = toNumber(a);
    const nb = toNumber(b);
    if (na !== null && nb !== null) return na - nb;
    return text(a).localeCompare(text(b), 'zh-CN');
}

function matcher(cond, col) {
    const op = String(cond.op || '=').toLowerCase();
    const v = cond.value;
    const list = Array.isArray(v) ? v.map(text) : [];
    switch (op) {
    case '=': case '==': case 'eq': return (x) => compare(x, v) === 0 && !isEmpty(x) === !isEmpty(v);
    case '!=': case '<>': case 'ne': return (x) => !(compare(x, v) === 0 && !isEmpty(x) === !isEmpty(v));
    case '>': return (x) => !isEmpty(x) && compare(x, v) > 0;
    case '>=': return (x) => !isEmpty(x) && compare(x, v) >= 0;
    case '<': return (x) => !isEmpty(x) && compare(x, v) < 0;
    case '<=': return (x) => !isEmpty(x) && compare(x, v) <= 0;
    case 'contains': return (x) => text(x).toLowerCase().includes(text(v).toLowerCase());
    case 'not_contains': return (x) => !text(x).toLowerCase().includes(text(v).toLowerCase());
    case 'starts_with': return (x) => text(x).startsWith(text(v));
    case 'in': return (x) => list.includes(text(x));
    case 'not_in': return (x) => !list.includes(text(x));
    case 'empty': return (x) => isEmpty(x);
    case 'not_empty': return (x) => !isEmpty(x);
    default: throw new Error(`不支持的条件 op「${cond.op}」（列 ${col}）`);
    }
}

function aggregate(fn, values) {
    const f = String(fn || 'count').toLowerCase();
    if (f === 'count') return values.length;
    if (f === 'count_non_empty') return values.filter((v) => !isEmpty(v)).length;
    if (f === 'count_distinct') return new Set(values.filter((v) => !isEmpty(v)).map(text)).size;
    const nums = values.map(toNumber).filter((n) => n !== null);
    if (f === 'sum') return round(nums.reduce((a, b) => a + b, 0));
    if (f === 'avg') return nums.length ? round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
    if (f === 'min') return nums.length ? Math.min(...nums) : (values.filter((v) => !isEmpty(v)).sort(compare)[0] ?? null);
    if (f === 'max') return nums.length ? Math.max(...nums) : (values.filter((v) => !isEmpty(v)).sort(compare).at(-1) ?? null);
    throw new Error(`不支持的聚合函数「${fn}」`);
}
const round = (n) => Number(Number(n).toPrecision(12));

function describeColumn(name, values) {
    const filled = values.filter((v) => !isEmpty(v));
    const nums = filled.map(toNumber).filter((n) => n !== null);
    const counts = new Map();
    for (const v of filled) counts.set(text(v), (counts.get(text(v)) || 0) + 1);
    const info = { column: name, filled: filled.length, empty: values.length - filled.length, distinct: counts.size };
    if (nums.length && nums.length >= filled.length * 0.8) {
        Object.assign(info, { type: '数字', min: Math.min(...nums), max: Math.max(...nums), avg: round(nums.reduce((a, b) => a + b, 0) / nums.length) });
    } else {
        info.type = '文本';
        if (counts.size <= 30) info.top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value, count]) => ({ value: value.slice(0, 60), count }));
    }
    return info;
}

/**
 * q: { sheet, select, where:[{column,op,value}], group_by, aggregates:[{fn,column,as}], order_by:[{column,desc}], limit, offset, describe }
 */
export function runQuery(sheets, q = {}) {
    const sheet = q.sheet ? sheets.find((s) => s.name === q.sheet) : sheets.find((s) => s.rows.length) || sheets[0];
    if (!sheet) throw new Error(`没有名为「${q.sheet}」的工作表。可用：${sheets.map((s) => s.name).join('、')}`);
    const idx = new Map(sheet.columns.map((c, i) => [c, i]));
    const col = (name) => {
        if (!idx.has(name)) throw new Error(`没有名为「${name}」的列。可用的列：${sheet.columns.join('、')}`);
        return idx.get(name);
    };
    const nothingAsked = !q.select && !q.where && !q.group_by && !q.aggregates && !q.order_by;
    if (q.describe || nothingAsked) {
        return {
            mode: 'describe',
            sheets: sheets.map((s) => ({ name: s.name, rows: s.rows.length, columns: s.columns.length })),
            sheet: sheet.name,
            rowCount: sheet.rows.length,
            columns: sheet.columns.map((c, i) => describeColumn(c, sheet.rows.map((r) => r[i]))),
            sample: sheet.rows.slice(0, 5).map((r) => Object.fromEntries(sheet.columns.map((c, i) => [c, r[i]]))),
        };
    }
    let rows = sheet.rows;
    for (const cond of Array.isArray(q.where) ? q.where : []) {
        const i = col(cond.column);
        const test = matcher(cond, cond.column);
        rows = rows.filter((r) => test(r[i]));
    }
    const matched = rows.length;
    let out;
    let columns;
    const aggs = Array.isArray(q.aggregates) ? q.aggregates : [];
    const groupBy = Array.isArray(q.group_by) ? q.group_by : (q.group_by ? [q.group_by] : []);
    if (groupBy.length || aggs.length) {
        const gIdx = groupBy.map(col);
        const specs = (aggs.length ? aggs : [{ fn: 'count' }]).map((a) => ({
            ...a,
            i: a.column ? col(a.column) : -1,
            as: a.as || `${a.fn || 'count'}${a.column ? `(${a.column})` : ''}`,
        }));
        const groups = new Map();
        for (const r of rows) {
            const key = JSON.stringify(gIdx.map((i) => text(r[i])));
            if (!groups.has(key)) groups.set(key, { keys: gIdx.map((i) => r[i]), rows: [] });
            groups.get(key).rows.push(r);
        }
        if (!groups.size && !groupBy.length) groups.set('[]', { keys: [], rows: [] });
        columns = [...groupBy, ...specs.map((s) => s.as)];
        out = [...groups.values()].map((g) => [...g.keys, ...specs.map((s) => aggregate(s.fn, s.i === -1 ? g.rows : g.rows.map((r) => r[s.i])))]);
    } else {
        columns = Array.isArray(q.select) && q.select.length ? q.select : sheet.columns;
        const sIdx = columns.map(col);
        out = rows.map((r) => sIdx.map((i) => r[i]));
    }
    const cIdx = new Map(columns.map((c, i) => [c, i]));
    const orders = Array.isArray(q.order_by) ? q.order_by : (q.order_by ? [q.order_by] : []);
    if (orders.length) {
        const keys = orders.map((o) => {
            const name = typeof o === 'string' ? o : o.column;
            if (!cIdx.has(name)) throw new Error(`排序列「${name}」不在结果里。结果列：${columns.join('、')}`);
            return { i: cIdx.get(name), desc: typeof o === 'object' && Boolean(o.desc) };
        });
        out = [...out].sort((a, b) => {
            for (const k of keys) {
                const c = compare(a[k.i], b[k.i]);
                if (c) return k.desc ? -c : c;
            }
            return 0;
        });
    }
    const limit = Math.max(1, Math.min(Number(q.limit) || 50, 500));
    const offset = Math.max(0, Number(q.offset) || 0);
    const page = out.slice(offset, offset + limit);
    return {
        mode: 'query',
        sheet: sheet.name,
        matchedRows: matched,
        resultRows: out.length,
        returned: page.length,
        ...(out.length > offset + page.length ? { note: `结果共 ${out.length} 行，只返回第 ${offset + 1}–${offset + page.length} 行；用 offset 翻页，或加条件、改成聚合` } : {}),
        columns,
        rows: page.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))),
    };
}
