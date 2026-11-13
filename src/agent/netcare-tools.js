// NetCare 数据探查工具：在平台授权的业务数据源上找表、看字段、做只读查询。
// 与主线版 models/digital-human/netcare-agent.js 的四个工具同名同参数；区别是这里只查业务库（本应用自己的表用 query_database），
// 也不提供写操作。业务数据源没授权时工具仍然列出，调用时给出明确说明。
import * as catalog from '../services/netcare/table-catalog.js';
import { queryAll, netcareConfig } from '../services/netcare/base-adapter.js';

const RESULT_CHARS = 24 * 1024;
const MAX_MODEL_ROWS = 500;
const clampInt = (value, min, max, fallback) => {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

// 结果按字符预算截断：先保证前几行，超出时注明还有多少行没给模型
function rowsText(rows, { sql, truncated } = {}) {
    const lines = [];
    if (sql) lines.push(`SQL: ${sql}`);
    lines.push(`共 ${rows.length} 行${truncated ? '（已达上限，结果被截断）' : ''}`);
    let used = lines.join('\n').length;
    let shown = 0;
    for (const row of rows) {
        const line = JSON.stringify(row);
        if (used + line.length + 1 > RESULT_CHARS) break;
        lines.push(line);
        used += line.length + 1;
        shown += 1;
    }
    if (shown < rows.length) lines.push(`…另有 ${rows.length - shown} 行未展示（结果过长），请缩小范围或改用聚合`);
    return lines.join('\n');
}

async function findTables(args) {
    const result = await catalog.listTables({ scope: 'business' });
    const words = String(args.keyword || '').toLowerCase().split(/\s+/).filter(Boolean);
    const category = String(args.category || '').trim();
    const onlyWithData = args.onlyWithData !== false;
    const limit = clampInt(args.limit, 1, 120, 40);
    const matched = result.tables.filter((table) => {
        if (table.hidden) return false;
        if (onlyWithData && (table.empty || table.status === 'missing')) return false;
        if (category && !table.category.includes(category)) return false;
        if (!words.length) return true;
        const text = `${table.name} ${table.nameCn} ${table.module} ${table.category} ${table.description}`.toLowerCase();
        return words.some((word) => text.includes(word));
    }).sort((a, b) => Number(b.verified) - Number(a.verified) || Number(Boolean(b.nameCn)) - Number(Boolean(a.nameCn)) || b.rows - a.rows);
    const lines = [
        `${result.live ? `实时目录（${result.schema}）` : `业务库暂时读不到，以下是全表盘点时的清单（${result.error || ''}），行数可能已过时`}：匹配 ${matched.length} 张${matched.length > limit ? `，显示前 ${limit} 张` : ''}`,
        '表名 | 中文名 | 模块 | 类别 | 粒度 | 估算行数 | 已核对 | 说明',
    ];
    for (const table of matched.slice(0, limit)) {
        lines.push([table.name, table.nameCn || '-', table.module || '-', table.category || '-', table.grain || '-', table.rows, table.verified ? '是' : '否', (table.description || table.review || '').slice(0, 80) || '-'].join(' | ')
            + (table.family ? `（分区族 ${table.family}）` : ''));
    }
    return { content: lines.join('\n'), summary: `找到 ${matched.length} 张表` };
}

async function describe(args) {
    const detail = await catalog.describeTable('business', String(args.table || ''), { sampleRows: clampInt(args.sampleRows, 0, 20, 5) });
    const note = detail.note || {};
    const nameCn = note.nameCn || detail.seed?.nameCn;
    const lines = [`表 ${detail.schema}.${detail.name}${nameCn ? `（${nameCn}）` : ''}，${detail.columns.length} 个字段`];
    if (note.description) lines.push(`标注说明：${note.description}`);
    if (note.timeField || note.regionField || note.officeField) lines.push(`标注字段：时间=${note.timeField || '-'}，地区部=${note.regionField || '-'}，代表处=${note.officeField || '-'}${note.verified ? '（已核对）' : ''}`);
    else lines.push(`建议字段：时间=${detail.suggestions.timeField || '-'}，地区部=${detail.suggestions.regionField || '-'}，代表处=${detail.suggestions.officeField || '-'}`);
    if (detail.hints.length) lines.push(`提示：${detail.hints.join('；')}`);
    lines.push('字段 | 类型 | 注释 | 识别 | 形态 | 占位值 | 示例');
    for (const column of detail.columns) {
        lines.push([column.name, column.columnType || column.dataType, column.comment || '-', column.role || '-', column.kinds.join('/') || '-', column.sentinels.join('/') || '-', column.examples.join(' ; ').slice(0, 120) || '-'].join(' | '));
    }
    if (detail.sample.length) {
        lines.push(`样例 ${detail.sample.length} 行：`);
        for (const row of detail.sample) lines.push(JSON.stringify(row).slice(0, 1500));
    }
    let content = lines.join('\n');
    if (content.length > RESULT_CHARS) content = `${content.slice(0, RESULT_CHARS)}\n…（已截断）`;
    return { content, summary: `${detail.name}：${detail.columns.length} 个字段` };
}

async function query(args) {
    const result = await catalog.queryTable('business', { ...args, limit: clampInt(args.limit, 1, MAX_MODEL_ROWS, 100) });
    return { content: rowsText(result.rows, result), summary: `${args.table}：${result.rows.length} 行`, output: result.sql };
}

async function sql(args) {
    const result = await queryAll(args.sql, { scope: 'business', maxRows: clampInt(args.maxRows, 1, MAX_MODEL_ROWS, 200) });
    const text = String(args.sql).slice(0, 600);
    return { content: rowsText(result.rows, { sql: text, truncated: result.truncated }), summary: `SQL：${result.rows.length} 行`, output: text };
}

// 统一的出错口径：把错误码和原因交给模型，由它向用户说明
const guarded = (handler) => async (args) => {
    try {
        const out = await handler(args && typeof args === 'object' ? args : {});
        return { ok: true, ...out };
    } catch (error) {
        const message = String(error?.message || error);
        return { ok: false, summary: message.slice(0, 60), content: `错误（${error?.code || 'ERROR'}）：${message}` };
    }
};

export const NETCARE_TOOLS = [
    {
        name: 'netcare_tables',
        description: '在 NetCare 业务库的表目录里找表：返回表名、中文名、模块、类别、粒度、估算行数、是否已核对、标注说明。关键词匹配表名 / 中文名 / 模块 / 说明。回答 NetCare 业务数据（风险、整改、工单、网络、License 等）的问题时先用它找表。',
        parameters: {
            type: 'object',
            properties: {
                keyword: { type: 'string', description: '关键词，如 风险、license、rectify、整改；可空格分隔多个（任一命中）' },
                category: { type: 'string', description: '类别，如 风险、整改、任务/工单、网络、IOC运营' },
                onlyWithData: { type: 'boolean', description: '只看有数据的表，默认 true' },
                limit: { type: 'integer', description: '最多返回条数，默认 40，上限 120' },
            },
        },
        run: guarded(findTables),
    },
    {
        name: 'netcare_describe',
        description: '查看 NetCare 一张表的字段（名称、类型、注释、识别出的时间 / 地区部 / 代表处字段、取值形态、占位值）、标注、取数提示和几行样例。查询前先看字段，不要猜列名。',
        parameters: {
            type: 'object',
            properties: { table: { type: 'string', description: '表名（不带库名）' }, sampleRows: { type: 'integer', description: '样例行数，默认 5，上限 20' } },
            required: ['table'],
        },
        run: guarded(describe),
    },
    {
        name: 'netcare_query',
        description: '对 NetCare 的一张表做结构化只读查询：选择字段、AND 过滤、分组、聚合（count/count_distinct/sum/avg/min/max）、排序、限制行数。字段名必须是真实字段。统计请用 metrics + groupBy 在库里聚合。',
        parameters: {
            type: 'object',
            properties: {
                table: { type: 'string', description: '表名（不带库名）' },
                columns: { type: 'array', items: { type: 'string' }, description: '返回字段；有分组 / 聚合时忽略' },
                filters: {
                    type: 'array',
                    description: '过滤条件（AND）',
                    items: {
                        type: 'object',
                        properties: {
                            column: { type: 'string' },
                            op: { type: 'string', enum: ['=', '!=', '>', '>=', '<', '<=', 'like', 'not like', 'in', 'not in', 'between', 'is null', 'is not null'] },
                            value: { description: '值；in/not in 传数组；between 传 [起, 止]；like 用 % 通配' },
                        },
                        required: ['column', 'op'],
                    },
                },
                groupBy: { type: 'array', items: { type: 'string' }, description: '分组字段' },
                metrics: {
                    type: 'array',
                    description: '聚合',
                    items: {
                        type: 'object',
                        properties: {
                            agg: { type: 'string', enum: ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'] },
                            column: { type: 'string', description: 'count 可省略（COUNT(*)）' },
                            as: { type: 'string', description: '结果列名' },
                        },
                        required: ['agg'],
                    },
                },
                orderBy: { type: 'string', description: '排序字段或聚合别名' },
                order: { type: 'string', enum: ['asc', 'desc'] },
                limit: { type: 'integer', description: `返回行数，默认 100，上限 ${MAX_MODEL_ROWS}` },
            },
            required: ['table'],
        },
        run: guarded(query),
    },
    {
        name: 'netcare_sql',
        description: `在 NetCare 业务库上执行一条只读 SQL（SELECT / WITH），用于结构化查询表达不了的关联和子查询。表名写 ${netcareConfig().businessSchema}.表名。优先用聚合，不要把大量明细取回来。`,
        parameters: {
            type: 'object',
            properties: { sql: { type: 'string', description: '单条 SELECT 语句' }, maxRows: { type: 'integer', description: `最多返回行数，默认 200，上限 ${MAX_MODEL_ROWS}` } },
            required: ['sql'],
        },
        run: guarded(sql),
    },
];
