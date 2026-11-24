// 平台审计日志（与主线版 platform-audit-repository 对齐的字段与分页）：谁、什么时候、从什么客户端、做了什么。
// 存在统一记录表 biz_records（kind=audit_log）：group_key=客户端类型（便于按平台筛选），name=操作，updated_by=操作人。
// 基座 Web 版没有自建登录：「登录」记的是基座单点登录后首次进入本应用，「登录失败」记的是未登录访问被拒。
// 只有管理员（即主线版的超级管理员）能读，见 core/access.js 的 ADMIN_READS。
import crypto from 'node:crypto';
import { listRecords, countRecords, putRecord, trimRecords } from './record-store.js';

const KIND = 'audit_log';
const MAX_ROWS = 5000;
const PLATFORMS = new Set(['web', 'mobile_web', 'desktop', 'ios', 'android']);
let writes = 0;

/** 真实客户端 IP：优先反向代理透传头 */
export function clientIp(req) {
    const headers = req?.headers || {};
    const pick = (value) => String(value || '').split(',')[0].trim().replace(/^::ffff:/, '').slice(0, 64);
    return pick(headers['cf-connecting-ip']) || pick(headers['x-forwarded-for']) || pick(headers['x-real-ip']) || pick(req?.ip || req?.socket?.remoteAddress);
}

/** 客户端类型、设备、浏览器版本：优先前端带的 X-Client-Platform，其余从 User-Agent 判断 */
export function parseClientInfo(req) {
    const headers = req?.headers || {};
    const ua = String(headers['user-agent'] || '');
    const declared = String(headers['x-client-platform'] || '').trim().toLowerCase();
    const mobile = /iPhone|iPad|iPod|Android/i.test(ua);
    const platform = PLATFORMS.has(declared) ? declared : /Electron/i.test(ua) ? 'desktop' : mobile ? 'mobile_web' : 'web';

    let device = String(headers['x-device-model'] || '').trim();
    if (!device) {
        const ios = /(?:iPhone|iPad|iPod).*? OS (\d+[_\d]*)/i.exec(ua);
        const android = /Android ([\d.]+)(?:; ([^;)]+))?/i.exec(ua);
        const mac = /Mac OS X (\d+[_\d]*)/i.exec(ua);
        const win = /Windows NT ([\d.]+)/i.exec(ua);
        if (ios) device = `${/iPad/i.test(ua) ? 'iPad' : 'iPhone'} (iOS ${ios[1].replace(/_/g, '.')})`;
        else if (android) device = android[2] ? `${android[2].trim()} (Android ${android[1]})` : `Android ${android[1]}`;
        else if (mac) device = `Mac (macOS ${mac[1].replace(/_/g, '.')})`;
        else if (win) device = `Windows ${{ '10.0': '10/11', '6.3': '8.1', '6.1': '7' }[win[1]] || win[1]}`;
        else if (/Linux/i.test(ua)) device = 'Linux';
        else device = ua ? '未知设备' : '';
    }

    const browser = [[/Electron\/([\d.]+)/i, 'Electron v'], [/Edg\/([\d.]+)/i, 'Edge '], [/Chrome\/([\d.]+)/i, 'Chrome '], [/Version\/([\d.]+).*Safari/i, 'Safari '], [/Firefox\/([\d.]+)/i, 'Firefox ']]
        .map(([re, label]) => (re.test(ua) ? label + re.exec(ua)[1] : '')).find(Boolean);
    return { platform, device: device.slice(0, 80), clientVersion: (browser || ua.slice(0, 40)).slice(0, 80), deviceId: String(headers['x-device-id'] || '').trim().slice(0, 80) };
}

