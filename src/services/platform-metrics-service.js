// 平台效能统计（首页的效能看板与工具卡片上的数字）：按已入库的业务量和保守的人工处理时长折算节约工时。
// 口径与主线版 models/platform-metrics-repository.js 一致（同样的折算系数、同样的返回结构），数据换成本应用库里的表：
//   指标检查 = report_metric_data 行数；短板 = 其中未达标的；抓取脚本 = uiv_scripts；导入 = upload_history 里的导入记录；
//   报表快照 = report_snapshots；FRT 核算、PR 稽查模板、需求 = 统一记录表；AI 回答 = ai_chat_messages；AI 分析过的消息 = 各人消息里带 AI 摘要的。
// 统计都在库里用 COUNT 做（规范 §7.4），每项失败只记为 0，不影响首页打开。
import { scopedQuery, kvGet, kvSet } from '../dao/scoped.js';
import { listRecords } from './record-store.js';
import { listCustomTools } from './custom-tool-service.js';
import { getUsage } from './usage-service.js';
import { ALERT_AI_COUNT_KEY } from './alert-ai-service.js';

const OPENS_KEY = 'platform_tool_opens';
// 首页「工具」网格里自带的平台页面数（与主线版的 BUILTIN_TOOL_COUNT 同义）
const BUILTIN_PAGE_COUNT = 13;

async function count(sql) {
    try {
        const rows = await scopedQuery(sql, 1);
        return Number(Object.values(rows[0] || {})[0]) || 0;
    } catch {
        return 0;
    }
}
const bizCount = (kind) => count(`SELECT COUNT(*) AS n FROM \`biz_records\` WHERE \`kind\` = '${kind}'`);

export const normalizeToolKey = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').slice(0, 80);

/** 记一次工具打开（首页、导航打开工具时前端上报） */
export async function trackToolOpen(toolKey) {
    const key = normalizeToolKey(toolKey);
    if (!key) return { tracked: false };
    const counters = (await kvGet(OPENS_KEY, {})) || {};
    counters[key] = (Number(counters[key]) || 0) + 1;
    await kvSet(OPENS_KEY, counters);
    return { toolKey: key, tracked: true, count: counters[key] };
}

