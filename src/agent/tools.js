// 智能体工具集（精简版）：查库、平台数据、技能、附件、HTML 工具发布。
// 每个工具：{ name, description, parameters(JSON Schema), run(args, ctx) → { ok, summary, content, output? } }
//   content 给模型看；summary 是界面上工具行的一句话结果；output 是界面上可展开的详情。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, config } from '../config.js';
import { scopedQuery, selectTable, businessQuery, hasBusinessDatasource, sqlVal, isMemoryMode, insertRow, updateRows, deleteRows } from '../dao/scoped.js';
import { listSkills, getSkill, saveSkill } from '../services/skill-service.js';
import { saveCustomTool, listCustomTools } from '../services/custom-tool-service.js';
import { readChatUpload } from '../services/chat-upload-service.js';
import { changeMemory } from '../services/memory-service.js';
import { listScripts, saveScripts, listCategories, deleteScript, moveScriptCategory } from '../services/uiv-service.js';
import { sendExpediteNotification } from '../services/report-service.js';
import { loadTables, runQuery } from './table-data.js';
import { evaluate } from './calc.js';
import { NETCARE_TOOLS } from './netcare-tools.js';
import { FOLLOWUP_TOOLS } from './followup-tools.js';

// ── 应用库目录：模型能查的业务表（其余表——对话、密钥、配置、附件——一律不可查）──
const TABLE_NOTES = {
    report_snapshots: '报表看板每次入库一条。snapshot_id 关联其余 report_* 表；month 为数字月份；standard_total_score 总分',
    report_category_scores: '某次入库的各分类得分：cat_name 分类，base_score 基础分，manual_score 手工调整分，final_score 最终分',
    report_metric_data: '某次入库的各指标明细：cat_name 分类，metric_label 指标名，target_val 目标，raw_val 原始值，num_val 数值，is_failing 是否未达标(1/0)，gap 差距，earned_score 得分，weight 权重',
    bigscreen_owners: '指标责任人：cat_name、metric_label、owner_name 责任人、emp_id 工号',
    sla_snapshots: '数据导入页保存的原始数据快照（payload_json 很大，不要查该列）：id、category、name、snapshot_time',
    sla_targets: '指标目标配置：target_key、name、category、payload_json（目标值与规则）',
    sla_categories: '数据导入的分类：name、sort_order',
    sla_groups: '指标分组：group_key、name、category',
    sla_group_items: '分组与指标的对应：group_key、target_key',
    upload_history: '导入历史：file_name、payload_json（操作说明）、created_at(毫秒时间戳)',
    import_source_batches: '原始文件归档批次：name、category、status、created_at',
    import_source_sheets: '归档的工作表：sheet_name、row_count、headers_json（rows_json 很大，不要查该列）',
    monthly_snapshots: '经典月报快照：report_month、title、updated_by（payload_json 很大）',
    ai_report_documents: 'AI 月报文档：report_month、name、updated_by、updated_at（payload_json 很大）',
    uiv_scripts: '数据抓取脚本：name、url、category（payload_json 为脚本内容）',
    uiv_categories: '数据抓取脚本分类：name、description',
};
const HEAVY_COLS = new Set(['payload_json', 'rows_json', 'raw_data_json', 'file_base64', 'data_base64', 'image_base64', 'html', 'body', 'meta_json']);

const SCHEMA = (() => {
    const map = new Map();
    try {
        const sql = fs.readFileSync(path.join(ROOT_DIR, 'db', 'init.sql'), 'utf8');
        for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS `(\w+)`\s*\(([\s\S]*?)\)\s*ENGINE/g)) {
            map.set(m[1], [...m[2].matchAll(/^\s*`(\w+)`\s+([A-Z]+(?:\(\d+\))?)/gm)].map((c) => ({ name: c[1], type: c[2] })));
        }
    } catch { /* 读不到建表脚本时目录为空，查询工具会提示 */ }
    return map;
})();
const ALLOWED = new Set(Object.keys(TABLE_NOTES).filter((t) => SCHEMA.has(t)));
const APP_DB = 'app';

/** 数据探索页用的表目录：表名、说明、列（标出默认不查的大字段） */
export function tableCatalog() {
    return [...ALLOWED].sort().map((name) => ({ name, note: TABLE_NOTES[name], columns: SCHEMA.get(name).map((c) => ({ ...c, heavy: HEAVY_COLS.has(c.name) })) }));
}

/** 给系统提示词用的紧凑目录：模型不用先花一轮去查结构 */
export function schemaDigest() {
    return [...ALLOWED].map((t) => `- ${t}(${SCHEMA.get(t).map((c) => c.name).join(', ')})：${TABLE_NOTES[t]}`).join('\n');
}

// ── 只读 SQL 守卫 ──
const stripLiterals = (sql) => sql.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');

