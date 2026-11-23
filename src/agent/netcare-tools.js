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

// 表字典（数据治理页导入的中文名、看板、字段中文名）和来源标识；读不到时退回只用目录
const dataDict = () => import('../services/data-dictionary-service.js');
// 数据源问题（空表 / 库里没有 / 查询失败，数据治理里跟踪）：默认不用这些表回答，只告诉用户数据源还没就绪
const dataIssues = () => import('../services/data-issue-service.js');
async function issueState() {
    try {
        const mod = await dataIssues();
        const [blocked, all] = await Promise.all([mod.chatIssueMap(), mod.chatIssueMap({ annotate: true })]);
        return { blocked, all, sentence: mod.issueSentence };
    } catch { return { blocked: new Map(), all: new Map(), sentence: () => '' }; }
}
function altText(info) {
    return info?.alternative ? `；可改用 ${info.alternative.table}（${info.alternative.note}）` : '';
}
function blockedError(table, issue, sentence, info) {
    return Object.assign(new Error(`表 ${table} 目前有数据源问题：${sentence(issue)}。数据治理里正在跟踪，对话里暂不使用它回答；请如实告诉用户这张表的数据源还没就绪${altText(info)}，不要编数据。需要指路时说「数据探索 → 数据治理 → 数据源问题」，不要编造页面链接。`), { code: 'DATA_SOURCE_ISSUE' });
}
async function dictIndex() {
    try { return await (await dataDict()).chatTableIndex(); } catch { return new Map(); }
}
const ORIGIN_TEXT = { netcare: 'NetCare', datafab: 'DataFab' };
const originText = (info) => [ORIGIN_TEXT[info?.origin], info?.reprocess ? '二次加工' : ''].filter(Boolean).join('·');

// 关键词匹配：原词子串命中算满分；中文词再拆成两字片段，命中过半算近似（「整改超期」也能找到「整改…超期任务」）
const CJK = /[㐀-鿿]/;
function wordScore(text, word) {
    if (!word) return 0;
    if (text.includes(word)) return 1;
    if (!CJK.test(word) || word.length < 3) return 0;
    const grams = [];
    for (let i = 0; i < word.length - 1; i += 1) grams.push(word.slice(i, i + 2));
    const ratio = grams.filter((g) => text.includes(g)).length / grams.length;
    return ratio >= 0.5 ? ratio * 0.8 : 0;
}
function keywordsOf(value) {
    return String(value || '').toLowerCase().split(/[\s,，、;；|/]+/).filter(Boolean);
}
/** 多个关键词任一命中即可；主名称（表名 / 中文名）命中加权 */
function matchScore(words, primary, secondary) {
    let score = 0;
    for (const word of words) score += Math.max(wordScore(primary, word) * 1.5, wordScore(secondary, word));
    return score;
}

