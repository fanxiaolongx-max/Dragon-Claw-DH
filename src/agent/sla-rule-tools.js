// 数据导入页指标规则的条件值维护（与桌面版 agent-sla-rule-tools.js 同名同参数）：
// 查找、批量修改或加别名 [旧名]|[新名]（执行前弹确认卡，逐处显示最近一次导入里改前改后的命中行数）、
// 查看改动记录、按记录回退。只给管理员。
import { find, plan, apply, listChanges, revert, readMetrics, planMetricEdits, applyMetricEdits } from '../services/sla-metric-rule-editor.js';

const RELOAD_NOTE = '已打开的数据导入页面要刷新后才会用新规则（不刷新就保存规则会把这次修改覆盖掉）。';
const REPLACEMENTS = {
    type: 'array',
    description: '替换清单。每项二选一：{ from, to } 把条件值 from 整串替换成 to；{ from, addAliases: ["新名"] } 给条件值 from 追加别名，结果写成 [旧名]|[新名]，任一命中即可（推荐，新旧数据都能匹配）。match 默认 exact（整串相等，已是别名列表时其中一个别名相等也算）；contains 表示只替换值里出现的这段文字。',
    items: {
        type: 'object',
        properties: {
            from: { type: 'string', description: '现在的条件值，如 甲系统部' },
            to: { type: 'string', description: '替换成的条件值' },
            addAliases: { type: 'array', items: { type: 'string' }, description: '要追加的别名，如 ["甲方新名系统部"]' },
            match: { type: 'string', enum: ['exact', 'contains'] },
        },
        required: ['from'],
    },
};
const SCOPE = {
    prefKeys: { type: 'array', items: { type: 'string' }, description: '只改这些表（sla_find_metric_rules 返回的 prefKey）；不填为全部表' },
    metricLabels: { type: 'array', items: { type: 'string' }, description: '只改指标名包含这些文字的规则' },
    fields: { type: 'array', items: { type: 'string', enum: ['valY', 'conditions', 'valK'] }, description: '改哪些字段：valY 条件值、conditions 附加过滤条件、valK 计数/占比关键字；默认全部' },
};

const adminOnly = (ctx) => (ctx.identity?.isAdmin ? null : { error: '修改指标规则需要管理员权限' });
const fail = (error) => ({ ok: false, summary: String(error.message || error).slice(0, 60), content: `错误：${error.message || error}` });
const lines = (changes) => changes.map((c) => `${c.where}\n- ${c.from}\n+ ${c.to}\n  ${c.matchedRowsBefore === null ? '（最近一次导入里没有这张表的数据）' : `命中 ${c.matchedRowsBefore} → ${c.matchedRowsAfter} 行`}`).join('\n');

const METRIC_EDITS = {
    type: 'array',
    description: '规则改动清单，每项三选一：{ op: "update", prefKey, metricId, set: { 字段: 新值 }, unset: ["字段"] } 改已有规则（只改列出的字段，其它保持不变）；{ op: "add", prefKey, metric: { label, type, colX, valY, colZ, valK, conditions, aggregation, filterLogic, scope, subMetrics } } 新增一条；{ op: "remove", prefKey, metricId } 删除一条。prefKey / metricId 先用 sla_read_metric_rules 查；id 不能改。',
    items: {
        type: 'object',
        properties: {
            op: { type: 'string', enum: ['update', 'add', 'remove'] },
            prefKey: { type: 'string' },
            metricId: { type: 'string' },
            set: { type: 'object', description: 'update：要改的字段和新值，如 {"label":"闭环率","colZ":"状态","conditions":[{"column":"区域","value":"甲"}]}' },
            unset: { type: 'array', items: { type: 'string' }, description: 'update：要删掉的字段' },
            metric: { type: 'object', description: 'add：完整的新规则（label 必填；type 为 extract / extract_multi / count / ratio）' },
        },
        required: ['op', 'prefKey'],
    },
};
const metricLines = (changes) => changes.map((c) => `${c.where}：${c.from} → ${c.to}${c.matchedRowsAfter === null && c.matchedRowsBefore === null ? '' : `（最近一次导入：${c.valueBefore ?? '—'} → ${c.valueAfter ?? '—'}，命中 ${c.matchedRowsBefore ?? '—'} → ${c.matchedRowsAfter ?? '—'} 行）`}`).join('\n');

