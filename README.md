# Dragon Claw · Digital Human Web Edition

面向华为「运营数字人基座」的独立裁剪版 Node.js 22 Web 部署包（Phase-1），与 `tools-platform/` 桌面版双线并行开发，共享视觉风格与核心数据协议。

## 一、运行环境与合规红线（Spec #244）

- **Runtime**: Node.js `22.21.1`（ESM + Fastify 4，`packageManager: npm`）
- **数据源**: 严格零直连 DB，所有 MySQL / Redis / 网关能力均经 `src/dao/scoped.js` -> `src/dao/base.js` 代理转发基座 REST API；本地开发无基座时自动启用内置内存引擎 (`LOCAL_DEV_MEMORY=1`)。
- **SSO 身份**: 不自建登录与会话，直接从数字人网关注入 Cookie / Header 解析 `iLearningXUserName` / `current_lang`。
- **离线静默**: 前端零外部 CDN 引用（已全部内置 `echarts.min.js`、`exceljs.min.js`、`xlsx.full.min.js`、`html2canvas.min.js`、`jspdf.umd.min.js`），动态适配网关子路径 (`/digital-human/dh/{UUID}/` & `x-forwarded-prefix`)。

## 二、Phase-1 已接入功能

| 模块 | 路由 | 说明 |
| --- | --- | --- |
| 平台首页 & AI 对话 | `/` | 1:1 复刻桌面版外观、模型/配置切换、流式 NDJSON 对话；二期工具卡片保留展示并提示"Web 版暂未开放" |
| 数据抓取 | `/uivf12` | 分类/脚本管理、Fetch AST 解析 (`acorn`)、AI 适配、脚本生成、浏览器插件包下载、自动导入会话（禁用服务端拉起本地 Chrome 跑宏，返回 HTTP 501） |
| 数据导入 | `/sla` | SLA 分类/目标/偏好/规则模板、数据源归档、压缩快照 (`/api/sla/snapshot`)、YuXiang 预览导出 |
| 报表看板 | `/report` | 压缩看板保存 (`/api/db/save`)、失败指标汇总、图片/Excel/手工调整附件 DB 存储、趋势分析 |
| 一键催办 | `/expedite` | `welink_policy_v2` 策略与逾期任务导出、可选接入 `BASE_NOTIFY_URL` 发送通知 |
| AI 智能月报 & 经典月报 | `/monthly` / `/monthly/legacy` | `ai-report.html` 默认入口 + `monthly.html` 经典入口、月报快照、`.msg` Outlook 邮件导出 (`@tutao/oxmsg`) |
| 运营大屏 | `/bigscreen` | 责任人矩阵、月报走势与告警指标看板 |
| 调试诊断台 (`v1` 强化) | 右下角 `🐛 调试模式` | 基座 MySQL/Redis/网关探针一键自检、SSO 身份与脱敏环境面板、SSE 实时后端日志流、自定义通知测试 |

## 三、常用命令

```bash
# 安装依赖（仅内网 Artifactory，跳过 lifecycle scripts）
npm ci --omit=dev --ignore-scripts

# 本地内存模式开发启动 (http://localhost:8000)
npm run dev

# Spec #244 红线静态合规检查
npm run check

# 自动化 E2E 与 Playwright 浏览器联调测试
npm test

# 生成基座平台上传包 dist/dragon-claw-dh-1.0.0.zip
npm run build
```