async function findTables(args) {
    const [result, index, issues] = await Promise.all([catalog.listTables({ scope: 'business' }), dictIndex(), issueState()]);
    const words = keywordsOf(args.keyword);
    const category = String(args.category || '').trim();
    const onlyWithData = args.onlyWithData !== false;
    const limit = clampInt(args.limit, 1, 120, 40);
    const scored = [];
    for (const table of result.tables) {
        if (table.hidden) continue;
        if (onlyWithData && (table.empty || table.status === 'missing')) continue;
        const info = index.get(table.name.toLowerCase()) || null;
        const d = info?.entry || null;
        const view = {
            ...table,
            nameCn: table.nameCn || d?.nameCn || '',
            module: table.module || d?.subCategory || '',
            category: d?.category && !table.category ? d.category : table.category,
            board: d?.category || '',
            description: table.description || d?.description || '',
            origin: originText(info),
            boards: info?.boards || [],
        };
        if (category && ![view.category, view.board, d?.subCategory].some((v) => String(v || '').includes(category))) continue;
        let score = 1;
        if (words.length) {
            const primary = `${table.name} ${view.nameCn} ${d?.nameEn || ''}`.toLowerCase();
            const secondary = [table.module, table.category, view.description, table.review, table.seedNote, d?.category, d?.subCategory, d?.layer, d?.upstream, view.origin,
                ...view.boards.map((b) => b.title), ...(d?.columns || []).flatMap((c) => [c.name, c.nameCn])].join(' ').toLowerCase();
            score = matchScore(words, primary, secondary);
            if (!score) continue;
        }
        scored.push({ view, score });
    }
    scored.sort((a, b) => b.score - a.score || Number(b.view.verified) - Number(a.view.verified) || Number(Boolean(b.view.nameCn)) - Number(Boolean(a.view.nameCn)) || b.view.rows - a.view.rows);
    const lines = [
        `${result.live ? `实时目录（${result.schema || '数据源当前库'}）` : `业务库暂时读不到，以下是全表盘点时的清单（${result.error || ''}），行数可能已过时`}：匹配 ${scored.length} 张${scored.length > limit ? `，显示前 ${limit} 张` : ''}`,
        '表名 | 中文名 | 来源 | 模块 | 类别 / 看板 | 粒度 | 估算行数 | 已核对 | 说明',
    ];
    for (const { view: table } of scored.slice(0, limit)) {
        lines.push([table.name, table.nameCn || '-', table.origin || '-', table.module || '-', [table.category, table.board].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' / ') || '-', table.grain || '-', table.rows, table.verified ? '是' : '否', (table.description || table.review || '').slice(0, 80) || '-'].join(' | ')
            + (table.family ? `（分区族 ${table.family}）` : '')
            + (table.boards.length ? `（看板指标 ${table.boards.length} 个已算好，如 ${table.boards.slice(0, 2).map((b) => b.title).join('、')}，可用 netcare_boards 直接取）` : '')
            + (issues.all.has(table.name.toLowerCase()) ? `（⚠ 数据源问题：${issues.sentence(issues.all.get(table.name.toLowerCase()))}${issues.blocked.size ? '，暂不用于回答' : ''}${altText(index.get(table.name.toLowerCase()))}）` : ''));
    }
    // 和关键词相关、但因数据源问题没列出来的表：告诉模型原因，让它如实回复用户
    if (words.length && issues.all.size) {
        const shown = new Set(scored.slice(0, limit).map(({ view }) => view.name.toLowerCase()));
        const hidden = [...issues.all.values()].filter((i) => !shown.has(i.key)).filter((i) => {
            const d = index.get(i.key)?.entry;
            const text = `${i.table} ${i.nameCn || ''} ${d?.nameCn || ''} ${d?.nameEn || ''}`.toLowerCase();
            const more = `${i.board || ''} ${d?.description || ''} ${(index.get(i.key)?.boards || []).map((b) => b.title).join(' ')}`.toLowerCase();
            return matchScore(words, text, more) > 0;
        });
        if (hidden.length) {
            lines.push('', `以下相关表目前有数据源问题（「数据探索 → 数据治理 → 数据源问题」里在跟踪；回复里照这个说法指路，不要编造链接），${issues.blocked.size ? '暂不用于回答，请如实告诉用户数据源还没就绪' : '查询结果可能为空'}：`);
            for (const i of hidden.slice(0, 12)) lines.push(`- ${i.table}（${[ORIGIN_TEXT[i.origin], i.board].filter(Boolean).join('·')}）：${issues.sentence(i)}${altText(index.get(i.key))}`);
        }
    }
    // 关键词也对一下看板指标：问的是看板上的数时，直接给出可读取的指标
    if (words.length) {
        const boards = await matchBoards(words, 6).catch(() => []);
        if (boards.length) {
            lines.push('', `相关看板指标（结果已按看板 SQL 算好，用 netcare_boards 传 board 读取）：`);
            for (const b of boards) {
                const bad = b.sources.filter((k) => issues.all.has(String(k).toLowerCase()));
                lines.push(`- ${b.id} | ${b.title} | ${b.rowCount ?? '-'} 行 | 源表 ${b.sources.join(',')}${bad.length ? `（⚠ 源表 ${bad.join('、')} 有数据源问题，结果可能为空）` : ''}`);
            }
        }
    }
    return { content: lines.join('\n'), summary: `找到 ${scored.length} 张表` };
}