export async function platformSummary({ identity } = {}) {
    const [
        scripts, history, imports, exportsCount, slaSnapshots, targets,
        metricChecks, failingChecks, customerGroups, reportMonths, reportSnapshots,
        frtSnapshots, auditTemplates, requirements, aiSessions, aiQuestions, aiAnswers, coveredPages, tableCount,
    ] = await Promise.all([
        count('SELECT COUNT(*) AS n FROM `uiv_scripts`'),
        count('SELECT COUNT(*) AS n FROM `upload_history`'),
        count("SELECT COUNT(*) AS n FROM `upload_history` WHERE `payload_json` LIKE '%导入%'"),
        count("SELECT COUNT(*) AS n FROM `upload_history` WHERE `payload_json` LIKE '%导出%'"),
        count('SELECT COUNT(*) AS n FROM `sla_snapshots`'),
        count('SELECT COUNT(*) AS n FROM `sla_targets`'),
        count('SELECT COUNT(*) AS n FROM `report_metric_data`'),
        count('SELECT COUNT(*) AS n FROM `report_metric_data` WHERE `is_failing` = 1'),
        count('SELECT COUNT(DISTINCT `cat_name`) AS n FROM `report_metric_data`'),
        count('SELECT COUNT(DISTINCT `month`) AS n FROM `report_metric_data`'),
        count('SELECT COUNT(*) AS n FROM `report_snapshots`'),
        bizCount('frt_snapshot'),
        bizCount('praudit_config'),
        bizCount('requirement'),
        count('SELECT COUNT(*) AS n FROM `ai_chat_sessions`'),
        count("SELECT COUNT(*) AS n FROM `ai_chat_messages` WHERE `role` = 'user'"),
        count("SELECT COUNT(*) AS n FROM `ai_chat_messages` WHERE `role` = 'model'"),
        count("SELECT COUNT(DISTINCT JSON_UNQUOTE(JSON_EXTRACT(`metadata_json`, '$.pagePath'))) AS n FROM `ai_chat_sessions` WHERE `metadata_json` LIKE '%pagePath%'"),
        count('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()'),
    ]);
    // 需求流转次数、稽查规则数：记录数很少，直接读出来数
    const requirementRows = await listRecords('requirement', { limit: 1000 }).catch(() => []);
    const transitions = requirementRows.reduce((sum, r) => sum + (Number(r.summary?.transitions) || 0), 0);
    const auditRows = await listRecords('praudit_config', { withPayload: true, limit: 200 }).catch(() => []);
    const auditCheckpoints = auditRows.reduce((sum, r) => sum + (Array.isArray(r.payload?.checkpoints) ? r.payload.checkpoints.length : 0), 0);
    const opens = (await kvGet(OPENS_KEY, {}).catch(() => ({}))) || {};
    const trackedOpens = Object.values(opens).reduce((sum, n) => sum + (Number(n) || 0), 0);
    const customTools = await listCustomTools(identity || { isAdmin: true }).catch(() => []);
    const usage = await getUsage('day').catch(() => null);
    const tokens = Number(usage?.totals?.tokens || 0) + Number(usage?.unclassified?.tokens || 0);
    // AI 分析过的消息：摘要服务每写回一条就记一次（同一条消息发给多人只算一次）
    const analyzedAlerts = Number(await kvGet(ALERT_AI_COUNT_KEY, 0).catch(() => 0)) || 0;

    // 保守折算（与主线版相同）：指标核对 2 分钟 / 项，脚本编制 90 分钟 / 个，数据导入整理 30 分钟 / 次，
    // 报表整理 45 分钟 / 份，FRT 核算 60 分钟 / 次；平台执行仍需复核，按节约 95%、83%、83%、89%、83% 计
    const manualMinutes = metricChecks * 2 + scripts * 90 + imports * 30 + reportSnapshots * 45 + frtSnapshots * 60;
    const savedMinutes = metricChecks * 1.9 + scripts * 75 + imports * 25 + reportSnapshots * 40 + frtSnapshots * 50;
    const aiSavedMinutes = aiAnswers * 8 + analyzedAlerts * 3;

    return {
        generatedAt: new Date().toISOString(),
        totals: {
            metricChecks,
            serviceCount: history + trackedOpens,
            manualEquivalentHours: Math.round(manualMinutes / 60),
            savedHours: Math.round(savedMinutes / 60),
            efficiencyRate: manualMinutes > 0 ? Math.round(savedMinutes / manualMinutes * 100) : 0,
            onlineTools: BUILTIN_PAGE_COUNT + customTools.length,
            scripts,
            history,
            trackedOpens,
        },
        toolStats: {
            uivf12: { primary: scripts, labelKey: 'home.impact.automationScripts', secondary: Math.round(scripts * 75 / 60), secondaryLabelKey: 'home.impact.hoursSaved' },
            sla: { primary: imports, labelKey: 'home.impact.dataImports', secondary: slaSnapshots, secondaryLabelKey: 'home.impact.snapshotsStored' },
            report: { primary: metricChecks, labelKey: 'home.impact.metricChecks', secondary: reportSnapshots, secondaryLabelKey: 'home.impact.reportSnapshots' },
            expedite: { primary: failingChecks, labelKey: 'home.impact.weaknessesFound', secondary: reportSnapshots, secondaryLabelKey: 'home.impact.traceableSnapshots' },
            monthly: { primary: reportMonths, labelKey: 'home.impact.monthsStored', secondary: reportSnapshots, secondaryLabelKey: 'home.impact.historySnapshots' },
            bigscreen: { primary: customerGroups, labelKey: 'home.impact.customerGroups', secondary: metricChecks, secondaryLabelKey: 'home.impact.metricResults' },
            frt: { primary: frtSnapshots, labelKey: 'home.impact.autoCalculations', secondary: Math.round(frtSnapshots * 50 / 60), secondaryLabelKey: 'home.impact.hoursSaved' },
            requirements: { primary: requirements, labelKey: 'home.impact.requirementsManaged', secondary: transitions, secondaryLabelKey: 'home.impact.workflowTransitions' },
            praudit: { primary: auditCheckpoints, labelKey: 'home.impact.auditRules', secondary: auditTemplates, secondaryLabelKey: 'home.impact.auditTemplates' },
            'db-explorer': { primary: tableCount, labelKey: 'home.impact.tablesVisible', secondary: 1, secondaryLabelKey: 'home.impact.coreDatabases' },
        },
        customToolStats: Object.fromEntries(customTools.map((tool) => [
            tool.slug,
            { primary: Number(opens[`custom:${tool.slug}`]) || 0, labelKey: 'home.impact.totalOpens', secondary: 1, secondaryLabelKey: 'home.impact.onlineTool' },
        ])),
        ai: {
            applicationScenarios: 4,
            completedTasks: aiAnswers + analyzedAlerts,
            sessions: aiSessions,
            questions: aiQuestions,
            answers: aiAnswers,
            tokens,
            costCny: 0,
            coveredPages,
            suggestions: 0,
            analyzedAlerts,
            modelAnalyzedAlerts: analyzedAlerts,
            ruleAnalyzedAlerts: 0,
            savedHours: Math.round(aiSavedMinutes / 60),
        },
        methodology: {
            metricCheckMinutes: 2, scriptBuildMinutes: 90, dataImportMinutes: 30, reportMinutes: 45, frtCalculationMinutes: 60, aiAnswerMinutes: 8, aiAlertAnalysisMinutes: 3,
            note: '基于已入库业务量与保守人工处理时长折算，为管理口径估算值。',
        },
        supporting: { targets, exports: exportsCount },
    };
}
