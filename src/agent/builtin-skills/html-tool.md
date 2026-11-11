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
2. 工具运行在隔离的沙箱里：不能读取平台登录信息，不能调用平台接口，不能用 localStorage/Cookie。需要数据时让用户粘贴或选择本地文件，在浏览器里处理。
3. 界面：中文，简洁，移动端可用；有明确的空状态、错误提示；处理大文件时给进度提示。
4. 先在回复里用 ```html 代码块给出完整代码，方便用户预览。
5. 用户确认后调用 `publish_html_tool` 发布（给出 name、description、icon、html）；发布成功后把返回的链接告诉用户。普通用户发布的工具只有自己可见，管理员发布的所有人可见。
