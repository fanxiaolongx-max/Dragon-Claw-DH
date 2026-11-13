// 权限模型（与桌面版 server.js 的写保护规则一致）：
//   - GET 对所有人开放（调试与管理员名单除外）；
//   - 非 GET 默认仅管理员，下面的白名单是普通用户也能做的个人级操作。
// 管理员来源：环境变量 DH_ADMIN_USERS ∪ 应用库 sys_kv_store['dh_admins']；
// 两者都为空时，首位被网关识别出工号的访问者自动成为管理员（基座上通常无法自行配置环境变量）。
import { config } from '../config.js';
import { pushLog } from './log-ring.js';
import { kvGet, kvSet, isMemoryMode } from '../dao/scoped.js';

const ADMINS_KEY = 'dh_admins';
const CACHE_MS = 30_000;
let cache = { at: 0, list: null };
let bootstrapping = null;

const norm = (v) => String(v || '').trim().toLowerCase();

function stripFirstLetter(id) {
    const s = norm(id);
    // 工号去掉可选首字母（如 z00569258 -> 00569258、dwx1545337 -> wx1545337），避免误匹配普通英文名
    const m = /^[a-z]((?:[a-z]{1,2})?\d{4,})$/.exec(s);
    return m ? m[1] : '';
}

export function isSameUserId(a, b) {
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const sx = stripFirstLetter(x);
    const sy = stripFirstLetter(y);
    return Boolean((sx && sx === y) || (sy && sy === x));
}

export function hasAdminMatch(list, username) {
    return Array.isArray(list) && list.some((entry) => isSameUserId(entry, username));
}

async function storedAdmins(force = false) {
    if (!force && cache.list && Date.now() - cache.at < CACHE_MS) return cache.list;
    try {
        const raw = await kvGet(ADMINS_KEY, []);
        cache = { at: Date.now(), list: Array.isArray(raw) ? raw.map(norm).filter(Boolean) : [] };
    } catch {
        // 应用库不可用时不放大权限：按“没有库内管理员”处理，但不缓存，库恢复后立即生效
        return cache.list || [];
    }
    return cache.list;
}

export async function listAdmins() {
    return { env: config.adminUsers, stored: await storedAdmins(true), openAdmin: config.openAdmin };
}

export async function saveAdmins(users) {
    const list = [...new Set((Array.isArray(users) ? users : []).map(norm).filter(Boolean))].slice(0, 200);
    await kvSet(ADMINS_KEY, list);
    cache = { at: Date.now(), list };
    return list;
}

export async function resolveAdmin(identity) {
    if (isMemoryMode() || config.openAdmin) return true;
    if (!identity.identified) return false;
    const me = norm(identity.username);
    if (hasAdminMatch(config.adminUsers, me)) return true;
    const stored = await storedAdmins();
    if (hasAdminMatch(stored, me)) return true;
    if (config.adminUsers.length || stored.length) return false;
    // 还没有任何管理员：首位已识别用户自动成为管理员
    if (!bootstrapping) {
        bootstrapping = (async () => {
            const fresh = await storedAdmins(true);
            if (fresh.length) return fresh;
            const list = await saveAdmins([me]);
            pushLog({ level: 'WARN', category: 'AUTH', message: `首位访问者 ${me} 已自动成为管理员`, userId: me });
            return list;
        })().catch(() => []).finally(() => { bootstrapping = null; });
    }
    return hasAdminMatch(await bootstrapping, me);
}