/** 系统提示词里的业务表速查：中文叫法 / 看板 → 表名（只列带来源标识的表），让模型知道这些说法指的是业务库 */
export async function businessTableHints(max = 60) {
    const index = await dictIndex();
    const items = [];
    for (const [key, info] of index) {
        if (!info.origin) continue;
        const d = info.entry || {};
        const label = [d.nameCn, d.category && d.category !== d.nameCn ? d.category : ''].filter(Boolean).join('/');
        items.push(`${d.key || key}${label ? `=${label}` : ''}`);
        if (items.length >= max) break;
    }
    return items.join('；');
}

// ── 看板指标：数据治理里的派生表（看板 SQL 按源表变化联动重算，结果存在应用库） ──
async function matchBoards(words, limit) {
    const { listDerived, boardTitle } = await dataDict();
    const defs = await listDerived();
    return defs.map((d) => {
        const title = boardTitle(d);
        const score = words.length ? matchScore(words, `${title} ${d.name}`.toLowerCase(), `${d.description || ''} ${d.sources.join(' ')} ${(d.columnsSeen || []).join(' ')}`.toLowerCase()) : 1;
        return { ...d, title, score };
    }).filter((d) => d.score > 0).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}

async function boards(args) {
    const mod = await dataDict();
    const target = String(args.board || '').trim();
    if (!target) {
        const list = await matchBoards(keywordsOf(args.keyword), clampInt(args.limit, 1, 200, 60));
        if (!list.length) return { content: args.keyword ? `没有和「${args.keyword}」相关的看板指标。可以换个说法，或用 netcare_tables 找源表直接查。` : '还没有看板指标（数据探索 → 数据治理 → 派生表 里导入看板 SQL 后就有）。', summary: '0 个看板指标' };
        const lines = [`看板指标 ${list.length} 个（board 传第一列的标识读取结果）：`, '标识 | 看板--指标 | 行数 | 状态 | 最近计算 | 源表'];
        const issues = await issueState();
        for (const d of list) {
            const bad = d.sources.filter((k) => issues.all.has(String(k).toLowerCase()));
            lines.push([d.id, d.title, d.rowCount ?? '-', bad.length ? `源表数据源问题（${bad.join('、')}）` : d.status === 'error' ? `计算失败：${String(d.lastError || '').slice(0, 60)}` : d.status || '未计算', d.lastRunAt || '-', d.sources.join(',')].join(' | '));
        }
        return { content: lines.join('\n'), summary: `${list.length} 个看板指标` };
    }
    const defs = await mod.listDerived();
    const lower = target.toLowerCase();
    let def = defs.find((d) => d.id === target || d.name.toLowerCase() === lower || mod.boardTitle(d) === target || d.nameCn === target);
    if (!def) {
        const best = await matchBoards(keywordsOf(target), 5);
        if (best.length === 1 || (best.length > 1 && best[0].score > best[1].score)) def = best[0];
        else if (best.length) return { ok: false, summary: '看板指标不唯一', content: `「${target}」对上多个看板指标，请用标识指定：\n${best.map((d) => `- ${d.id} | ${d.title}`).join('\n')}` };
        else throw Object.assign(new Error(`没有找到看板指标「${target}」，先不带 board 调用 netcare_boards 看清单`), { code: 'NOT_FOUND' });
    }
    {
        const issues = await issueState();
        const bad = def.sources.map((k) => issues.blocked.get(String(k).toLowerCase())).filter(Boolean);
        if (bad.length) throw Object.assign(new Error(`看板指标「${mod.boardTitle(def)}」的源表有数据源问题：${bad.map((i) => `${i.table} ${issues.sentence(i)}`).join('；')}。结果不可信，对话里暂不使用；请如实告诉用户数据源还没就绪，不要编数据。`), { code: 'DATA_SOURCE_ISSUE' });
    }
    if (!def.status || def.status === 'pending' || def.rowCount == null) def = await mod.refreshDerived(def.id, { reason: '对话里首次读取' });
    if (def.status === 'error') throw Object.assign(new Error(`看板指标「${mod.boardTitle(def)}」计算失败：${def.lastError}`), { code: 'BOARD_ERROR' });
    const data = await mod.derivedData(def.id, { limit: clampInt(args.limit, 1, MAX_MODEL_ROWS, 100), offset: clampInt(args.offset, 0, 100000, 0) });
    const head = [
        `看板指标：${mod.boardTitle(def)}（${def.id}），共 ${data.total} 行${data.truncated ? '（计算时已达行数上限）' : ''}，最近计算 ${data.refreshedAt || def.lastRunAt || '-'}`,
        `源表：${def.sources.join(', ')}；源表数据变化后会自动重算。口径（看板 SQL）：${String(def.sourceSql || def.sql).replace(/\s+/g, ' ').slice(0, 600)}`,
    ];
    const body = rowsText(data.rows, { truncated: data.rows.length < data.total });
    return { content: `${head.join('\n')}\n${body}`, summary: `${mod.boardTitle(def)}：${data.rows.length}/${data.total} 行`, output: def.id };
}

