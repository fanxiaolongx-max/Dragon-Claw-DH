# Dragon Claw · 数字人 Web 版

Dragon Claw 平台面向「运营数字人基座」的裁剪版 Web 应用（一期）。与桌面版双线并行：界面沿用桌面版前端，后端按《运营数字人 · Node.js 服务开发规范 v1.0》重写——Node.js 22.21.1、ESM、Fastify，数据只走基座 REST，身份由底座注入。

## 一期范围

| 模块 | 路径 | 说明 |
| --- | --- | --- |
| 首页与 AI 对话 | `/` | 精简版 Dragon Claw 智能体：对话中可直接查询应用库、读取报表概览、读附件、调用技能、生成并发布 HTML 工具；外观与桌面版一致，桌面版专属入口已隐藏（清单见 `static/css/dh-web-trim.css`） |
| 技能 | 首页「技能·插件·工具」 | 7 个内置技能；管理员可在对话里创建、导入、改名、删除；所有人可用 `@技能标识` 调用 |
| 自定义 HTML 工具 | `/custom-tools/<标识>/` | 对话生成或手工导入的单页工具，在隔离沙箱里运行 |
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

## AI 智能体

对话接口 `/api/ai/chat` 背后是一个工具调用循环（`src/agent/`），事件协议与桌面版相同，前端直接复用。

| 工具 | 作用 |
| --- | --- |
| `query_database` / `read_database_table` / `database_schema` / `list_databases` | 只读查询应用库的业务表；注入了 `BUSINESS_DATASOURCE_NAME` 时也能查平台授权的业务数据源 |
| `get_report_overview` | 最新一期报表的总分、分类得分、未达标指标 |
| `read_file` | 读取对话里上传的附件（文本、Excel、Word、PPT 会提取成文字） |
| `read_skill` / `save_skill` | 读取、保存技能 |
| `publish_html_tool` | 把对话里生成的 HTML 发布成自定义工具 |
| `find_platform_tools` | 平台有哪些功能页面、怎么打开 |
| `update_plan` / `ask_user` | 多步任务的进度清单；需要用户拍板时给出选项按钮 |
| `calculate` | 精确计算占比、增减幅、工作日等（自写解析器，不用 eval） |
| `memory` | 按工号保存的长期偏好，跨对话生效；拒收密码、密钥 |
| `list_uiv_scripts` / `read_uiv_script` / `save_uiv_script` / `move_uiv_script` / `delete_uiv_script` | 查看和管理数据抓取脚本（改动仅管理员） |
| `query_data` | 分析对话里上传的 Excel / CSV：服务端筛选、分组、聚合，只把结果给模型 |
| `view_image` | 看对话里上传的图片（消息里附带的图片会自动附给模型） |
| `insert_database_row` / `update_database_rows` / `delete_database_rows` | 修改 8 张业务配置表（仅管理员；必须带条件；单次最多 200 行） |
| `send_notification` | 经基座通知接口发邮件（仅管理员） |

**写操作要确认**：改数据、发通知、删脚本之前，对话里会弹出确认卡（写明影响多少行、发给谁），只有发起人能点「允许」，5 分钟不确认按取消。定时任务在无人值守时运行，不执行任何写操作。

**长对话**：前端只带最近 12 条消息；更早的消息由服务端从会话记录里补上，攒够 6 条或超出模型上下文预算时压缩成摘要（`/compact` 可手动压缩）。新对话由模型起一个短标题。

**故障切换**：模型请求在还没输出内容前遇到限流或网关抖动会重试一次；在「AI 助手」里打开「主模型异常时自动切换」后，还会换到其他已配置密钥的方案，某个方案连续失败 3 次会被跳过 60 秒。

**脱敏**：所有工具结果在交给模型之前统一去掉口令、令牌、JWT、密钥、私钥和已配置的模型密钥。

**定时任务**：对话里输入 `/schedule 明天 9:00 汇总昨天的未达标指标`、`/schedule 每个工作日 9:30 看一下待办` 等，到点以创建者身份执行，结果写进对话。左侧「定时任务」查看和取消。工作日沿用桌面版默认日历（周日至周四）。

