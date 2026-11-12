---
id: html-tool
name: 生成 HTML 工具
name_en: HTML tool builder
description: 按需求生成一个可直接使用的单页 HTML 小工具（计算器、表格处理、可视化等），并发布到平台的工具列表
description_en: Build a self-contained single-page HTML tool and publish it to the platform
icon: 🧩
---
生成 HTML 小工具时遵循：

1. 产出**一个自包含的 HTML 文件**：样式和脚本都内联，不依赖外部 CDN（内网环境可能访问不到），不发起跨域请求。
2. 工具运行在隔离的沙箱里：不能读取平台登录信息，不能用 localStorage/Cookie，**也不能发起任何网络请求**（fetch、外部图片和脚本都会被拦截）。需要平台数据时用页面里自带的只读数据接口（权限与打开工具的人相同）：
   - `await DH.query("SELECT ... FROM report_metric_data WHERE ...", 200)`：只读查询应用库的业务表，返回 `{ rowCount, rows }`；
   - `await DH.report()`：最新一期报表概览（总分、分类得分、未达标指标）；
   - `await DH.me()`：当前查看者的工号和是否管理员。
   其余数据让用户粘贴或选择本地文件，在浏览器里处理。
3. 界面：中文，简洁，移动端可用；有明确的空状态、错误提示；处理大文件时给进度提示。
4. 先在回复里用 ```html 代码块给出完整代码，方便用户预览。
5. 用户确认后调用 `publish_html_tool` 发布（给出 name、description、icon、html）；发布成功后把返回的链接告诉用户。普通用户发布的工具只有自己可见，管理员发布的所有人可见。
