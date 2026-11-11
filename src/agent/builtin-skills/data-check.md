---
id: data-check
name: 数据核查
name_en: Data check
description: 核查最新导入的数据和指标：找出未达标项、异常值和与上期相比变化最大的指标
description_en: Review the latest imported data and metrics for misses, outliers and the biggest changes
icon: 🔎
---
按下面的步骤核查平台数据，每一步都用工具取数，不凭印象下结论。

1. 调用 `get_report_overview` 拿到最新一期报表的分类得分和未达标指标。
2. 需要明细时用 `query_database` 查 `report_metric_data`（按 `snapshot_id` 或 `month` 过滤），对比最近两期同一指标的 `num_val`、`gap`。
3. 输出：
   - 一句话结论（本期整体情况）；
   - 未达标指标表：分类、指标、目标、实际、差距，按差距从大到小；
   - 与上期相比变化最大的 3 项（上升和下降分开）；
   - 数据本身可疑的地方（空值、明显超出合理范围、同一指标重复）。
4. 没有数据时直接说明“还没有入库的报表数据”，并告诉用户去「数据导入」导入、在「报表看板」入库。
