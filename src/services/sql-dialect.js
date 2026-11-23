// DataFab（GaussDB / PostgreSQL 系）看板 SQL → MySQL 8：业务库是 MySQL，看板逻辑多从 DataFab 抄来，直接跑不了。
// 只改写看板 SQL 里实际出现的写法，改了什么都记在 notes 里给人看：
//   "库"."模式"."表"     → `表`（业务库只有一个，表就在当前库）
//   "中文别名"            → `中文别名`
//   divide(a, b, d)       → COALESCE((a) / NULLIF((b), 0), d)（DataFab 的安全除法：除数为 0 时取 d）
//   date_trunc('day', x)  → DATE(x)；month / year 截到月初 / 年初
//   x asc nulls last      → x IS NULL, x asc（MySQL 没有 NULLS LAST）
//   FROM (子查询) WHERE   → FROM (子查询) AS dv_sub1 WHERE（MySQL 的派生表必须有别名）
//   同一个 SELECT 里引用前面的中文别名 → 展开成那一列的表达式（MySQL 不允许引用同级别名）
// 字符串字面量和注释先抽走，改写只作用在代码部分。

const KEYWORDS_AFTER_SUBQUERY = /^(where|group|order|limit|having|union|join|left|right|inner|cross|on|window|\)|;|$)/i;
const CJK = /[㐀-鿿]/;

function protectStrings(sql) {
    const strings = [];
    let out = '';
    for (let i = 0; i < sql.length; i += 1) {
        const ch = sql[i];
        if (ch === '\'') {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === '\'' && sql[j + 1] === '\'') { j += 2; continue; }
                if (sql[j] === '\\') { j += 2; continue; }
                if (sql[j] === '\'') break;
                j += 1;
            }
            strings.push(sql.slice(i, j + 1));
            out += `\u0000${strings.length - 1}\u0000`;
            i = j;
        } else if (ch === '-' && sql[i + 1] === '-') {
            while (i < sql.length && sql[i] !== '\n') i += 1;
            out += '\n';
        } else if (ch === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            i = end < 0 ? sql.length : end + 1;
            out += ' ';
        } else out += ch;
    }
    return { code: out, strings };
}
const restore = (code, strings) => code.replace(/\u0000(\d+)\u0000/g, (_, n) => strings[Number(n)]);
const literal = (code, strings) => { const m = /^\s*\u0000(\d+)\u0000\s*$/.exec(code); return m ? strings[Number(m[1])].slice(1, -1) : null; };

/** 从 open（左括号位置）找到配对的右括号位置 */
function matchParen(code, open) {
    let depth = 0;
    for (let i = open; i < code.length; i += 1) {
        if (code[i] === '(') depth += 1;
        else if (code[i] === ')') { depth -= 1; if (!depth) return i; }
    }
    return -1;
}

/** 按顶层逗号切参数 / 列 */
function splitTop(text) {
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] === '(') depth += 1;
        else if (text[i] === ')') depth -= 1;
        else if (text[i] === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
    }
    parts.push(text.slice(start));
    return parts;
}

/** 把 name( … ) 形式的函数调用逐个交给 fn 改写（参数先递归改写） */
function rewriteCalls(code, name, fn) {
    const re = new RegExp(`\\b${name}\\s*\\(`, 'i');
    let out = '';
    let rest = code;
    for (;;) {
        const m = re.exec(rest);
        if (!m) return out + rest;
        const open = m.index + m[0].length - 1;
        const close = matchParen(rest, open);
        if (close < 0) return out + rest;
        const args = splitTop(rest.slice(open + 1, close)).map((a) => rewriteCalls(a, name, fn));
        out += rest.slice(0, m.index) + fn(args);
        rest = rest.slice(close + 1);
    }
}

/** 找出最外层查询的 SELECT 列表（SELECT 与同层 FROM 之间） */
function topSelectList(code) {
    let depth = 0;
    let selectEnd = -1;
    const lower = code.toLowerCase();
    for (let i = 0; i < code.length; i += 1) {
        if (code[i] === '(') depth += 1;
        else if (code[i] === ')') depth -= 1;
        else if (depth === 0 && /\w/.test(code[i]) && (i === 0 || !/\w/.test(code[i - 1]))) {
            if (selectEnd < 0 && /^select\b/.test(lower.slice(i))) {
                const distinct = /^select\s+(distinct\s+)?/.exec(lower.slice(i));
                selectEnd = i + distinct[0].length;
            } else if (selectEnd >= 0 && /^from\b/.test(lower.slice(i))) return { start: selectEnd, end: i };
        }
    }
    return null;
}