async function describe(args) {
    const detail = await catalog.describeTable('business', String(args.table || ''), { sampleRows: clampInt(args.sampleRows, 0, 20, 5) });
    const note = detail.note || {};
    const info = (await dictIndex()).get(String(detail.name).toLowerCase()) || null;
    const d = info?.entry || null;
    const nameCn = note.nameCn || detail.seed?.nameCn || d?.nameCn;
    const lines = [`表 ${detail.schema ? `${detail.schema}.` : ''}${detail.name}${nameCn ? `（${nameCn}）` : ''}，${detail.columns.length} 个字段`];
    const issues = await issueState();
    const issue = issues.all.get(String(detail.name).toLowerCase());
    if (issue) lines.push(`⚠ 数据源问题：${issues.sentence(issue)}${issues.blocked.size ? '，对话里暂不用它回答数据问题（字段结构可以参考）' : ''}${altText(info)}`);
    if (info?.origin) lines.push(`来源：${originText(info)}`);
    if (d) lines.push(`表字典：${[d.nameEn && `英文名 ${d.nameEn}`, (d.category || d.subCategory) && `分类 ${[d.category, d.subCategory].filter(Boolean).join(' / ')}`, d.layer && `分层 ${d.layer}`, d.description && `说明 ${d.description.slice(0, 200)}`].filter(Boolean).join('；') || '已登记'}`);
    if (info?.boards.length) lines.push(`看板指标（已算好，可用 netcare_boards 直接取）：${info.boards.slice(0, 8).map((b) => b.title).join('、')}${info.boards.length > 8 ? ` 等 ${info.boards.length} 个` : ''}`);
    const dictCols = new Map((d?.columns || []).map((c) => [String(c.name).toLowerCase(), c]));
    if (note.description) lines.push(`标注说明：${note.description}`);
    if (note.timeField || note.regionField || note.officeField) lines.push(`标注字段：时间=${note.timeField || '-'}，地区部=${note.regionField || '-'}，代表处=${note.officeField || '-'}${note.verified ? '（已核对）' : ''}`);
    else lines.push(`建议字段：时间=${detail.suggestions.timeField || '-'}，地区部=${detail.suggestions.regionField || '-'}，代表处=${detail.suggestions.officeField || '-'}`);
    if (detail.hints.length) lines.push(`提示：${detail.hints.join('；')}`);
    lines.push('字段 | 类型 | 注释 / 字典中文名 | 识别 | 形态 | 占位值 | 示例');
    for (const column of detail.columns) {
        const cn = dictCols.get(String(column.name).toLowerCase())?.nameCn || '';
        lines.push([column.name, column.columnType || column.dataType, [column.comment, cn && cn !== column.comment ? cn : ''].filter(Boolean).join(' / ') || '-', column.role || '-', column.kinds.join('/') || '-', column.sentinels.join('/') || '-', column.examples.join(' ; ').slice(0, 120) || '-'].join(' | '));
    }
    if (detail.sample.length) {
        lines.push(`样例 ${detail.sample.length} 行：`);
        for (const row of detail.sample) lines.push(JSON.stringify(row).slice(0, 1500));
    }
    let content = lines.join('\n');
    if (content.length > RESULT_CHARS) content = `${content.slice(0, RESULT_CHARS)}\n…（已截断）`;
    return { content, summary: `${detail.name}：${detail.columns.length} 个字段` };
}

