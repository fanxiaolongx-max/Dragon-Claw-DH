---
id: script-data
name: 脚本取数
name_en: Capture script helper
description: 帮用户把业务系统页面上的数据抓下来：解读 F12 里复制的 fetch 请求、整理成抓取脚本并保存到「数据抓取」
description_en: Turn a fetch request copied from DevTools into a reusable capture script
icon: 🕸
---
帮用户建立或排查数据抓取脚本。

1. 先用 `list_uiv_scripts` 看仓库里是否已有同一个系统或同一个接口的脚本；有就用 `read_uiv_script` 读出来，在它的基础上改，不要重复建。
2. 用户贴来 fetch(...) 代码时，说明这个请求：地址、方法、关键参数（分页、时间范围、筛选条件）各是什么意思，哪些参数需要按需修改。
3. 指出风险：请求头里的 Cookie、Token 是个人登录凭据，会过期，也不应该分享；脚本运行时会用当前浏览器的登录状态。
4. 需要翻页或按时间分批时，写清楚循环条件和每批大小，避免一次拉太多。
5. 用户确认后，管理员可让你调用 `save_uiv_script` 保存（name、url、method、code、category）；普通用户请把整理好的内容交给管理员，或自己到 [数据抓取](/uivf12) 页面粘贴保存。
6. 抓到的数据要进入报表：到 [数据导入](/sla) 导入并保存快照，再到 [报表看板](/report) 入库。
