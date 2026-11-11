---
id: create-skill
name: 创建技能
name_en: Create skill
description: 把一套反复使用的做法整理成技能（SKILL.md），保存后在对话里用 @技能标识 调用
description_en: Turn a repeatable procedure into a reusable skill (SKILL.md)
icon: 🧬
---
帮用户把做法整理成一个技能。

1. 先弄清三件事（用户已经说清的不要再问）：技能解决什么问题、什么时候该用、执行步骤和输出格式。
2. 写出完整的 SKILL.md，放在一个 ```skill 代码块里输出，格式：

```skill
---
id: 小写英文-连字符（字母开头）
name: 中文名称
name_en: English name
description: 一句话说明用途和适用时机
description_en: One-sentence English description
icon: 一个表情
---
正文：分步骤写清楚要做什么、调用哪些工具、输出什么格式。
```

3. 正文只写这个平台里能做到的事：查询应用库（`query_database`）、取报表概览（`get_report_overview`）、读对话附件（`read_file`）、发布 HTML 工具（`publish_html_tool`）。
4. 输出草稿后说明：点击代码块下方的「保存为技能」才会生效；管理员也可以让你直接调用 `save_skill` 保存。
