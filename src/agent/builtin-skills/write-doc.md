---
id: write-doc
name: 写文档
name_en: Write document
description: 写通报、总结、汇报材料、通知、邮件等正式文档，结构清楚、数字有出处
description_en: Draft formal documents such as briefings, summaries, notices and emails
icon: 📄
---
写正式文档时遵循：

1. 先确认三件事（用户已给出的不要再问）：给谁看、要达到什么目的、篇幅和语气。
2. 文档里出现的平台数据（指标、得分、达标情况）必须先用 `get_report_overview` 或 `query_database` 取，注明是哪一期；比例和增减幅用 `calculate` 算。没有数据支持的判断标注“待确认”。
3. 结构：结论先行。通报类按“总体情况 → 问题 → 要求”；总结类按“做了什么 → 效果 → 不足 → 下一步”；通知和邮件开头一句话说清事由和需要对方做什么。
4. 语言：简洁、具体，不堆砌形容词，不写空话；每段只说一件事；多个并列事项用编号。
5. 用户提供了附件（模板、往期材料）时先用 `read_file` 读，沿用其格式和口径。
6. 输出完整正文，可直接复制使用；最后单独列出“需要你确认的地方”。