const ALIAS_STOP = /^(end|and|or|not|null|then|else|distinct|asc|desc)$/i;
function splitAlias(raw) {
    const tail = /\s*$/.exec(raw)[0];
    const item = raw.slice(0, raw.length - tail.length);
    let m = /^([\s\S]*?)\s+as\s+(`[^`]+`|[\p{L}\p{N}_]+)$/iu.exec(item);
    // 反引号别名可以紧贴在右括号后面：count(x)`任务数`
    if (!m) m = /^([\s\S]*?[)\w'\u0000])\s*(`[^`]+`)$/u.exec(item);
    if (!m) {
        m = /^([\s\S]*[)\w'\u0000])\s+([\p{L}\p{N}_]+)$/u.exec(item);
        if (m && ALIAS_STOP.test(m[2])) m = null;
    }
    return m ? { expr: m[1], alias: m[2].replace(/`/g, ''), tail } : { expr: item, alias: '', tail };
}

/** 同一个 SELECT 里引用了前面列的中文别名：展开成那一列的表达式 */
function inlineAliases(code, notes) {
    const range = topSelectList(code);
    if (!range) return code;
    const items = splitTop(code.slice(range.start, range.end)).map(splitAlias);
    const known = new Map();
    let changed = 0;
    for (const item of items) {
        for (const [alias, expr] of known) {
            const re = new RegExp(`(^|[^\\p{L}\\p{N}_\`])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}_\`])`, 'gu');
            const next = item.expr.replace(re, (_, lead) => `${lead}(${expr.trim()})`);
            if (next !== item.expr) { item.expr = next; changed += 1; }
        }
        if (item.alias && CJK.test(item.alias)) known.set(item.alias, item.expr);
    }
    if (!changed) return code;
    notes.push(`同一个 SELECT 里引用的中文别名已展开成对应表达式（${changed} 处）`);
    const list = items.map((i) => (i.alias ? `${i.expr} AS \`${i.alias}\`${i.tail}` : `${i.expr}${i.tail}`)).join(',');
    return code.slice(0, range.start) + list + code.slice(range.end);
}

function aliasSubqueries(code, notes) {
    let out = code;
    let n = 0;
    const re = /\b(from|join)\s*\(/gi;
    let m;
    while ((m = re.exec(out))) {
        const open = m.index + m[0].length - 1;
        if (!/^\s*(select|with)\b/i.test(out.slice(open + 1))) continue;
        const close = matchParen(out, open);
        if (close < 0) break;
        const after = out.slice(close + 1).trimStart();
        if (KEYWORDS_AFTER_SUBQUERY.test(after)) {
            n += 1;
            out = `${out.slice(0, close + 1)} AS dv_sub${n}${out.slice(close + 1)}`;
        }
        re.lastIndex = open + 1;
    }
    if (n) notes.push(`给 ${n} 个没有别名的子查询加了别名（MySQL 要求）`);
    return out;
}

const ALIAS_KEYWORDS = /^(where|group|order|limit|having|union|join|left|right|inner|cross|on|window|as)$/i;
/**
 * 用了没定义的表别名（如 t.col，但 FROM 表后面没写 t）：查询里只有一张表时把别名补上。
 * 原始 SQL 本身的笔误，DataFab 上同样会报错；这里只在能唯一确定的情况下修。
 */
function fixMissingAlias(code, notes) {
    const bare = code.replace(/`[^`]*`/g, '``');
    const used = new Set([...bare.matchAll(/(?<![\w.`])([A-Za-z_]\w*)\.(?=[A-Za-z_`])/g)].map((m) => m[1]));
    if (!used.size) return code;
    const fromRefs = [...code.matchAll(/\b(from|join)\s+(`?[\w$]+`?)(\s+(?:as\s+)?([A-Za-z_]\w*))?/gi)];
    const defined = new Set();
    for (const m of fromRefs) {
        defined.add(m[2].replace(/`/g, ''));
        if (m[4] && !ALIAS_KEYWORDS.test(m[4])) defined.add(m[4]);
    }
    for (const m of code.matchAll(/\)\s*(?:as\s+)?([A-Za-z_]\w*)/gi)) if (!ALIAS_KEYWORDS.test(m[1])) defined.add(m[1]);
    const missing = [...used].filter((q) => !defined.has(q) && !/^(dv_sub\d+)$/.test(q));
    const plain = fromRefs.filter((m) => !m[4] || ALIAS_KEYWORDS.test(m[4]));
    if (missing.length !== 1 || fromRefs.length !== 1 || plain.length !== 1) return code;
    const m = plain[0];
    const at = m.index + m[1].length + m[0].slice(m[1].length).indexOf(m[2]) + m[2].length;
    notes.push(`SQL 里用了没定义的表别名 ${missing[0]}，已补在 ${m[2].replace(/`/g, '')} 后面（原 SQL 的笔误）`);
    return `${code.slice(0, at)} ${missing[0]}${code.slice(at)}`;
}

export function looksLikeDataFab(sql) {
    return /"[^"\n]+"\s*\.\s*"|\bdivide\s*\(|\bdate_trunc\s*\(|\bnulls\s+(last|first)\b|::\s*\w+/i.test(String(sql || ''));
}

/** DataFab / Gauss 写法改成 MySQL；返回改写后的 SQL 和改动说明 */
export function datafabToMysql(input) {
    const notes = [];
    const { code: protectedCode, strings } = protectStrings(String(input || '').replace(/\r/g, '').trim().replace(/;\s*$/, ''));
    let code = protectedCode;
    const before = code;
    code = code.replace(/(?:"[^"\n]*"\s*\.\s*)+"([^"\n]*)"/g, (_, table) => `\`${table}\``);
    if (code !== before) notes.push('"库"."模式"."表" 改成当前业务库里的表名');
    // DataFab / Gauss 不加引号的表名会折成小写；MySQL（Linux）表名区分大小写，所以 FROM / JOIN 后的表名统一转小写
    const cased = code;
    code = code.replace(/\b(from|join)(\s+)([A-Za-z_][\w$]*)(?=\s|$|\)|,)/gi, (all, kw, sp, name) => (/^(select|lateral|dual)$/i.test(name) ? all : `${kw}${sp}${name.toLowerCase()}`));
    if (code !== cased) notes.push('FROM / JOIN 后不加引号的表名转成小写（与 DataFab 一致）');
    const quoted = code;
    code = code.replace(/"([^"\n]*)"/g, (_, name) => `\`${name}\``);
    if (code !== quoted) notes.push('双引号标识符改成反引号');
    let divides = 0;
    code = rewriteCalls(code, 'divide', (args) => {
        divides += 1;
        const [a, b, d] = args.map((x) => x.trim());
        return d === undefined ? `((${a}) / NULLIF((${b}), 0))` : `COALESCE((${a}) / NULLIF((${b}), 0), ${d})`;
    });
    if (divides) notes.push(`divide() 改成 COALESCE(a / NULLIF(b, 0), 默认值)（${divides} 处）`);
    let truncs = 0;
    code = rewriteCalls(code, 'date_trunc', (args) => {
        truncs += 1;
        const unit = String(literal(args[0], strings) || '').toLowerCase();
        const x = args[1]?.trim() || '';
        if (unit === 'month') return `DATE_FORMAT(${x}, '%Y-%m-01')`;
        if (unit === 'year') return `DATE_FORMAT(${x}, '%Y-01-01')`;
        if (unit === 'hour') return `DATE_FORMAT(${x}, '%Y-%m-%d %H:00:00')`;
        return `DATE(${x})`;
    });
    if (truncs) notes.push(`date_trunc() 改成 MySQL 日期函数（${truncs} 处）`);
    const ordered = code;
    code = code.replace(/([\w`.]+)(\s+(?:asc|desc))?\s+nulls\s+(last|first)\b/gi, (_, col, dir = '', where) => `${col} IS ${where.toLowerCase() === 'last' ? '' : 'NOT '}NULL, ${col}${dir}`);
    if (code !== ordered) notes.push('NULLS LAST / FIRST 改成 IS NULL 排序');
    const casted = code;
    code = code.replace(/::\s*(numeric|decimal|int|integer|bigint|text|varchar|date|timestamp)\b/gi, '');
    if (code !== casted) notes.push('去掉了 :: 类型转换');
    code = aliasSubqueries(code, notes);
    code = fixMissingAlias(code, notes);
    code = inlineAliases(code, notes);
    return { sql: restore(code, strings), notes };
}

// ── 看板 SQL 批量导入：「看板--指标」标题行 + SQL，多段连在一起（从 Excel 复制出来的单元格会被双引号包住） ──
const TITLE_RE = /^\s*([^\s\t][^\t]*?--[^\t]+?)\s*$/;

/** 把一大段文本切成 [{ board, metric, title, sql }] */
export function splitBoardSql(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const blocks = [];
    let current = null;
    let inCell = false;
    const flush = () => { if (current && current.lines.some((l) => l.trim())) blocks.push(current); current = null; };
    for (const raw of lines) {
        let line = raw.replace(/\t+$/, '');
        if (!inCell) {
            // Excel 单元格："标题\nSQL…" 以双引号开头，内部双引号成对
            const cell = /^\s*"(?!")(.*)$/.exec(line);
            const head = cell ? cell[1] : line;
            if (TITLE_RE.test(head) && !/\b(select|from|where)\b/i.test(head)) {
                flush();
                current = { title: head.trim(), lines: [], quoted: Boolean(cell) };
                inCell = Boolean(cell);
                continue;
            }
        }
        if (!current) continue;
        if (inCell) {
            // 单元格结束：行尾是落单的双引号
            const stripped = line.replace(/""/g, '');
            if (/"\s*$/.test(stripped)) { line = line.replace(/"\s*$/, ''); inCell = false; }
            line = line.replace(/""/g, '"');
        }
        current.lines.push(line);
    }
    flush();
    return blocks.map((b) => {
        const [board, ...rest] = b.title.split('--');
        return { board: board.trim(), metric: rest.join('--').trim(), title: b.title, sql: b.lines.join('\n').trim() };
    }).filter((b) => b.sql);
}
