# Dragon Claw · 数字人 Web 版

Dragon Claw 平台面向「运营数字人基座」的裁剪版 Web 应用（一期）。与桌面版双线并行：界面沿用桌面版前端，后端按《运营数字人 · Node.js 服务开发规范 v1.0》重写——Node.js 22.21.1、ESM、Fastify，数据只走基座 REST，身份由底座注入。

## 一期范围

| 模块 | 路径 | 说明 |
| --- | --- | --- |
| 首页与 AI 对话 | `/` | 外观与桌面版一致；未开放的工具保留卡片，点击提示“Web 版暂未开放” |
| 数据抓取 | `/uivf12` | 脚本与分类管理、fetch 代码解析、AI 适配、宏生成；不在服务端拉起本地浏览器跑宏 |
| 数据导入 | `/sla` | 分类、目标、规则模板、快照、裕湘模板导出 |
| 报表看板 | `/report` | 快照入库、趋势、手工校准附件（存应用库） |
| 一键催办 | `/expedite` | 逾期任务、分发策略，可经基座通知接口发送 |
| 月报 | `/monthly`、`/monthly/legacy` | AI 月报与经典月报，`.msg` 导出 |
| 大屏看板 | `/bigscreen` | 责任人矩阵、趋势与告警指标 |
| 调试面板 | 右下角「调试模式」 | 仅管理员可见：基座读写、Redis、行数上限、SQL 大小、流式、出站探针，实时日志，管理员名单 |

## 上基座

1. `npm run build` 生成 `dist/dragon-claw-dh-<版本>.zip`（完整包），`npm run build:lite` 生成精简包。
2. 把 `db/init.sql` 交 DBA 建表，上传 ZIP 创建应用。
3. 用自己的工号第一个打开应用——首位被识别出工号的访问者自动成为管理员。
4. 打开右下角「调试模式」，按 [docs/基座验证清单.md](docs/基座验证清单.md) 逐项验证。

**两个包怎么选**：先传完整包。如果创建应用时依赖安装失败（内网源缺少 `exceljs`、`@tutao/oxmsg`、`acorn`、`jszip`、`@fastify/multipart` 中的某一个），改传精简包——它只依赖 `fastify`、`@fastify/static`、`pino`、`undici`，应用能正常启动，受影响的功能（服务端 Excel 导出、`.msg` 导出、fetch 代码解析、报表备份包、文件上传）会提示改用完整包。

> `package-lock.json` 里的下载地址指向内网源，但它是在外网生成后替换地址得到的（包名、版本、完整性校验值不变）。合规收尾时请在内网机器上执行一次 `npm install` 重新生成并提交。

## 权限

身份来自底座网关注入的 Cookie `iLearningXUserName`（或 `x-user-*` 请求头），应用不自建登录。

- 管理员 = 环境变量 `DH_ADMIN_USERS`（逗号分隔工号）∪ 调试面板里维护的名单；两者都为空时，首位已识别用户自动成为管理员。
- 普通用户可以读所有页面，可以对话、编辑 AI 月报、维护月报快照和个人偏好；改全局配置、导入数据、删除快照、调试接口都需要管理员。规则与桌面版一致，见 `src/core/access.js`。
- 拿不到工号的访问者按普通用户处理，永远不会成为管理员。
- 对话会话只属于创建者。

## 安全说明（请知悉）

- **基座允许其他应用只读本应用的库。** 对话内容、月报正文、导入的数据对同平台其他应用可读，这是平台机制，应用内无法阻止。
- **模型 API Key 加密后入库**，接口不回显。加密口令取环境变量 `DH_SECRET_KEY`；未配置时按应用 UUID 派生，只能避免明文直接出现在查询结果里，不构成真正的保密。需要保密时请让平台注入 `DH_SECRET_KEY`，或直接用环境变量 `AI_API_KEY` 提供密钥。
- 日志（stdout 与调试面板）不记录 Cookie、密钥和 SQL 里的字面量。

## 本地开发

```bash
npm run dev      # 内存模式，http://localhost:8000，数据重启即丢，页面底部有提示
npm run check    # 规范红线检查
npm test         # 接口、权限与浏览器端到端测试
```

本地 Node 版本不是 22.21.1 时，`npm ci` 会因 `engine-strict` 拒绝安装，这是规范要求；可临时加 `--engine-strict=false`。浏览器端到端测试需要 Playwright，用 `PLAYWRIGHT_MODULE_PATH`、`CHROMIUM_EXECUTABLE_PATH` 指定位置，找不到时自动跳过。

接真实基座联调：复制 `.env.example` 为 `.env`，填入基座地址并设 `LOCAL_DEV_MEMORY=0`。

## 与规范的对应

| 规范要求 | 实现 |
| --- | --- |
| 统一响应体、业务失败 HTTP 200（§8） | 前端垫片声明 `x-dh-envelope` 后，服务端返回 `{code,message,data,total,elapsed_ms,cache_hit}`；垫片再还原成桌面版前端的原协议，页面代码不用改。未声明的调用方保持原协议 |
| API 基址按路径拼接（§12.2） | `static/js/api.js`；从桌面版沿用的页面由 `static/js/shared/dh-runtime.js` 统一改写 |
| 唯一取数入口（§7.3） | `src/dao/scoped.js`，超过单页 1000 行自动翻页 |
| 健康检查（§9） | `/api/healthz`，同时提供 `/health`、`/healthz`；基座探测结果缓存 10 秒，基座抖动不会导致应用被重启 |
| 反代前缀（§11.3） | `rewriteUrl` 剥离 `x-forwarded-prefix`，网关已剥离时原样通过 |
| 日志（§10） | pino 结构化 JSON 输出到 stdout |

已知偏离：`static/` 中沿用自桌面版的脚本仍含 `/api/...` 字面量（运行时由垫片改写，功能正常）。如果平台对 `static/` 做字面量扫描，需要再做一次机械替换。

## 前端与桌面版的关系

`static/` 来自桌面版 `tools-platform/frontend` 的一期页面子集，另有少量数字人专用文件和改动，清单见 `frontend-overlay.json`。桌面版前端更新后，运行 `node scripts/frontend-drift.mjs <tools-platform/frontend 路径>` 查看哪些文件需要同步。