/** 记一条审计。永不抛错：审计写失败不能影响业务请求。 */
export async function recordAudit(req, { actor = '', action, target = '', detail = '' } = {}) {
    try {
        if (!action) return null;
        const at = Date.now();
        const client = parseClientInfo(req);
        const sortKey = String(at).padStart(15, '0');
        const row = await putRecord(KIND, {
            id: `${sortKey}-${crypto.randomBytes(4).toString('hex')}`,
            group: client.platform,
            name: String(action).slice(0, 64),
            sortKey,
            updatedBy: String(actor || '').slice(0, 120),
            createdAt: at,
            summary: { ip: clientIp(req), device: client.device, clientVersion: client.clientVersion, deviceId: client.deviceId, target: String(target || '').slice(0, 200), detail: String(detail || '').slice(0, 500) },
            payload: null,
        });
        if (++writes % 100 === 0) await trimRecords(KIND, MAX_ROWS);
        return row;
    } catch {
        return null;
    }
}

// 同一来源在时间窗内只记一次（进程内去重：重启后会多记一条，可以接受）
const seen = new Map();
export function recordAuditOnce(key, windowMs, req, entry) {
    const now = Date.now();
    if (now - (seen.get(key) || 0) < windowMs) return null;
    if (seen.size > 5000) for (const [k, at] of seen) if (now - at > 24 * 3600_000) seen.delete(k);
    seen.set(key, now);
    return recordAudit(req, entry);
}
export const resetAuditDedupe = () => seen.clear();

const toItem = (r) => ({
    id: r.id,
    at: r.createdAt,
    actor: r.updatedBy,
    action: r.name,
    tenantId: '',
    target: r.summary.target || '',
    ip: r.summary.ip || '',
    detail: r.summary.detail || '',
    platform: r.group || 'web',
    device: r.summary.device || '',
    clientVersion: r.summary.clientVersion || '',
    deviceId: r.summary.deviceId || '',
});

export async function listAudit({ page = 1, limit = 20, platform = '', actor = '', action = '' } = {}) {
    const pageSize = Math.min(500, Math.max(1, Number(limit) || 20));
    const group = platform && platform !== 'all' ? String(platform) : '';
    let items;
    let total;
    let current = Math.max(1, Number(page) || 1);
    if (actor || action) {
        // 按操作人 / 操作筛选的场景少，取回后在内存里过滤
        const all = (await listRecords(KIND, { group, limit: MAX_ROWS, maxRows: MAX_ROWS })).filter((r) => (!actor || r.updatedBy === String(actor)) && (!action || r.name === String(action)));
        total = all.length;
        items = all.slice((current - 1) * pageSize, current * pageSize);
    } else {
        total = await countRecords(KIND, { group });
        items = await listRecords(KIND, { group, limit: pageSize, offset: (current - 1) * pageSize, maxRows: MAX_ROWS });
    }
    return { items: items.map(toItem), total, page: current, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
}

/** 统计今日登录次数、今日/近 7 日活跃操作人及各账号最近活跃时间（基于轻量审计元数据） */
export async function getLoginStats() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const weekStart = todayStart - 6 * 86400_000;
    const rows = await listRecords(KIND, { limit: MAX_ROWS, maxRows: MAX_ROWS }).catch(() => []);
    let todayLogins = 0;
    let totalLogins = 0;
    const todayActiveActors = new Set();
    const weekActiveActors = new Set();
    const lastSeenByActor = new Map();
    for (const r of rows) {
        const action = String(r.name || '');
        const actor = String(r.updatedBy || '').trim().toLowerCase();
        const ts = Number(r.sortKey) || (r.createdAt ? Date.parse(r.createdAt) : 0) || 0;
        const isLogin = action === 'login' || action === 'dev_login';
        if (isLogin) {
            totalLogins += 1;
            if (ts >= todayStart) todayLogins += 1;
        }
        if (!actor || actor === '（未登录）' || action === 'login_failed') continue;
        if (ts > (lastSeenByActor.get(actor) || 0)) lastSeenByActor.set(actor, ts);
        if (ts >= todayStart) todayActiveActors.add(actor);
        if (ts >= weekStart) weekActiveActors.add(actor);
    }
    return {
        todayStart,
        weekStart,
        todayLogins,
        totalLogins,
        todayActiveActors,
        weekActiveActors,
        lastSeenByActor,
    };
}