const USER_WRITES = [
    ['*', /^\/auth\//],
    ['POST', /^\/db\/config\/monthly_report_titles$/],
    ['*', /^\/monthly-snapshots(?:\/[^/]+)?$/],
    ['*', /^\/ai-report(?:\/.*)?$/],
    ['POST', /^\/uiv\/run-uivision-macro$/],
    ['POST', /^\/platform-metrics\/open$/],
    ['POST', /^\/recent-nav$/],
    ['PUT', /^\/sidebar-menu$/],
    ['PUT', /^\/favorite-nav$/],
    ['POST', /^\/platform-promotions\/clicks$/],
    ['POST', /^\/desktop-pet\/language$/],
    ['POST', /^\/home\/bootstrap$/],
    ['POST', /^\/ai\/(?:proactive-alert-message|enhance-prompt|chat|uploads|compact|translate)$/],
    ['PUT', /^\/ai\/conversation-list$/],
    ['*', /^\/ai\/sessions(?:\/.*)?$/], // 路由内校验会话归属
    ['POST', /^\/report-msg\/export$/],
    ['POST', /^\/custom-tools$/], // 普通用户发布的工具只有自己可见
    ['POST', /^\/custom-tools\/[^/]+\/bridge$/], // 自定义 HTML 工具只读数据桥（路由内校验可见性与只读 SQL）
    ['POST', /^\/agent-workspace\/approvals\/[^/]+$/], // 只能批自己发起的（路由内校验）
    ['*', /^\/ai\/schedules(?:\/[^/]+)?$/], // 定时任务只属于创建者（服务内校验）
    ['DELETE', /^\/custom-tools\/[^/]+$/], // 路由内校验归属
    ['*', /^\/alert-center\/events(?:\/.*)?$/], // 消息只属于本人
    ['POST', /^\/alert-center\/ai\/backfill$/], // 只补本人消息的 AI 摘要
    ['POST', /^\/duty-roster$/], // 已识别用户可维护各月份值班表（与桌面版一致）
    ['POST', /^\/surveys\/submissions$/], // 填问卷
    // 奖励申报：申报人维护自己的草稿、发布、提交、传证据，公示期提异议；归属和状态在路由内校验
    ['POST', /^\/reward-program\/(?:applications(?:\/[^/]+\/(?:save|submit|publish|objections))?|evidence)$/],
    ['DELETE', /^\/reward-program\/applications\/[^/]+$/],
    // 负向事件：普通用户可提交草稿、传证据、删自己的草稿；发布和归属在路由内校验
    ['POST', /^\/department-reward-penalty\/(?:records|evidence)$/],
    ['DELETE', /^\/department-reward-penalty\/records\/[^/]+$/],
    ['*', /^\/meeting-snapshots(?:\/.*)?$/], // 已识别用户可维护会议考勤快照与名单设置（与主线版一致）
    ['*', /^\/(?:operation-incentive-snapshots|incentive-snapshots)(?:\/[^/]+)?$/], // 已识别用户可维护操作激励快照
    ['*', /^\/requirements(?:\/.*)?$/], // 提需求、改自己的需求；流转与指派在服务内校验管理员
];
// 数据探索只给管理员（基座 Web 版的管理员就是超级管理员，与主线版「仅超级管理员」一致）；对话里的查库工具不受影响
const ADMIN_READS = [/^\/debug(?:\/|$)/, /^\/db-explorer(?:\/|$)/, /^\/auth\/admins$/, /^\/platform-metrics\/service-status\/(?:logs|failures)$/];
const ANON_ALLOWED_APIS = [/^\/auth\/(?:me|logout)$/, /^\/platform-logo\/image$/, /^\/(?:healthz|health|ping)$/];

/** 生产环境（已注入基座 API 且未开启免鉴权/内存模式）强制要求已识别身份。 */
export function isAuthEnforced() {
    return !isMemoryMode() && !config.openAdmin && Boolean(config.baseQueryUrl);
}

/** 未登录时对业务 API 返回 401 拒绝原因；管理员只读调试接口保留给 denyReason 判 403。 */
export function authRequiredReason(apiPath, identity) {
    if (!isAuthEnforced() || identity?.identified) return null;
    if (ANON_ALLOWED_APIS.some((re) => re.test(apiPath))) return null;
    if (ADMIN_READS.some((re) => re.test(apiPath))) return null;
    return '未登录或登录状态已失效，请先登录数字人平台';
}

/** 返回 null 表示放行，否则返回拒绝原因。path 为去掉 /api 前缀后的路径。 */
export function denyReason(method, path, identity) {
    if (identity.isAdmin) return null;
    const m = String(method || 'GET').toUpperCase();
    if (ADMIN_READS.some((re) => re.test(path))) return '该功能仅管理员可用';
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return null;
    if (USER_WRITES.some(([verb, re]) => (verb === '*' || verb === m) && re.test(path))) return null;
    return '需要管理员权限';
}
