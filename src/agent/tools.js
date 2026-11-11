// 智能体工具集（精简版）：查库、平台数据、技能、附件、HTML 工具发布。
// 每个工具：{ name, description, parameters(JSON Schema), run(args, ctx) → { ok, summary, content, output? } }
//   content 给模型看；summary 是界面上工具行的一句话结果；output 是界面上可展开的详情。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, config } from '../config.js';
import { scopedQuery, selectTable, businessQuery, hasBusinessDatasource, sqlVal, isMemoryMode } from '../dao/scoped.js';
import { listSkills, getSkill, saveSkill } from '../services/skill-service.js';
import { saveCustomTool, listCustomTools } from '../services/custom-tool-service.js';
import { readChatUpload } from '../services/chat-upload-service.js';

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

async function runSelect({ database, sql, limit }) {
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

const PLATFORM_TOOLS = [
    { id: 'uivf12', name: '数据抓取', href: '/uivf12', guide: '管理从业务系统页面抓数的脚本：把浏览器 F12 里复制的 fetch 代码粘贴进来解析、命名、分类；可生成 UI.Vision 宏。抓到的数据可一键送到「数据导入」。' },
    { id: 'sla', name: '数据导入', href: '/sla', guide: '上传 Excel/CSV（支持批量，或指定整改/常规/专项/SR/漏洞类别），页面内配置指标规则和目标，点击「保存当前指标数据」生成快照；可导出裕湘模板。' },
    { id: 'report', name: '报表看板', href: '/report', guide: '选择快照入库，查看各分类得分、未达标指标和趋势；支持手工校准并上传佐证附件。入库后的数据供大屏、催办、月报和 AI 对话使用。' },
    { id: 'expedite', name: '一键催办', href: '/expedite', guide: '按最新入库数据列出未达标/超期事项，按责任人分组生成催办内容，可通过基座通知发送。' },
    { id: 'monthly', name: '月报页面', href: '/monthly', guide: 'AI 月报编辑器：按模板生成月报，每个单元格可与 AI 对话改写、生成图表；经典月报在 /monthly/legacy，可导出 .msg 邮件。' },
    { id: 'bigscreen', name: '大屏看板', href: '/bigscreen', guide: '会议室大屏：责任人矩阵、趋势与告警指标，数据来自报表看板的入库结果。' },
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
        description: '把一个自包含的单页 HTML 发布为平台里的自定义工具，返回访问链接。只有用户确认要发布时才调用。HTML 必须内联全部样式和脚本，不依赖外部资源；工具在沙箱里运行，不能访问平台接口和登录信息。',
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
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