function guardSelect(rawSql, { appDb }) {
    let sql = String(rawSql || '').trim().replace(/;\s*$/, '');
    if (!sql) return { error: 'sql 不能为空' };
    if (sql.length > 8000) return { error: 'SQL 过长（超过 8000 字符）' };
    const bare = stripLiterals(sql);
    if (bare.includes(';')) return { error: '一次只能执行一条语句' };
    if (/--|\/\*|#/.test(bare)) return { error: 'SQL 里不能带注释' };
    if (!/^\(*\s*(SELECT|WITH)\b/i.test(bare)) return { error: '只允许 SELECT 查询' };
    if (/\b(INSERT|UPDATE|DELETE|REPLACE|MERGE|DROP|ALTER|CREATE|TRUNCATE|RENAME|GRANT|REVOKE|CALL|EXEC|EXECUTE|HANDLER|LOAD_FILE|SLEEP|BENCHMARK|GET_LOCK|RELEASE_LOCK|OUTFILE|DUMPFILE)\b/i.test(bare)
        || /\bINTO\b/i.test(bare) || /\bFOR\s+(UPDATE|SHARE)\b/i.test(bare) || /\bLOCK\s+IN\b/i.test(bare) || /@@|\bSET\s+@/i.test(bare)) {
        return { error: '只允许只读查询：不能修改数据、调用函数休眠或导出文件' };
    }
    if (appDb) {
        if (/\b(information_schema|performance_schema|mysql|sys)\s*\./i.test(bare)) return { error: '不能查询系统库，表结构请用 database_schema 工具' };
        const cteNames = new Set([...bare.matchAll(/(?:\bWITH\b|,)\s*`?(\w+)`?\s+AS\s*\(/gi)].map((m) => m[1].toLowerCase()));
        const refs = [...bare.matchAll(/\b(?:FROM|JOIN)\s+((?:`?[\w.]+`?(?:\s+(?:AS\s+)?`?\w+`?)?\s*,\s*)*`?[\w.]+`?)/gi)]
            .flatMap((m) => m[1].split(',').map((part) => part.trim().split(/\s+/)[0].replace(/`/g, '').toLowerCase()));
        for (const ref of refs) {
            if (cteNames.has(ref)) continue;
            if (ref.includes('.')) return { error: `不能跨库查询：${ref}` };
            if (!ALLOWED.has(ref)) return { error: `表 ${ref} 不在可查询范围内。可查的表：${[...ALLOWED].join('、')}` };
        }
        // 兜底：即使解析漏了，受保护的表名也不能出现在语句里
        for (const t of SCHEMA.keys()) {
            if (!ALLOWED.has(t) && new RegExp(`\\b${t}\\b`, 'i').test(bare)) return { error: `表 ${t} 不允许查询` };
        }
    }
    return { sql };
}

function shapeRows(rows, maxRows = 200, maxChars = 24_000) {
    const total = rows.length;
    const out = [];
    let size = 0;
    for (const row of rows.slice(0, maxRows)) {
        const r = {};
        for (const [k, v] of Object.entries(row)) {
            if (typeof v === 'string' && v.startsWith('@@dh-chunk:')) r[k] = '[大字段，已省略]';
            else if (typeof v === 'string' && v.length > 600) r[k] = `${v.slice(0, 600)}…[共 ${v.length} 字符]`;
            else r[k] = v;
        }
        const s = JSON.stringify(r);
        if (size + s.length > maxChars) break;
        size += s.length;
        out.push(r);
    }
    return { rows: out, total, truncated: out.length < total };
}

export async function runSelect({ database, sql, limit }) {
    const isApp = !database || database === APP_DB || database === config.appSchema;
    if (!isApp && !hasBusinessDatasource()) return { ok: false, summary: '数据库不存在', content: `没有名为 ${database} 的数据库。可用：${APP_DB}` };
    const guarded = guardSelect(sql, { appDb: isApp });
    if (guarded.error) return { ok: false, summary: guarded.error.slice(0, 60), content: guarded.error };
    const cap = Math.max(1, Math.min(Number(limit) || 100, 500));
    const finalSql = /\bLIMIT\s+\d+(\s*,\s*\d+|\s+OFFSET\s+\d+)?\s*$/i.test(guarded.sql) ? guarded.sql : `${guarded.sql} LIMIT ${cap}`;
    try {
        const rows = isApp ? await scopedQuery(finalSql, cap) : await businessQuery(finalSql, cap);
        const shaped = shapeRows(rows);
        const note = shaped.truncated ? `（共 ${shaped.total} 行，只返回前 ${shaped.rows.length} 行；需要更多请加条件或聚合）` : '';
        return {
            ok: true,
            summary: `${shaped.total} 行`,
            content: JSON.stringify({ rowCount: shaped.total, rows: shaped.rows, note: note || undefined, memoryMode: isMemoryMode() ? '当前是本机内存演示模式，SQL 不会真正执行' : undefined }),
            output: `${finalSql}\n\n→ ${shaped.total} 行${note}`,
        };
    } catch (error) {
        return { ok: false, summary: '查询失败', content: `查询失败：${error.message}。请检查表名、列名和语法（MySQL 8）后重试。`, output: `${finalSql}\n\n✗ ${error.message}` };
    }
}


// ── 写操作的边界 ──
// 只开放业务配置类的表；导入快照、归档文件这类大表和系统表不开放写入
const WRITABLE = new Set(['report_metric_data', 'report_category_scores', 'bigscreen_owners', 'sla_targets', 'sla_categories', 'sla_groups', 'sla_group_items', 'uiv_categories'].filter((t) => SCHEMA.has(t)));
const MAX_WRITE_ROWS = 200;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function imageMime(name, mime) {
    if (/^image\/(png|jpe?g|webp|gif)$/i.test(String(mime || ''))) return String(mime).toLowerCase().replace('jpg', 'jpeg');
    const ext = /\.([a-z0-9]+)$/i.exec(String(name || ''))?.[1]?.toLowerCase();
    return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext] || '';
}
export { imageMime, MAX_IMAGE_BYTES };

function checkWritable(table, ctx) {
    if (!ctx.identity.isAdmin) return { error: '修改数据需要管理员权限' };
    const t = String(table || '').replace(/`/g, '').toLowerCase();
    if (!WRITABLE.has(t)) return { error: `表 ${t} 不允许通过对话修改。可写的表：${[...WRITABLE].join('、')}` };
    return { table: t };
}
function checkColumns(table, values) {
    if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) return { error: 'values 不能为空' };
    const known = new Set(SCHEMA.get(table).map((c) => c.name));
    const bad = Object.keys(values).filter((k) => !known.has(k) || k === 'id');
    if (bad.length) return { error: `这些列不能写：${bad.join('、')}（列不存在或是自增主键）。可写的列：${[...known].filter((c) => c !== 'id').join('、')}` };
    return {};
}
async function countWhere(table, where) {
    const w = String(where || '').trim();
    if (!w) return { error: '必须提供 where 条件' };
    if (/^\s*(1\s*=\s*1|true)\s*$/i.test(w)) return { error: '不允许对整张表操作' };
    const guarded = guardSelect(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE ${w}`, { appDb: true });
    if (guarded.error) return { error: `where 条件不合法：${guarded.error}` };
    const rows = await scopedQuery(guarded.sql, 1);
    const count = Number(rows[0]?.n || 0);
    if (count > MAX_WRITE_ROWS) return { error: `符合条件的有 ${count} 行，超过单次上限 ${MAX_WRITE_ROWS} 行，请缩小条件` };
    return { count };
}
const shortValue = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 120 ? `${s.slice(0, 120)}…` : s; };
function normalizeRecipients(list) {
    return [...new Set((Array.isArray(list) ? list : String(list || '').split(/[,，;；\s]+/))
        .map((x) => String(x || '').trim().replace(/^email:/i, ''))
        .filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))
        .map((x) => `email:${x}`))];
}

// 平台页面与内置工具的使用说明（来自主线版，只保留本版有的）
const TOOL_GUIDES = (() => {
    try { return JSON.parse(fs.readFileSync(new URL('./tool-guides.json', import.meta.url), 'utf8')).guides || {}; } catch { return {}; }
})();

const PLATFORM_TOOLS = [
    { id: 'uivf12', name: '数据抓取', href: '/uivf12', guide: '管理从业务系统页面抓数的脚本：把浏览器 F12 里复制的 fetch 代码粘贴进来解析、命名、分类；可生成 UI.Vision 宏。抓到的数据可一键送到「数据导入」。' },
    { id: 'sla', name: '数据导入', href: '/sla', guide: '上传 Excel/CSV（支持批量，或指定整改/常规/专项/SR/漏洞类别），页面内配置指标规则和目标，点击「保存当前指标数据」生成快照；可导出裕湘模板。' },
    { id: 'report', name: '报表看板', href: '/report', guide: '选择快照入库，查看各分类得分、未达标指标和趋势；支持手工校准并上传佐证附件。入库后的数据供大屏、催办、月报和 AI 对话使用。' },
    { id: 'expedite', name: '一键催办', href: '/expedite', guide: '按最新入库数据列出未达标/超期事项，按责任人分组生成催办内容，可通过基座通知发送。' },
    { id: 'monthly', name: '月报页面', href: '/monthly', guide: 'AI 月报编辑器：按模板生成月报，每个单元格可与 AI 对话改写、生成图表；经典月报在 /monthly/legacy，可导出 .msg 邮件。' },
    { id: 'bigscreen', name: '大屏看板', href: '/bigscreen', guide: '会议室大屏：责任人矩阵、趋势与告警指标，数据来自报表看板的入库结果。' },
    { id: 'topic-analysis', name: '专题分析', href: '/topic-analysis', guide: 'NetCare / DataFab 专题快照的历史记录、趋势和月报（EOS、证书、变更、拦截、SR 等），月报可导出 PNG / PDF / HTML / Excel / MSG。' },
    { id: 'duty-roster', name: '值班表', href: '/duty-roster', guide: '夜间运维值班表，按月保存；周日开始、周五周六为周末。' },
    { id: 'frt', name: 'FRT 核算', href: '/frt', guide: '上传工单表在浏览器里核算 FRT KPI，历史快照存服务器。' },
    { id: 'praudit', name: 'PR 稽查', href: '/praudit', guide: 'PR 进展附件稽查：模板（字段、检查点、报告字段、筛选规则）存服务器，稽查在浏览器里完成。' },
    { id: 'db-explorer', name: '数据探索', href: '/db-explorer', guide: '仅管理员：只读查询本应用库的业务表，选表看结构、写 SELECT、导出 CSV。' },
    { id: 'requirements', name: '需求广场', href: '/requirements', guide: '提平台功能需求、看处理进度和记录；管理员按流程流转。' },
];

export const TOOLS = [
    {
        name: 'list_databases',
        description: '列出可以查询的数据库。',
        parameters: { type: 'object', properties: {} },
        async run() {
            const dbs = [{ database: APP_DB, description: '本应用的业务库（导入快照、报表指标、月报、抓取脚本等）', tables: ALLOWED.size }];
            if (hasBusinessDatasource()) dbs.push({ database: config.businessDatasourceName, description: '平台授权的业务数据源（只读）。表结构用 query_database 执行 SHOW TABLES / DESCRIBE 不可用时，请直接向用户确认表名' });
            return { ok: true, summary: `${dbs.length} 个数据库`, content: JSON.stringify(dbs) };
        },
    },
    {
        name: 'database_schema',
        description: '查看应用库的表结构。不传 table 返回所有可查的表及说明；传 table 返回该表的列。',
        parameters: { type: 'object', properties: { database: { type: 'string', description: `数据库名，默认 ${APP_DB}` }, table: { type: 'string', description: '表名，可选' } } },
        async run(args) {
            const table = String(args.table || '').replace(/`/g, '').toLowerCase();
            if (!table) {
                return { ok: true, summary: `${ALLOWED.size} 张表`, content: JSON.stringify([...ALLOWED].map((t) => ({ table: t, columns: SCHEMA.get(t).map((c) => c.name), note: TABLE_NOTES[t] }))) };
            }
            if (!ALLOWED.has(table)) return { ok: false, summary: '表不可查', content: `表 ${table} 不在可查询范围内。可查的表：${[...ALLOWED].join('、')}` };
            return { ok: true, summary: `${SCHEMA.get(table).length} 列`, content: JSON.stringify({ table, note: TABLE_NOTES[table], columns: SCHEMA.get(table) }) };
        },
    },
    {
        name: 'query_database',
        description: '在数据库上执行一条只读 SELECT（MySQL 8 语法），返回结果行。用于统计、筛选、对比数据。优先用聚合（COUNT/SUM/AVG/GROUP BY）而不是把大量明细取回来；不要 SELECT 大字段列（payload_json、rows_json、raw_data_json 等）。',
        parameters: {
            type: 'object',
            properties: {
                database: { type: 'string', description: `数据库名，默认 ${APP_DB}（应用库）` },
                sql: { type: 'string', description: '一条 SELECT 语句' },
                limit: { type: 'integer', description: '最多返回多少行，默认 100，上限 500' },
            },
            required: ['sql'],
        },
        run: (args) => runSelect(args),
    },
    {
        name: 'read_database_table',
        description: '按条件读取某张表的若干行（不想写 SQL 时用）。',
        parameters: {
            type: 'object',
            properties: {
                database: { type: 'string' },
                table: { type: 'string', description: '表名' },
                columns: { type: 'array', items: { type: 'string' }, description: '要取的列，默认取全部非大字段列' },
                where: { type: 'string', description: 'WHERE 条件（不含 WHERE 关键字），可选' },
                order_by: { type: 'string', description: '排序，如 id DESC，可选' },
                limit: { type: 'integer', description: '默认 50' },
            },
            required: ['table'],
        },
        async run(args) {
            const table = String(args.table || '').replace(/`/g, '').toLowerCase();
            if (!/^\w+$/.test(table)) return { ok: false, summary: '表名不合法', content: '表名不合法' };
            const known = SCHEMA.get(table);
            const wanted = Array.isArray(args.columns) && args.columns.length ? args.columns.map((c) => String(c).replace(/`/g, '')) : (known ? known.map((c) => c.name).filter((c) => !HEAVY_COLS.has(c)) : null);
            if (wanted && wanted.some((c) => !/^\w+$/.test(c))) return { ok: false, summary: '列名不合法', content: '列名只能是字母、数字、下划线' };
            const cols = wanted ? wanted.map((c) => `\`${c}\``).join(', ') : '*';
            const sql = `SELECT ${cols} FROM \`${table}\`${args.where ? ` WHERE ${args.where}` : ''}${args.order_by ? ` ORDER BY ${args.order_by}` : ''}`;
            return runSelect({ database: args.database, sql, limit: args.limit || 50 });
        },
    },
    {
        name: 'get_report_overview',
        description: '取最新一期（或指定 snapshot_id）报表看板入库数据的概览：总分、各分类得分、全部指标及未达标情况。回答“本月指标怎么样”“哪些没达标”这类问题时先调用它。',
        parameters: { type: 'object', properties: { snapshot_id: { type: 'string', description: '可选，默认最新一期' } } },
        async run(args) {
            const where = args.snapshot_id ? `\`snapshot_id\` = ${sqlVal(String(args.snapshot_id))}` : '';
            const snaps = await selectTable('report_snapshots', {
                columns: ['id', 'snapshot_id', 'month', 'created_at', 'standard_total_score'],
                whereSql: where,
                orderBySql: '`id` DESC',
                limit: 6,
                memFilter: args.snapshot_id ? (r) => r.snapshot_id === String(args.snapshot_id) : null,
                memSort: (a, b) => (b.id || 0) - (a.id || 0),
            });
            if (!snaps.length) return { ok: true, summary: '暂无数据', content: '报表看板还没有入库的数据。请先在「数据导入」(/sla) 导入数据并保存快照，再到「报表看板」(/report) 入库。' };
            const cur = snaps[0];
            const cond = `\`snapshot_id\` = ${sqlVal(cur.snapshot_id)}`;
            const mem = (r) => r.snapshot_id === cur.snapshot_id;
            const [cats, metrics] = await Promise.all([
                selectTable('report_category_scores', { columns: ['month', 'cat_name', 'base_score', 'manual_score', 'final_score'], whereSql: cond, limit: 500, memFilter: mem }),
                selectTable('report_metric_data', { columns: ['month', 'cat_name', 'metric_label', 'target_val', 'raw_val', 'num_val', 'is_failing', 'gap', 'earned_score', 'weight'], whereSql: cond, limit: 2000, memFilter: mem }),
            ]);
            const failing = metrics.filter((m) => Number(m.is_failing) === 1);
            const body = {
                snapshot: cur,
                recentSnapshots: snaps.slice(1).map((s) => ({ snapshot_id: s.snapshot_id, month: s.month, created_at: s.created_at, standard_total_score: s.standard_total_score })),
                categoryScores: cats,
                metricCount: metrics.length,
                failingCount: failing.length,
                failingMetrics: failing,
                otherMetrics: metrics.filter((m) => Number(m.is_failing) !== 1).slice(0, 150),
            };
            let content = JSON.stringify(body);
            if (content.length > 30_000) content = JSON.stringify({ ...body, otherMetrics: `共 ${metrics.length - failing.length} 项达标指标，已省略；需要时用 query_database 查 report_metric_data` });
            return { ok: true, summary: `${metrics.length} 项指标，${failing.length} 项未达标`, content };
        },
    },
    {
        name: 'find_platform_tools',
        description: '列出平台里有哪些功能页面、各自做什么、怎么打开。用户问“在哪里做某件事”时调用。',
        parameters: { type: 'object', properties: { query: { type: 'string', description: '可选的关键词' } } },
        async run(args, ctx) {
            const q = String(args.query || '').toLowerCase();
            const custom = (await listCustomTools(ctx.identity).catch(() => [])).map((t) => ({ id: t.slug, name: t.name, href: t.href, guide: t.description || '自定义 HTML 工具', custom: true }));
            const all = [...PLATFORM_TOOLS, ...custom];
            const hit = q ? all.filter((t) => `${t.id} ${t.name} ${t.guide}`.toLowerCase().includes(q)) : all;
            return { ok: true, summary: `${(hit.length ? hit : all).length} 个功能`, content: JSON.stringify({ tools: hit.length ? hit : all, linkHint: '给用户链接时用 Markdown：[名称](href)，href 原样使用' }) };
        },
    },
    {
        name: 'read_tool_guide',
        description: '读取平台上某个功能页面或内置工具的使用说明：能做什么、什么时候用、操作步骤、工作原理、注意事项。用户问某个工具怎么用、怎么工作时调用；tool 填工具名称或标识（可先用 find_platform_tools 找）。',
        parameters: { type: 'object', properties: { tool: { type: 'string', description: '工具名称或标识，如 数据导入、sla、reward-program' } }, required: ['tool'] },
        async run(args, ctx) {
            const ref = String(args.tool || '').trim().replace(/^\//, '').toLowerCase();
            const custom = await listCustomTools(ctx.identity).catch(() => []);
            const entries = [
                ...PLATFORM_TOOLS.map((t) => ({ key: `page:${t.href}`, id: t.id, name: t.name, href: t.href, summary: t.guide })),
                ...custom.map((t) => ({ key: `custom:${t.slug}`, id: t.slug, name: t.name, href: t.href, summary: t.description || '' })),
            ];
            const hit = entries.find((e) => [e.id, e.name, e.href.replace(/^\//, '')].some((v) => String(v).toLowerCase() === ref))
                || entries.find((e) => String(e.name).toLowerCase().includes(ref) || String(e.id).toLowerCase().includes(ref));
            if (!ref || !hit) return { ok: false, summary: '没有这个工具', content: `平台上没有找到「${args.tool}」，先用 find_platform_tools 搜一下。` };
            const guide = TOOL_GUIDES[hit.key];
            const body = guide ? `摘要：${guide.summary}\n\n${guide.guide}` : `（这个工具还没有详细说明，以下只有简介）\n${hit.summary || '无'}`;
            return { ok: true, summary: `${hit.name} 的使用说明`, content: `# ${hit.name}\n入口：${hit.href}\n\n${body}` };
        },
    },
    {
        name: 'read_skill',
        description: '读取某个技能的完整步骤。技能目录见系统提示；任务与某个技能相符时先读它再执行。',
        parameters: { type: 'object', properties: { id: { type: 'string', description: '技能标识' } }, required: ['id'] },
        async run(args) {
            const skill = await getSkill(String(args.id || '').replace(/^@/, ''));
            if (!skill) return { ok: false, summary: '技能不存在', content: `没有标识为 ${args.id} 的技能。可用技能：${(await listSkills()).map((s) => s.id).join('、')}` };
            return { ok: true, summary: skill.name, content: `# ${skill.name}（@${skill.id}）\n${skill.description}\n\n${skill.body}` };
        },
    },
    {
        name: 'save_skill',
        description: '把一份完整的 SKILL.md（含 front-matter：id、name、description）保存为技能。仅管理员可用；只有用户明确要求保存时才调用。',
        parameters: { type: 'object', properties: { skill_md: { type: 'string', description: '完整的 SKILL.md 文本' }, overwrite: { type: 'boolean', description: '同名技能是否覆盖' } }, required: ['skill_md'] },
        async run(args, ctx) {
            if (!ctx.identity.isAdmin) return { ok: false, summary: '需要管理员权限', content: '保存技能需要管理员权限。请把草稿放在 ```skill 代码块里给用户，让管理员保存。' };
            try {
                const skill = await saveSkill(String(args.skill_md || ''), { createdBy: ctx.identity.username, source: 'chat', overwrite: args.overwrite === true });
                ctx.emit({ type: 'skills_changed', ids: [skill.id] });
                return { ok: true, summary: `已保存 @${skill.id}`, content: `技能已保存：${skill.name}（@${skill.id}）。用户可以在对话里输入 @${skill.id} 调用。` };
            } catch (error) {
                return { ok: false, summary: '保存失败', content: `保存失败：${error.message}` };
            }
        },
    },
    {
        name: 'read_file',
        description: '读取用户在对话里上传的附件内容（路径形如 uploads/…，见用户消息里的附件列表）。Excel 会转成制表符分隔的文本。内容很长时用 offset 分段读。',
        parameters: { type: 'object', properties: { path: { type: 'string', description: '附件路径' }, offset: { type: 'integer', description: '从第几个字符开始，默认 0' }, limit: { type: 'integer', description: '最多读多少字符，默认 20000' } }, required: ['path'] },
        async run(args, ctx) {
            const file = await readChatUpload(String(args.path || ''), ctx.identity.username);
            if (!file) return { ok: false, summary: '文件不存在', content: '找不到这个附件（只能读取当前用户在对话里上传的文件）。' };
            const offset = Math.max(0, Number(args.offset) || 0);
            const limit = Math.max(1000, Math.min(Number(args.limit) || 20_000, 40_000));
            const slice = file.text.slice(offset, offset + limit);
            const more = offset + limit < file.text.length;
            return {
                ok: true,
                summary: `${file.name} · ${file.text.length} 字符`,
                content: `文件：${file.name}（${file.size} 字节，提取文本 ${file.text.length} 字符，本次 ${offset}–${offset + slice.length}）\n\n${slice || '（没有可读的文字内容）'}${more ? `\n\n…后面还有 ${file.text.length - offset - limit} 字符，用 offset=${offset + limit} 继续读` : ''}`,
            };
        },
    },
    {
        name: 'publish_html_tool',
        description: '把一个自包含的单页 HTML 发布为平台里的自定义工具，返回访问链接。只有用户确认要发布时才调用。HTML 必须内联全部样式和脚本；工具在沙箱里运行，不能发起任何网络请求，也拿不到登录信息。需要平台数据时在页面脚本里调用内置的只读接口：await DH.query(sql, limit) 查业务表、await DH.report() 取最新报表概览、await DH.me() 取当前用户。',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: '工具名称' },
                description: { type: 'string', description: '一句话说明' },
                icon: { type: 'string', description: '一个表情' },
                html: { type: 'string', description: '完整的 HTML 文档' },
                slug: { type: 'string', description: '更新已发布的工具时传它的标识；新建时不传' },
            },
            required: ['name', 'html'],
        },
        async run(args, ctx) {
            try {
                const tool = await saveCustomTool({ name: args.name, description: args.description, icon: args.icon, html: args.html, slug: args.slug, overwrite: Boolean(args.slug) }, ctx.identity);
                return { ok: true, summary: `已发布「${tool.name}」`, content: JSON.stringify({ published: true, name: tool.name, slug: tool.slug, href: tool.href, visibility: tool.visibility === 'public' ? '所有人可见' : '仅发布者本人可见', linkHint: `把链接给用户：[${tool.name}](${tool.href})；也可以在首页「发现应用」里找到` }) };
            } catch (error) {
                return { ok: false, summary: '发布失败', content: `发布失败：${error.message}` };
            }
        },
    },

    {
        name: 'update_plan',
        description: '任务清单：需要 3 步以上的任务，先列出步骤，之后每完成一步就更新状态（界面会显示进度）。每次传完整清单；同一时间最多一项 in_progress。简单问答不用。',
        parameters: {
            type: 'object',
            properties: { items: { type: 'array', description: '完整清单，最多 20 项', items: { type: 'object', properties: { content: { type: 'string', description: '一句话的步骤' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['content', 'status'] } } },
            required: ['items'],
        },
        silent: true,
        async run(args, ctx) {
            const items = (Array.isArray(args.items) ? args.items : []).slice(0, 20)
                .map((item) => ({ content: String(item?.content || '').trim().slice(0, 200), status: ['pending', 'in_progress', 'completed'].includes(item?.status) ? item.status : 'pending' }))
                .filter((item) => item.content);
            if (!items.length) return { ok: false, summary: '清单为空', content: 'items 不能为空' };
            if (items.filter((item) => item.status === 'in_progress').length > 1) return { ok: false, summary: '清单状态有误', content: '同一时间最多一项 in_progress，请修正后重新提交完整清单' };
            ctx.emit({ type: 'plan', items });
            const done = items.filter((item) => item.status === 'completed').length;
            return { ok: true, summary: `任务清单 ${done}/${items.length}`, content: `任务清单已更新（完成 ${done}/${items.length}）。` };
        },
    },
    {
        name: 'ask_user',
        description: '遇到必须由用户决定、无法从上下文或常识判断的问题时，向用户提一个问题并给出 2–6 个选项，本轮随即结束，等用户回复后再继续。能自己查到或有合理默认值的事不要问。',
        parameters: {
            type: 'object',
            properties: { question: { type: 'string', description: '问题，一句话' }, options: { type: 'array', items: { type: 'string' }, description: '2–6 个简短选项，推荐项放第一个' } },
            required: ['question', 'options'],
        },
        silent: true,
        async run(args, ctx) {
            const question = String(args.question || '').trim().slice(0, 500);
            const options = (Array.isArray(args.options) ? args.options : []).map((o) => String(o || '').trim().slice(0, 100)).filter(Boolean).slice(0, 6);
            if (!question || options.length < 2) return { ok: false, summary: '问题不完整', content: '需要 question 和 2–6 个 options' };
            ctx.ask({ question, options });
            return { ok: true, summary: '已向用户提问', content: '问题已发给用户，本轮到此结束，等用户回复后再继续。' };
        },
    },
    {
        name: 'calculate',
        description: '精确计算，不要心算：四则运算、乘方 ^、百分比 percent(部分,整体)、增减幅 change_percent(旧,新)、sum/avg/median/min/max、round(x,位数)；日期 days_between(a,b)、add_days(d,n)、add_months(d,n)、workdays_between(a,b)（首尾都算）、add_workdays(d,n)、weekday(d)、today()。日期写 "YYYY-MM-DD"。涉及占比、差距、同比环比时一定用它。',
        parameters: {
            type: 'object',
            properties: { expression: { type: 'string', description: '如 (1250-980)/980*100 或 workdays_between("2026-10-01","2026-10-31")' }, expressions: { type: 'array', items: { type: 'string' }, description: '一次算多个，最多 50 个' } },
        },
        async run(args) {
            const list = [...(args.expression ? [args.expression] : []), ...(Array.isArray(args.expressions) ? args.expressions : [])].map(String).slice(0, 50);
            if (!list.length) return { ok: false, summary: '缺少表达式', content: '需要 expression 或 expressions' };
            const results = list.map((expression) => {
                try { return { expression, result: evaluate(expression) }; } catch (error) { return { expression, error: error.message }; }
            });
            const failed = results.filter((r) => r.error).length;
            return { ok: failed < results.length, summary: results.length === 1 ? String(results[0].result ?? results[0].error).slice(0, 60) : `${results.length - failed}/${results.length} 个算出结果`, content: JSON.stringify(results) };
        },
    },
    {
        name: 'memory',
        description: '长期记忆：保存用户明确要求记住、或反复用到的偏好与约定（跨对话有效，已有的记忆列在系统提示里）。action=add 新增、update 修改、delete 删除（按 id）、list 列出。不要保存密码、密钥等凭据，也不要保存一次性的任务细节。',
        parameters: {
            type: 'object',
            properties: { action: { type: 'string', enum: ['add', 'update', 'delete', 'list'] }, id: { type: 'integer', description: 'update / delete 时的记忆编号' }, content: { type: 'string', description: 'add / update 时的内容，一句话' } },
            required: ['action'],
        },
        async run(args, ctx) {
            if (!ctx.identity.identified) return { ok: false, summary: '未识别用户', content: '当前访问者没有工号，无法保存个人记忆。' };
            try {
                const out = await changeMemory(ctx.identity.username, args);
                const summary = args.action === 'list' ? `${out.items.length} 条记忆` : args.action === 'delete' ? `已删除 #${out.deleted}` : `已记住 #${out.item.id}`;
                return { ok: true, summary, content: JSON.stringify(out) };
            } catch (error) {
                return { ok: false, summary: '未保存', content: error.message };
            }
        },
    },
    {
        name: 'list_uiv_scripts',
        description: '列出「数据抓取」脚本仓库里的脚本（名称、分类、目标地址）。用户问有哪些抓取脚本、某个系统的数据怎么抓时调用。',
        parameters: { type: 'object', properties: { keyword: { type: 'string', description: '按名称、地址或分类筛选，可选' } } },
        async run(args) {
            const q = String(args.keyword || '').toLowerCase();
            const [scripts, categories] = await Promise.all([listScripts(), listCategories().catch(() => [])]);
            const hit = scripts.filter((s) => !q || `${s.name} ${s.url} ${s.category}`.toLowerCase().includes(q));
            return { ok: true, summary: `${hit.length} 个脚本`, content: JSON.stringify({ total: scripts.length, categories, scripts: hit.slice(0, 100).map((s) => ({ id: s.id, name: s.name, category: s.category, url: String(s.url || '').slice(0, 200), method: s.method || '' })) }) };
        },
    },
    {
        name: 'read_uiv_script',
        description: '读取某个抓取脚本的完整内容（请求地址、方法、请求头、请求体、fetch 代码）。',
        parameters: { type: 'object', properties: { id: { type: 'string', description: '脚本 id（先用 list_uiv_scripts 查）' } }, required: ['id'] },
        async run(args) {
            const script = (await listScripts()).find((s) => String(s.id) === String(args.id));
            if (!script) return { ok: false, summary: '脚本不存在', content: `没有 id 为 ${args.id} 的脚本` };
            // 请求头里的会话凭据不给模型看
            const safe = JSON.parse(JSON.stringify(script, (k, v) => (/^(cookie|authorization|x-csrf-token|x-auth-token|token)$/i.test(k) && typeof v === 'string' ? '[已隐藏]' : v)));
            let content = JSON.stringify(safe);
            if (content.length > 20_000) content = `${content.slice(0, 20_000)}…[已截断]`;
            return { ok: true, summary: script.name, content };
        },
    },
    {
        name: 'save_uiv_script',
        description: '把一段从浏览器 F12 复制的 fetch 请求保存为「数据抓取」脚本。仅管理员可用；只有用户明确要求保存时才调用。更新已有脚本时传 id。',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: '更新已有脚本时传；新建不传' },
                name: { type: 'string', description: '脚本名称' },
                category: { type: 'string', description: '分类，默认「默认分类」' },
                url: { type: 'string', description: '请求地址' },
                method: { type: 'string', description: 'GET / POST …' },
                code: { type: 'string', description: 'fetch(...) 代码原文' },
            },
            required: ['name', 'url'],
        },
        async run(args, ctx) {
            if (!ctx.identity.isAdmin) return { ok: false, summary: '需要管理员权限', content: '保存抓取脚本需要管理员权限。可以把脚本内容给用户，请管理员在「数据抓取」页面保存。' };
            if (!/^https?:\/\//i.test(String(args.url || ''))) return { ok: false, summary: '地址不合法', content: 'url 需要是 http(s) 地址' };
            const before = new Set((await listScripts()).map((s) => String(s.id)));
            const all = await saveScripts([{ ...(args.id ? { id: String(args.id) } : {}), name: String(args.name).slice(0, 120), category: args.category, url: String(args.url), method: String(args.method || 'GET').toUpperCase(), code: String(args.code || '').slice(0, 60_000), source: 'chat', createdBy: ctx.identity.username }]);
            const saved = args.id ? all.find((s) => String(s.id) === String(args.id)) : all.find((s) => !before.has(String(s.id)));
            return { ok: true, summary: `已保存「${args.name}」`, content: JSON.stringify({ saved: true, id: saved?.id, name: args.name, linkHint: '可在 [数据抓取](/uivf12) 页面查看和运行' }) };
        },
    },

// ── 看图与表格分析 ──
    {
        name: 'view_image',
        description: '看一张用户在对话里上传的图片（png / jpg / webp / gif，路径形如 uploads/…）。图片会附在下一条消息里给你看；question 写你想从图里了解什么。当前模型不支持看图时会告诉你。',
        parameters: { type: 'object', properties: { path: { type: 'string', description: '附件路径' }, question: { type: 'string', description: '想从图里了解什么（可选）' } }, required: ['path'] },
        async run(args, ctx) {
            const file = await readChatUpload(String(args.path || ''), ctx.identity.username, { withData: true });
            if (!file || !file.buffer) return { ok: false, summary: '文件不存在', content: '找不到这个附件（只能读取当前用户在对话里上传的文件）。' };
            const mimeType = imageMime(file.name, file.mimeType);
            if (!mimeType) return { ok: false, summary: '不是图片', content: `${file.name} 不是 png / jpg / webp / gif 图片，请用 read_file 或 query_data 读取。` };
            if (file.buffer.length > MAX_IMAGE_BYTES) return { ok: false, summary: '图片太大', content: `图片 ${Math.round(file.buffer.length / 1024)}KB，超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB，请让用户截一张小一点的图。` };
            ctx.attachImage({ name: file.name, mimeType, base64: file.buffer.toString('base64') });
            return { ok: true, summary: file.name, content: `图片「${file.name}」已附在下一条消息里，请直接查看。` };
        },
    },
    {
        name: 'query_data',
        description: '分析用户上传的 Excel / CSV 附件：在服务端筛选、分组、聚合，只返回结果，适合上千行的大表。先不带条件调用一次看各列的情况（列名、类型、取值分布、样例行），再按需查询。条件 op 支持 = != > >= < <= contains not_contains starts_with in not_in empty not_empty；聚合 fn 支持 count count_non_empty count_distinct sum avg min max。百分比按数字比较（91.2% 记作 91.2）。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '附件路径（uploads/…）' },
                sheet: { type: 'string', description: '工作表名，默认第一个有数据的' },
                select: { type: 'array', items: { type: 'string' }, description: '要返回的列（不分组时）' },
                where: { type: 'array', description: '筛选条件，全部满足', items: { type: 'object', properties: { column: { type: 'string' }, op: { type: 'string' }, value: {} }, required: ['column', 'op'] } },
                group_by: { type: 'array', items: { type: 'string' }, description: '分组列' },
                aggregates: { type: 'array', description: '聚合', items: { type: 'object', properties: { fn: { type: 'string' }, column: { type: 'string' }, as: { type: 'string' } }, required: ['fn'] } },
                order_by: { type: 'array', description: '排序', items: { type: 'object', properties: { column: { type: 'string' }, desc: { type: 'boolean' } }, required: ['column'] } },
                limit: { type: 'integer', description: '最多返回多少行，默认 50，上限 500' },
                offset: { type: 'integer', description: '从第几行开始（翻页）' },
                describe: { type: 'boolean', description: 'true 时返回各列概况' },
            },
            required: ['path'],
        },
        async run(args, ctx) {
            const file = await readChatUpload(String(args.path || ''), ctx.identity.username, { withData: true });
            if (!file || !file.buffer) return { ok: false, summary: '文件不存在', content: '找不到这个附件（只能读取当前用户在对话里上传的文件）。' };
            try {
                const sheets = await loadTables(file);
                const out = runQuery(sheets, args);
                let content = JSON.stringify(out);
                if (content.length > 28_000) content = JSON.stringify({ ...out, rows: out.rows?.slice(0, 40), note: '结果太长，只保留前 40 行；请加条件或改成聚合' });
                const summary = out.mode === 'describe' ? `${out.rowCount} 行 × ${out.columns.length} 列` : `${out.resultRows} 行结果`;
                return { ok: true, summary, content };
            } catch (error) {
                return { ok: false, summary: '查询失败', content: `表格查询失败：${error.message}` };
            }
        },
    },

    // ── 写操作（仅管理员，执行前需要用户在对话里确认）──
    {
        name: 'insert_database_row',
        description: `往应用库的业务表插入一行。仅管理员可用，执行前会请用户确认。可写的表：${[...WRITABLE].join('、')}。`,
        parameters: { type: 'object', properties: { table: { type: 'string' }, values: { type: 'object', description: '列名 → 值' } }, required: ['table', 'values'] },
        kind: 'write',
        async approval(args, ctx) {
            const t = checkWritable(args.table, ctx);
            if (t.error) return t;
            const cols = checkColumns(t.table, args.values);
            if (cols.error) return cols;
            return { preview: { title: `向 ${t.table} 插入 1 行`, impact: '新增数据', fields: Object.entries(args.values).map(([k, v]) => ({ label: k, value: shortValue(v) })) } };
        },
        async run(args) {
            const n = await insertRow(String(args.table).toLowerCase(), args.values);
            return { ok: true, summary: `已插入 ${n} 行`, content: `已向 ${args.table} 插入 ${n} 行。` };
        },
    },
    {
        name: 'update_database_rows',
        description: `修改应用库业务表里符合条件的行。必须带 where 条件，一次最多影响 ${MAX_WRITE_ROWS} 行。仅管理员可用，执行前会请用户确认（会显示将影响多少行）。可写的表：${[...WRITABLE].join('、')}。`,
        parameters: { type: 'object', properties: { table: { type: 'string' }, values: { type: 'object', description: '要改成的值：列名 → 值' }, where: { type: 'string', description: 'WHERE 条件（不含 WHERE 关键字），如 id = 12' } }, required: ['table', 'values', 'where'] },
        kind: 'write',
        async approval(args, ctx) {
            const t = checkWritable(args.table, ctx);
            if (t.error) return t;
            const cols = checkColumns(t.table, args.values);
            if (cols.error) return cols;
            const n = await countWhere(t.table, args.where);
            if (n.error) return n;
            return { preview: { title: `修改 ${t.table} 中 ${n.count} 行`, impact: `条件：${args.where}`, fields: Object.entries(args.values).map(([k, v]) => ({ label: k, value: `→ ${shortValue(v)}` })) }, count: n.count };
        },
        async run(args) {
            const n = await updateRows(String(args.table).toLowerCase(), args.values, { whereSql: args.where });
            return { ok: true, summary: `已修改 ${n} 行`, content: `已修改 ${args.table} 中 ${n} 行。` };
        },
    },
    {
        name: 'delete_database_rows',
        description: `删除应用库业务表里符合条件的行。必须带 where 条件，一次最多 ${MAX_WRITE_ROWS} 行。仅管理员可用，执行前会请用户确认。可写的表：${[...WRITABLE].join('、')}。`,
        parameters: { type: 'object', properties: { table: { type: 'string' }, where: { type: 'string', description: 'WHERE 条件（不含 WHERE 关键字）' } }, required: ['table', 'where'] },
        kind: 'destructive',
        async approval(args, ctx) {
            const t = checkWritable(args.table, ctx);
            if (t.error) return t;
            const n = await countWhere(t.table, args.where);
            if (n.error) return n;
            if (!n.count) return { error: '没有符合条件的行，不需要删除' };
            return { preview: { title: `删除 ${t.table} 中 ${n.count} 行`, impact: `条件：${args.where}（不可恢复）`, fields: [] }, count: n.count };
        },
        async run(args) {
            const n = await deleteRows(String(args.table).toLowerCase(), { whereSql: args.where });
            return { ok: true, summary: `已删除 ${n} 行`, content: `已删除 ${args.table} 中 ${n} 行。` };
        },
    },
    {
        name: 'send_notification',
        description: '通过基座通知接口发送邮件提醒（例如未达标指标催办）。仅管理员可用，执行前会请用户确认收件人和内容。收件人写邮箱地址；只有用户明确要求发送时才调用。',
        parameters: {
            type: 'object',
            properties: { to: { type: 'array', items: { type: 'string' }, description: '收件人邮箱，最多 50 个' }, title: { type: 'string' }, content: { type: 'string', description: '正文（纯文本）' } },
            required: ['to', 'title', 'content'],
        },
        kind: 'external',
        async approval(args, ctx) {
            if (!ctx.identity.isAdmin) return { error: '发送通知需要管理员权限' };
            const to = normalizeRecipients(args.to);
            if (!to.length) return { error: '收件人为空或格式不对（需要邮箱地址）' };
            if (to.length > 50) return { error: '一次最多发给 50 人' };
            if (!String(args.title || '').trim() || !String(args.content || '').trim()) return { error: '标题和正文都不能为空' };
            return { preview: { channel: '基座邮件通知', targets: to.map((x) => x.replace(/^email:/, '')).join('、'), message: `${String(args.title).slice(0, 200)}\n\n${String(args.content).slice(0, 4000)}` } };
        },
        async run(args) {
            const to = normalizeRecipients(args.to);
            const res = await sendExpediteNotification({ recipients: to, title: String(args.title).slice(0, 200), content: String(args.content).slice(0, 4000) });
            const delivered = res?.baseResult?.code === 0 || res?.baseResult?.data?.success;
            return { ok: Boolean(delivered), summary: delivered ? `已发送给 ${to.length} 人` : '发送失败', content: delivered ? `已通过基座通知发送给 ${to.length} 人。` : `基座通知接口返回：${JSON.stringify(res?.baseResult || {}).slice(0, 300)}` };
        },
    },
    {
        name: 'move_uiv_script',
        description: '把数据抓取脚本移到另一个分类。仅管理员可用。',
        parameters: { type: 'object', properties: { id: { type: 'string' }, category: { type: 'string' } }, required: ['id', 'category'] },
        kind: 'write',
        async approval(args, ctx) {
            if (!ctx.identity.isAdmin) return { error: '管理抓取脚本需要管理员权限' };
            const script = (await listScripts()).find((x) => String(x.id) === String(args.id));
            if (!script) return { error: `没有 id 为 ${args.id} 的脚本` };
            return { preview: { title: `移动脚本「${script.name}」`, impact: `${script.category} → ${args.category}`, fields: [] } };
        },
        async run(args) {
            await moveScriptCategory(String(args.id), String(args.category).slice(0, 60));
            return { ok: true, summary: `已移到「${args.category}」`, content: `已把脚本移到分类「${args.category}」。` };
        },
    },
    {
        name: 'delete_uiv_script',
        description: '删除一个数据抓取脚本。仅管理员可用，执行前会请用户确认。',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        kind: 'destructive',
        async approval(args, ctx) {
            if (!ctx.identity.isAdmin) return { error: '管理抓取脚本需要管理员权限' };
            const script = (await listScripts()).find((x) => String(x.id) === String(args.id));
            if (!script) return { error: `没有 id 为 ${args.id} 的脚本` };
            return { preview: { title: `删除脚本「${script.name}」`, impact: `分类：${script.category}（不可恢复）`, fields: [] } };
        },
        async run(args) {
            await deleteScript(String(args.id));
            return { ok: true, summary: '已删除', content: '脚本已删除。' };
        },
    },
    ...NETCARE_TOOLS,
    ...FOLLOWUP_TOOLS,
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