async function assertUsable(tables) {
    const issues = await issueState();
    if (!issues.blocked.size) return;
    const index = await dictIndex();
    for (const t of tables) {
        const issue = issues.blocked.get(String(t).toLowerCase());
        if (issue) throw blockedError(issue.table || t, issue, issues.sentence, index.get(String(t).toLowerCase()));
    }
}

async function query(args) {
    await assertUsable([String(args.table || '')]);
    const result = await catalog.queryTable('business', { ...args, limit: clampInt(args.limit, 1, MAX_MODEL_ROWS, 100) });
    return { content: rowsText(result.rows, result), summary: `${args.table}：${result.rows.length} 行`, output: result.sql };
}

async function sql(args) {
    await assertUsable(await dataDict().then((m) => m.parseSources(String(args.sql || ''))).catch(() => []));
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
        description: '在 NetCare 业务库的表目录里找表：返回表名、中文名、来源（NetCare / DataFab / 二次加工）、模块、类别 / 看板、粒度、估算行数、是否已核对、说明，以及相关的看板指标。关键词匹配英文表名、中文名、英文名、看板、说明、字段名和字段中文名，中文词支持近似匹配。用户说的是表的中文叫法或近似说法时，把可能的说法都作为关键词（空格分隔）一次传入。回答 NetCare / DataFab 业务数据（风险、整改、红线、巡检、漏洞、工单、网络、License 等）的问题时先用它找表。',
        parameters: {
            type: 'object',
            properties: {
                keyword: { type: 'string', description: '关键词，如 风险、license、rectify、整改超期、红线人员；可空格分隔多个（任一命中），中英文、近义说法都可以一起给' },
                category: { type: 'string', description: '类别或看板，如 风险、整改、任务/工单、网络、IOC运营、整改管理、维护红线资源' },
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
        description: `在 NetCare 业务库上执行一条只读 SQL（SELECT / WITH），用于结构化查询表达不了的关联和子查询。${netcareConfig().businessSchemaExplicit ? `表名写 ${netcareConfig().businessSchema}.表名。` : '表名直接写（数据源当前库），不要加库名前缀。'}优先用聚合，不要把大量明细取回来。`,
        parameters: {
            type: 'object',
            properties: { sql: { type: 'string', description: '单条 SELECT 语句' }, maxRows: { type: 'integer', description: `最多返回行数，默认 200，上限 ${MAX_MODEL_ROWS}` } },
            required: ['sql'],
        },
        run: guarded(sql),
    },
    {
        name: 'netcare_boards',
        description: '读取看板指标：数据治理里按看板 SQL（DataFab 口径）算好的结果表，源表变化后自动重算。用户问的是某个看板 / 指标（如「整改清零--整体网元进展」「各地区部整改完成率」）时优先用它，直接拿算好的结果，不要自己重写看板 SQL。不传 board 时按关键词列出看板指标；传 board（标识、英文名或「看板--指标」）读取结果行。',
        parameters: {
            type: 'object',
            properties: {
                keyword: { type: 'string', description: '列清单时的关键词，如 整改清零、网元进展、批量整改；可空格分隔多个' },
                board: { type: 'string', description: '要读取的看板指标：清单里的标识（dv_…）、英文名或「看板--指标」' },
                limit: { type: 'integer', description: `读取行数，默认 100，上限 ${MAX_MODEL_ROWS}` },
                offset: { type: 'integer', description: '从第几行开始（翻页）' },
            },
        },
        run: guarded(boards),
    },
];