- **模型接口**：OpenAI 兼容接口（多数内网网关）和 Anthropic Messages，都走流式 + 工具调用。网关不支持工具调用时自动退回纯对话。在「全局设置 → AI 助手」里配置。
- **查库的边界**：只允许单条 `SELECT`；应用库只开放业务表（导入、报表、月报、抓取脚本），对话记录、模型密钥、管理员名单、附件等表查不到；结果最多 500 行，大字段自动省略。规则在 `src/agent/tools.js`，用例在 `tests/agent.test.js`。
- **HTML 工具的边界**：页面在不带 `allow-same-origin` 的沙箱里运行，拿不到平台的登录信息；CSP 禁止一切网络请求和弹窗，数据带不出去。需要平台数据时用页面内置的只读接口 `DH.query(sql)`、`DH.report()`、`DH.me()`，权限与打开工具的人相同。普通用户发布的只有自己可见，管理员发布的所有人可见。
- **附件**：单个最大 20MB，每人保留最近 60 个，只有上传者本人能读。精简包不含上传和 Excel 解析组件，附件功能需要完整包。

## 权限

身份来自底座网关注入的 Cookie `iLearningXUserName`（或 `x-user-*` 请求头），应用不自建登录。

- 管理员 = 环境变量 `DH_ADMIN_USERS`（逗号分隔工号）∪ 调试面板里维护的名单；两者都为空时，首位已识别用户自动成为管理员。
- 不能配环境变量、又想在上线前固定管理员：`db/init.sql` 末尾有一行注释掉的预置语句，填上工号后随建表脚本一起交给 DBA 执行。
- 管理员名单被别人占了：让 DBA 把 `sys_kv_store` 里 `kv_key = 'dh_admins'` 的值改成 `["你的工号"]`，30 秒内生效。
- 普通用户可以读所有页面，可以对话、编辑 AI 月报、维护月报快照和个人偏好；改全局配置、导入数据、删除快照、调试接口都需要管理员。规则与桌面版一致，见 `src/core/access.js`。
- 拿不到工号的访问者按普通用户处理，永远不会成为管理员。
- 对话会话只属于创建者。
- 技能：所有人可用，只有管理员能新增和修改。自定义 HTML 工具：所有已识别用户都能发布自己的。

## 安全说明（请知悉）

- **基座允许其他应用只读本应用的库。** 对话内容、月报正文、导入的数据对同平台其他应用可读，这是平台机制，应用内无法阻止。
- **模型 API Key 加密后入库**，接口不回显。加密口令取环境变量 `DH_SECRET_KEY`；未配置时按应用 UUID 派生，只能避免明文直接出现在查询结果里，不构成真正的保密。需要保密时请让平台注入 `DH_SECRET_KEY`，或直接用环境变量 `AI_API_KEY` 提供密钥。
- 日志（stdout 与调试面板）不记录 Cookie、密钥和 SQL 里的字面量。

## 真库联调（上基座前）

`devtools/real-base/` 是一个开发用的“真库基座”：按基座 REST 约定把 SQL 交给真实 MySQL 8 执行，并模拟网关（`/digital-human/dh/{UUID}/` 前缀 + 工号 Cookie）。它不随应用包发布。

```bash
# 在一台有 Docker 的 Linux 机器上：MySQL 8 + 真库基座 + 应用，对外只占一个端口 5400
bash devtools/real-base/deploy.sh /path/to/dragon-claw-dh-<版本>.zip

# 在开发机上：把全部接口打到真库上，报告 SQL 报错和 5xx
node devtools/real-base/sweep.mjs http://<那台机器>:5400
# 让接口测试的 SQL 也在真库上执行
DH_REAL_BASE=http://<那台机器>:5400 node --test --test-concurrency=1 tests/   # 各用例共用一个测试库，必须串行
```

浏览器打开 `http://<那台机器>:5400/`，输入任意工号即可以该身份进入应用，用来验证权限和前缀。页面底部显示真库上的 SQL 报错次数。

## 本地开发

```bash
npm run dev      # 内存模式，http://localhost:8000，数据重启即丢，页面底部有提示
npm run check    # 规范红线检查
npm test         # 接口、权限与浏览器端到端测试
```