export const SLA_RULE_TOOLS = [
    {
        name: 'sla_read_metric_rules',
        description: '读取数据导入页（SLA）的完整指标规则。不传参数：列出每张表（prefKey）和它的指标（id、名称、类型）；传 prefKey / metricId / query：返回整条规则定义（条件列、条件值、取值列、计数关键字、附加条件、聚合方式、子指标等），并给出按最近一次导入算出的值和命中行数。改整条规则前先用它看原内容。仅管理员可用。',
        parameters: { type: 'object', properties: {
            prefKey: { type: 'string', description: '只看这张表' },
            metricId: { type: 'string', description: '只看这条指标' },
            query: { type: 'string', description: '按表名、指标名、列名、条件值、子指标分类过滤' },
            limit: { type: 'integer', description: '最多返回几条，默认 20' },
        } },
        async run(args, ctx) {
            const denied = adminOnly(ctx);
            if (denied) return { ok: false, summary: denied.error, content: denied.error };
            try {
                const result = await readMetrics(args || {});
                return { ok: true, summary: result.tables ? `${result.tables.length} 张表` : `${result.total} 条规则`, content: JSON.stringify(result) };
            } catch (error) { return fail(error); }
        },
    },
    {
        name: 'sla_edit_metric_rules',
        description: '新增、修改或删除数据导入页（SLA）的整条指标规则（类型、条件列与条件值、取值列、附加条件、聚合方式、子指标、名称、颜色等，指标 ID 除外）。只改条件值或加别名时用 sla_update_metric_conditions。执行前弹确认卡，逐条显示改了哪些字段、按最近一次导入改前 / 改后的值和命中行数；写入后返回改动记录 ID，可用 sla_revert_metric_rule_change 回退。仅管理员可用。',
        parameters: { type: 'object', properties: { edits: METRIC_EDITS, summary: { type: 'string', description: '一句话说明这次改动的原因' } }, required: ['edits'] },
        kind: 'write',
        async approval(args, ctx) {
            const denied = adminOnly(ctx);
            if (denied) return denied;
            try {
                const planned = await planMetricEdits(args || {});
                if (!planned.changes.length) return { error: `没有需要修改的规则。${planned.warnings.join('；')}` };
                return { preview: {
                    title: `修改 ${planned.changes.length} 条指标规则${args.summary ? ` · ${String(args.summary).slice(0, 80)}` : ''}`,
                    impact: [planned.latestImportAt ? `值和命中行数按最近一次导入（${planned.latestImportAt}）计算` : '还没有导入过数据，无法预估', ...planned.warnings].join('；'),
                    fields: planned.changes.map((c) => ({ label: c.where, value: `${c.from} → ${c.to}${c.matchedRowsBefore === null && c.matchedRowsAfter === null ? '' : `；值 ${c.valueBefore ?? '—'} → ${c.valueAfter ?? '—'}，命中 ${c.matchedRowsBefore ?? '—'} → ${c.matchedRowsAfter ?? '—'} 行`}` })),
                } };
            } catch (error) { return { error: error.message }; }
        },
        async run(args, ctx) {
            try {
                const result = await applyMetricEdits(args || {}, { actor: ctx.identity?.username || '' });
                if (!result.id) return { ok: false, summary: '没有修改', content: `没有修改任何规则。${[...result.warnings, ...result.conflicts.map((c) => `${c.where}：${c.reason}`)].join('；')}` };
                return {
                    ok: true,
                    summary: `已修改 ${result.applied.length} 条规则 · ${result.id}`,
                    content: `已修改 ${result.applied.length} 条规则，改动记录 ID：${result.id}（不对时可用 sla_revert_metric_rule_change 回退）。\n${metricLines(result.applied)}${result.conflicts.length ? `\n未修改（${result.conflicts.length} 条）：${result.conflicts.map((c) => `${c.where}：${c.reason}`).join('；')}` : ''}${result.warnings.length ? `\n提醒：${result.warnings.join('；')}` : ''}\n${RELOAD_NOTE}`,
                };
            } catch (error) { return fail(error); }
        },
    },
    {
        name: 'sla_find_metric_rules',
        description: '查找数据导入页（SLA）指标规则里的条件值：主指标和子指标的条件值 Y、附加过滤条件、计数关键字 K，并对照最近一次导入的数据给出每条命中几行。unmatched=true 只列一行都没命中的条件（页面不高亮、取不到数的那些），并给出数据里没被任何规则匹配的候选取值（通常就是改了名的新值）。仅管理员可用。',
        parameters: { type: 'object', properties: {
            query: { type: 'string', description: '按表名、指标名、子指标分类、列名或条件值过滤，如 甲系统部 或 闭环率' },
            unmatched: { type: 'boolean', description: '只看最近一次导入中零命中的条件' },
            limit: { type: 'integer', description: '最多返回几条，默认 60' },
        } },
        async run(args, ctx) {
            const denied = adminOnly(ctx);
            if (denied) return { ok: false, summary: denied.error, content: denied.error };
            try {
                const result = await find(args || {});
                return { ok: true, summary: `找到 ${result.total} 处条件值${args?.unmatched ? '（零命中）' : ''}`, content: JSON.stringify(result) };
            } catch (error) { return fail(error); }
        },
    },
    {
        name: 'sla_update_metric_conditions',
        description: '批量修改数据导入页指标规则的条件值（含子指标），或给条件值加别名 [旧名]|[新名]。执行前会弹确认卡，逐处显示最近一次导入里改前/改后的命中行数；写入后返回改动记录 ID，可用 sla_revert_metric_rule_change 回退。只改条件值，不改指标 ID、列和目标。仅管理员可用。',
        parameters: { type: 'object', properties: { replacements: REPLACEMENTS, ...SCOPE, summary: { type: 'string', description: '一句话说明这次改动的原因' } }, required: ['replacements'] },
        kind: 'write',
        async approval(args, ctx) {
            const denied = adminOnly(ctx);
            if (denied) return denied;
            try {
                const planned = await plan(args || {});
                if (!planned.changes.length) return { error: `没有找到要改的条件值。${planned.warnings.join('；')}` };
                return { preview: {
                    title: `修改 ${planned.changes.length} 处指标条件值${args.summary ? ` · ${String(args.summary).slice(0, 80)}` : ''}`,
                    impact: [planned.latestImportAt ? `命中行数按最近一次导入（${planned.latestImportAt}）计算` : '还没有导入过数据，无法预估命中行数', ...planned.warnings].join('；'),
                    fields: planned.changes.slice(0, 40).map((c) => ({ label: c.where, value: `${c.from} → ${c.to}（${c.matchedRowsBefore === null ? '无数据' : `命中 ${c.matchedRowsBefore} → ${c.matchedRowsAfter} 行`}）` })),
                } };
            } catch (error) { return { error: error.message }; }
        },
        async run(args, ctx) {
            try {
                const result = await apply(args || {}, { actor: ctx.identity?.username || '' });
                if (!result.id) return { ok: false, summary: '没有修改', content: `没有修改任何条件值。${[...result.warnings, ...result.conflicts.map((c) => `${c.where}：${c.reason}`)].join('；')}` };
                return {
                    ok: true,
                    summary: `已修改 ${result.applied.length} 处 · ${result.id}`,
                    content: `已修改 ${result.applied.length} 处，改动记录 ID：${result.id}（不对时可用 sla_revert_metric_rule_change 回退）。${result.conflicts.length ? `\n未修改（${result.conflicts.length} 处）：${result.conflicts.map((c) => `${c.where}：${c.reason}`).join('；')}` : ''}\n${lines(result.applied)}\n${result.warnings.length ? `注意：${result.warnings.join('；')}\n` : ''}${RELOAD_NOTE}`,
                };
            } catch (error) { return fail(error); }
        },
    },
    {
        name: 'sla_list_metric_rule_changes',
        description: '列出最近的指标规则改动记录（条件值修改和整条规则增改删都在这里：ID、时间、谁改的、改了哪些、是否已回退）。仅管理员可用。',
        parameters: { type: 'object', properties: { limit: { type: 'integer', description: '默认 20' } } },
        async run(args, ctx) {
            const denied = adminOnly(ctx);
            if (denied) return { ok: false, summary: denied.error, content: denied.error };
            try {
                const items = await listChanges(args || {});
                return { ok: true, summary: `${items.length} 条改动记录`, content: JSON.stringify(items) };
            } catch (error) { return fail(error); }
        },
    },
    {
        name: 'sla_revert_metric_rule_change',
        description: '回退一次指标规则改动（条件值修改或整条规则增改删都可以）。只把当前值仍等于那次改后值的地方改回去；之后又被人改过的地方不覆盖，列为冲突。回退本身也会生成一条改动记录，可再回退。仅管理员可用。',
        parameters: { type: 'object', properties: { changeId: { type: 'string', description: 'sla_update_metric_conditions 或 sla_list_metric_rule_changes 返回的 ID' } }, required: ['changeId'] },
        kind: 'write',
        async approval(args, ctx) {
            const denied = adminOnly(ctx);
            if (denied) return denied;
            const record = (await listChanges({ limit: 100 })).find((item) => item.id === args?.changeId);
            if (!record) return { error: '没有这条改动记录' };
            return { preview: {
                title: `回退改动 ${record.id}：${record.summary}`,
                impact: `${record.createdAt} · ${record.actor} · 共 ${record.count} 处；之后又被改过的地方不会覆盖`,
                fields: record.changes.map((c) => ({ label: c.where, value: `${c.to} → ${c.from}` })),
            } };
        },
        async run(args, ctx) {
            try {
                const result = await revert(args?.changeId, { actor: ctx.identity?.username || '' });
                if (!result.id) return { ok: false, summary: '没有回退', content: `没有回退任何地方：${result.conflicts.map((c) => `${c.where}：${c.reason}${c.current !== undefined ? `（现在是「${c.current}」）` : ''}`).join('；')}` };
                return {
                    ok: true,
                    summary: `已回退 ${result.applied.length} 处`,
                    content: `已回退 ${result.applied.length} 处，回退记录 ID：${result.id}。${result.conflicts.length ? `\n以下地方之后又被改过，没有覆盖：${result.conflicts.map((c) => `${c.where}（现在是「${c.current ?? '已不存在'}」）`).join('；')}` : ''}\n${RELOAD_NOTE}`,
                };
            } catch (error) { return fail(error); }
        },
    },
];
