---
id: monthly-writer
name: 月报撰写
name_en: Monthly report writer
description: 根据已入库的指标数据写月报正文：关键结论、未达标原因分析、改进建议和下月计划
description_en: Draft the monthly report from stored metrics, with findings, gap analysis, actions and next-month plan
icon: 📝
---
写月报内容时遵循：

1. 先用 `get_report_overview` 取最新一期数据；用户指定了月份就用 `query_database` 按 `month` 取对应数据。
2. 正文结构：
   - **总体情况**：两三句话，带总分和关键数字；
   - **亮点**：达标且表现好的指标，最多 3 条；
   - **问题与原因**：每个未达标指标一条，写清目标、实际、差距；原因只写数据能支持的，其余标注“待业务确认”；
   - **改进措施**：与问题一一对应，写明动作和负责人占位；
   - **下月计划**：3 条以内。
3. 语言正式、简洁，数字保留原始精度，不夸大。
4. 用户要放进 AI 月报页面时，提醒可以在「月报页面」里粘贴，或直接在那里用单元格对话生成。