本地 Node 版本不是 22.21.1 时，`npm ci` 会因 `engine-strict` 拒绝安装，这是规范要求；可临时加 `--engine-strict=false`。浏览器端到端测试需要 Playwright，用 `PLAYWRIGHT_MODULE_PATH`、`CHROMIUM_EXECUTABLE_PATH` 指定位置，找不到时自动跳过。

接真实基座联调：复制 `.env.example` 为 `.env`，填入基座地址并设 `LOCAL_DEV_MEMORY=0`。

## 启动与排障

`run.js` 是一个 CommonJS 启动器，应用代码在 `src/`（由 `src/package.json` 声明 ESM）。

**为什么根目录不是 ESM**：基座启动应用时会在应用目录里放一个它自己的 CommonJS 文件 `dh-identity-loader.js` 并预加载。根目录的 `package.json` 如果声明 `"type": "module"`，Node 会把它当成 ES 模块，报 `require is not defined in ES module scope`，应用还没运行就退出（1.0.0 在基座上就是这样失败的）。`npm run check` 会拦住这种写法。

**启动日志**（stdout，JSON，一行一条，`category` 为 `BOOT`）：

| 日志 | 内容 |
| --- | --- |
| `boot: 启动环境` | Node 版本、工作目录、启动参数、预加载的模块、应用目录里的文件（标出不属于本包的）、环境变量是否注入（只报有无，不打印取值） |
| `依赖检查：…` | 加载应用之前逐个核对：必需依赖（fastify、@fastify/static、pino、undici）和可选依赖是否装上、版本是否与锁文件一致、锁文件里的每个包是否都在 `node_modules`、`npm ci` 是否正常结束、锁文件下载地址是不是内网源。每个问题单独一行，带「处理」建议。必需依赖缺失时直接中止启动，不再抛一屏 `ERR_MODULE_NOT_FOUND` |
| `boot: 这些环境变量没有注入` | 缺了哪些基座地址类变量 |
| `boot: 加载应用模块` / `模块加载完成` / `启动完成` | 各阶段耗时 |
| `启动失败（阶段）` | 错误信息、错误码、堆栈前 12 行，以及针对常见原因的处理提示；同时写到 stderr |
| `server started` | 开始监听 |

启动环境快照也会出现在调试面板的「实时后端日志」里；「身份与环境」页签直接显示依赖检查结论和平台注入的文件。

## 与规范的对应

| 规范要求 | 实现 |
| --- | --- |
| 统一响应体、业务失败 HTTP 200（§8） | 前端垫片声明 `x-dh-envelope` 后，服务端返回 `{code,message,data,total,elapsed_ms,cache_hit}`；垫片再还原成桌面版前端的原协议，页面代码不用改。未声明的调用方保持原协议 |
| API 基址按路径拼接（§12.2） | `static/js/api.js`；从桌面版沿用的页面由 `static/js/shared/dh-runtime.js` 统一改写 |
| 唯一取数入口（§7.3） | `src/dao/scoped.js`，超过单页 1000 行自动翻页；超过约 128K 字符的字段（快照、图片、原始文件）自动切片存进 `dh_chunks`，读取时拼回，单条 SQL 始终远小于 1MB |
| 健康检查（§9） | `/api/healthz`，同时提供 `/health`、`/healthz`；基座探测结果缓存 10 秒，基座抖动不会导致应用被重启 |
| 反代前缀（§11.3） | `rewriteUrl` 剥离 `x-forwarded-prefix`，网关已剥离时原样通过 |
| 日志（§10） | pino 结构化 JSON 输出到 stdout |

已知偏离：`static/` 中沿用自桌面版的脚本仍含 `/api/...` 字面量（运行时由垫片改写，功能正常）。如果平台对 `static/` 做字面量扫描，需要再做一次机械替换。

## 对标与规划

与桌面版 Dragon Claw、基座 Node 规范的逐项对比、搬迁决策、优先级和路线图见 [docs/对标与规划.md](docs/对标与规划.md)（同名 `.xlsx` 可筛选）。

## 前端与桌面版的关系

`static/` 来自桌面版 `tools-platform/frontend` 的一期页面子集，另有少量数字人专用文件和改动，清单见 `frontend-overlay.json`。桌面版前端更新后，运行 `node scripts/frontend-drift.mjs <tools-platform/frontend 路径>` 查看哪些文件需要同步。
