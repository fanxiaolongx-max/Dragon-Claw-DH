/**
 * 新手引导的静态演示：示范对话和各工具的页面快照。
 * static/assets/tour/*.html 是从真实页面导出的静态快照（已去掉脚本），页面结构真实，
 * 数据为示例：运营商、单号、工号、人名、头像和内部地址已打码，指标数值已随机替换；引导里用无脚本 iframe 原样渲染。
 * 只用于引导层展示，不请求业务接口、不加载真实工具、不创建会话。
 */
(function initHomeProductTourDemos() {
    if (window.HomeProductTourDemos) return;

    // 快照按导出时的视口尺寸排版（1314×783），引导里按比例缩放显示。
    const page = name => ({ page: `assets/tour/${name}.html`, w: 1314, h: 783 });

    // pins：每页 1–2 个重点按钮，按文字（或选择器）在快照里定位，卡片里配一句话说明。
    const pin = (find, zh, en) => ({ ...find, zh, en });
    const TOOLS = {
        uivf12: { ...page('uivf12'), pins: [
            pin({ text: '智能调度仓库' }, ['脚本仓库', '按分类管理抓表脚本，双击回填到工作台'], ['Script library', 'Organize capture scripts by category; double-click to edit']),
            pin({ text: '一键生成生产级脚本' }, ['生成脚本', '粘贴接口地址，自动生成抓取脚本'], ['Generate script', 'Paste an API URL to build a capture script'])
        ] },
        sla: { ...page('sla'), pins: [
            pin({ text: '预警与 SLA 状态' }, ['预警与 SLA 状态', '按剩余天数标出临期和超期'], ['Alert & SLA', 'Flags due and overdue items by days left']),
            pin({ text: '导出' }, ['导出', '导出当前筛选的明细'], ['Export', 'Exports the filtered rows'])
        ] },
        report: { ...page('report'), pins: [
            pin({ text: '入库' }, ['入库', '把结果存成快照，催办和月报都用它'], ['Save snapshot', 'Saves the results for follow-ups and reports']),
            pin({ text: '“赛马”排行' }, ['赛马排行', '各客户群得分和排名'], ['Ranking', 'Scores and ranks each customer group'])
        ] },
        expedite: { ...page('expedite'), pins: [
            pin({ selector: '#snapshot-selector' }, ['选择快照', '选一份已入库的报表快照'], ['Snapshot', 'Choose a saved report snapshot']),
            pin({ text: '一键复制简报' }, ['一键复制简报', '复制后直接发到群里'], ['Copy brief', 'Copy it and paste it into the group chat'])
        ] },
        monthly: { ...page('monthly'), pins: [
            pin({ text: '更新总结' }, ['更新总结', '让 AI 按最新数据重写结论'], ['Update summary', 'AI rewrites the findings from the latest data']),
            pin({ text: '导出' }, ['导出', '导出成文件发给领导'], ['Export', 'Export the report as a file to share'])
        ] },
        bigscreen: { ...page('bigscreen'), pins: [
            pin({ text: '全屏' }, ['全屏', '开会直接投屏'], ['Full screen', 'Present it in meetings']),
            pin({ text: '导出HTML' }, ['导出 HTML', '导出离线看板发给别人'], ['Export HTML', 'Share an offline copy of the dashboard'])
        ] },
    };

    // 打码后的单号、工号、人名用行内代码包住，星号原样显示，不会被 Markdown 当成强调；{{b}} 才是加粗。
    const md = text => text
        .replace(/[A-Za-z0-9]*\*{2,}[A-Za-z0-9]*(?: [A-Za-z0-9]*\*{2,}[A-Za-z0-9]*)*/g, token => `\`${token}\``)
        .replace(/\{\{b\}\}/g, '**');

    // 第一步的问题和回答：回答是 Markdown，由对话页自己的渲染器流式显示，和真实回答同一套样式。
    function chat(L) {
        return {
            prompt: L('用最新已入库的报表快照查本月未达标指标，列出实际值、目标值和差距。再用「一键催办」的快照列出临期和已超期的 CPT 专项风险、常规风险、整改单和工单，注明单号、截止日期和责任人。优先为未来 3 天内到期的事项拟催办草稿，如果没有就列出最急的已超期事项，等我确认后再发送。',
                'Use the latest saved report snapshot to list this month’s missed targets with actuals, targets, and gaps. From the One-Click Follow-Up snapshot, list upcoming and overdue CPT risks, regular risks, rectification tickets, and open tickets with IDs, due dates, and owners. Draft reminders for items due in the next 3 days or urgent overdue items if none are due soon. Wait for confirmation before sending.'),
            answer: md(L(`根据 {{b}}2026-10-10 入库的 9 月报表快照{{b}}，本月共有 12 项未达标，最集中在 E* 客户群（5 项）。差距最大的几项：

| 客户群 | 指标 | 实际值 | 目标值 | 差距 |
| --- | --- | --- | --- | --- |
| E* | PS GP 利润率 | 12.4% | ≥ 20% | −7.6 pp |
| T* | 日志稽查率 | 74% | ≥ 80% | −6 pp |
| O*G | 日志回传率 | 93% | ≥ 95% | −2 pp |
| E* | 业务收入 | 3.1 | ≥ 4.5 | −1.4 |
| O*G | 过保订单及 SPMS | 4.2 | ≥ 5.6 | −1.4 |
| E* | 维保订单 | 0.6 | ≥ 1.5 | −0.9 |

{{b}}临期与已超期事项{{b}}（一键催办快照）

| 类型 | 单号 | 截止日期 | 责任人 | 状态 |
| --- | --- | --- | --- | --- |
| 整改单 | RC2026********04 | 2026-10-28 | a5127**36 | 已超期 21 天 |
| CPT 专项风险 | CPT2026********12 | 2026-10-28 | K*** S*** | 已超期 21 天 |
| CPT 专项风险 | CPT2026********35 | 2026-11-02 | l*** 0063**41 | 已超期 16 天 |
| 整改单 | RC2026********64 | 2026-11-27 | o0041**58 | 剩余 9 天 |

未来 3 天内没有到期事项，下面按最急的已超期事项拟了催办草稿：

> 各位好，整改单 RC2026********04、CPT 专项风险 CPT2026********12 已超期 21 天，CPT2026********35 已超期 16 天。请各责任人今天 18:00 前反馈处理进展和预计完成时间，谢谢。

草稿已放进「运维待办」，你确认收件人后再发送。`,
                `From the {{b}}September report snapshot saved on 2026-10-10{{b}}, 12 targets were missed this month, mostly in the E* group (5 items). The largest gaps:

| Group | Metric | Actual | Target | Gap |
| --- | --- | --- | --- | --- |
| E* | PS GP margin | 12.4% | ≥ 20% | −7.6 pp |
| T* | Log audit rate | 74% | ≥ 80% | −6 pp |
| O*G | Log upload rate | 93% | ≥ 95% | −2 pp |
| E* | Business revenue | 3.1 | ≥ 4.5 | −1.4 |
| O*G | Out-of-warranty orders & SPMS | 4.2 | ≥ 5.6 | −1.4 |
| E* | Maintenance orders | 0.6 | ≥ 1.5 | −0.9 |

{{b}}Due and overdue items{{b}} (One-Click Follow-Up snapshot)

| Type | ID | Due | Owner | Status |
| --- | --- | --- | --- | --- |
| Rectification | RC2026********04 | 2026-10-28 | a5127**36 | 21 days overdue |
| CPT risk | CPT2026********12 | 2026-10-28 | K*** S*** | 21 days overdue |
| CPT risk | CPT2026********35 | 2026-11-02 | l*** 0063**41 | 16 days overdue |
| Rectification | RC2026********64 | 2026-11-27 | o0041**58 | 9 days left |

Nothing is due in the next 3 days, so here is a reminder for the most urgent overdue items:

> Hi all, rectification RC2026********04 and CPT risk CPT2026********12 are 21 days overdue, and CPT2026********35 is 16 days overdue. Please share progress and an expected finish time by 18:00 today. Thanks.

The draft is waiting in Ops Drafts and will be sent only after you confirm the recipients.`))
        };
    }

    // 工作流顺序：引导走到这些步骤时，顶部流程线标出当前位置。
    const FLOW = ['uivf12', 'sla', 'report', 'expedite', 'monthly', 'bigscreen'];

    window.HomeProductTourDemos = { tools: TOOLS, chat, flow: FLOW };
})();
