---
id: smart-notify
name: 智能研判与通知下发
name_en: Smart data check and notify
description: 查询平台指标或业务数据，由 AI 研判异常项与责任人，确认后通过基座邮件、应用号消息及站内横幅下发通知
description_en: Query metrics or business data, determine recipients with AI, and send base emails, app messages, and inbox banners after confirmation
icon: 📣
---
按以下流程查询数据、研判通知对象并通过基座公共通知能力下发，严禁未经用户确认擅自发信：

1. **查询数据与责任人（全部使用只读工具取数，禁止凭空编造）**：
   - 运营指标/催办类：先调用 `get_report_overview` 获取最新快照概览；需要明细时用 `query_database` 查询 `report_metric_data`（重点看 `is_failing = 1`、`gap`、`cat_name`、`metric_label`）。
   - 责任人名单查询：用 `query_database` 查询 `bigscreen_owners`（`cat_name`, `metric_label`, `owner_name`, `emp_id`），再用 `read_page_config` 读取 `expedite_notify_directory`（一键催办通讯录），定位对应责任人工号或邮箱。
   - 若涉及现网业务库且用户已获授权，也可使用 `netcare_tables` / `netcare_query` / `netcare_sql` 做只读核查。

2. **AI 研判并拟定通知方案（先汇报、再确认）**：
   - 根据数值异常、差距大小与分发归属，列出建议通知清单：
     - **接收人（`to`）**：优先给出带姓名和准确工号（如 `wwx1528315`、`h00835326`；如仅知数字尾号也可传入，系统自动匹配/扩展）；
     - **发送通道（`channel`）**：
       - `both`（默认推荐）：同时触发基座**邮件 (`msg_type="1"`)** + **应用号通知 (`msg_type="2"`)**，并自动在接收人首页右上角弹出未读横幅；
       - `email`：仅发送基座邮件（`email_params`，支持 `cc` 抄送 `email_cc`）；
       - `app`：仅发送应用号消息（`app_msg_params`，支持可选 `jumpUrl`）。
     - **通知标题与正文（`title` / `content`）**：写明分类、指标名、当前值/目标值、差距及建议整改动作，简洁清晰、可直接落地执行。

3. **调用 `send_notification` 下发**：
   - 当用户明确指示发送（或在预览后确认执行）时，按上述参数调用 `send_notification`；工具会自动在对话中展示「接收人、渠道与正文确认卡」，由用户点「允许」后才真正推送到基座。
   - 若用户要求给不同责任人发**专属差异化内容**，按责任人拆分逐条调用 `send_notification`。
   - 若用户仅想查看草稿或未确认接收人，先给出清单并用 `ask_user` 或文本询问确认，不直接调用 `send_notification`。
