// 首页的友情链接与平台推广：配置存应用库的键值表，全员可见、管理员维护。
// 与主线版的差别：
//   - 没有预置的链接（主线版预置的是公网站点，内网打不开），由管理员自己添加；
//   - 没有「API 中转」和桌面卡片堆；
//   - 可用性探测不开后台定时器（多实例下会重复探测）：有人打开首页且上次结果过期时顺带探测一次。
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { BusinessError } from '../core/errors.js';
import { getSetting, saveSetting } from './system-service.js';

const text = (value, max) => String(value ?? '').trim().slice(0, max);
const clampInt = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

function normalizeUrl(value, label) {
    const raw = String(value || '').trim();
    if (!raw) throw new BusinessError(`${label}地址不能为空`);
    if (raw.length > 2048) throw new BusinessError(`${label}地址过长`);
    let parsed;
    try { parsed = new URL(raw); } catch { throw new BusinessError(`${label}地址无效：${raw.slice(0, 80)}`); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new BusinessError(`${label}仅支持 HTTP 或 HTTPS 地址`);
    if (parsed.username || parsed.password) throw new BusinessError(`${label}地址不能包含账号或密码`);
    return parsed.toString();
}
const hashId = (prefix, url, index) => `${prefix}_${crypto.createHash('sha1').update(`${url}:${index}`).digest('hex').slice(0, 12)}`;
function uniqueId(raw, prefix, url, index, used) {
    let id = text(raw, 64).replace(/[^a-zA-Z0-9_-]+/g, '_');
    for (let salt = index; !id || used.has(id); salt += used.size + 1) id = hashId(prefix, url, salt);
    used.add(id);
    return id;
}

// ── 友情链接 ─────────────────────────────────────────────
const LINKS_KEY = 'friend_links_config';
const LINKS_STATUS_KEY = 'friend_links_status';
const PROBE_TIMEOUT_MS = 6000;
const PROBE_BODY_BYTES = 16 * 1024;
let probing = null;

function normalizeLinksConfig(input = {}) {
    const raw = Array.isArray(input?.links) ? input.links : [];
    if (raw.length > 40) throw new BusinessError('友情链接最多支持 40 个');
    const used = new Set();
    const links = raw.map((item, index) => {
        const url = normalizeUrl(item?.url, '友情链接');
        const name = text(item?.name, 40);
        if (!name) throw new BusinessError('链接名称不能为空');
        return {
            id: uniqueId(item?.id, 'link', url, index, used),
            icon: Array.from(text(item?.icon, 16) || '🔗').slice(0, 4).join(''),
            name,
            nameEn: text(item?.nameEn, 60),
            url,
        };
    });
    return { schemaVersion: 1, links, probeIntervalMinutes: clampInt(input?.probeIntervalMinutes, 10, 1440, 30) };
}

async function linkStatuses() {
    const value = await getSetting(LINKS_STATUS_KEY, null);
    return { byId: value?.byId && typeof value.byId === 'object' ? value.byId : {}, lastProbeAt: value?.lastProbeAt || null };
}

// 探测目标由管理员配置，内网地址是正常情况；只拦本机、链路本地和云平台元数据地址
function isBlockedAddress(address) {
    const value = String(address || '').toLowerCase().split('%')[0];
    if (value.startsWith('::ffff:')) return isBlockedAddress(value.slice(7));
    if (net.isIPv4(value)) {
        const [a, b] = value.split('.').map(Number);
        return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
    }
    if (net.isIPv6(value)) return value === '::' || value === '::1' || /^fe[89ab]/.test(value);
    return true;
}
async function assertProbeTarget(urlValue) {
    const parsed = new URL(urlValue);
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('不探测本机地址');
    const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((r) => r.address);
    if (!addresses.length || addresses.some(isBlockedAddress)) throw new Error('不探测本机或链路本地地址');
    return parsed;
}

async function probeLink(link) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const done = (status, httpStatus, message, finalUrl = link.url) => ({ status, httpStatus, latencyMs: Date.now() - startedAt, checkedAt: new Date().toISOString(), finalUrl, message });
    try {
        let current = await assertProbeTarget(link.url);
        for (let hop = 0; hop <= 4; hop += 1) {
            const response = await fetch(current, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'Dragon-Claw-Link-Monitor/1.0', Range: `bytes=0-${PROBE_BODY_BYTES - 1}` } });
            const location = response.headers.get('location');
            if (response.status >= 300 && response.status < 400 && location) {
                await response.body?.cancel().catch(() => {});
                current = await assertProbeTarget(new URL(location, current).toString());
                continue;
            }
            await response.body?.cancel().catch(() => {});
            return response.status < 400 ? done('online', response.status, '可正常访问', current.toString()) : done('offline', response.status, `HTTP ${response.status}`, current.toString());
        }
        return done('offline', null, '重定向次数过多');
    } catch (error) {
        return done('offline', null, error?.name === 'AbortError' ? '连接超时' : String(error?.cause?.code || error?.message || '无法访问').slice(0, 160));
    } finally {
        clearTimeout(timer);
    }
}

export async function getFriendLinks({ refreshIfStale = false } = {}) {
    const [config, stored] = await Promise.all([getSetting(LINKS_KEY, null).then((v) => normalizeLinksConfig(v || {})), linkStatuses()]);
    const live = new Set(config.links.map((l) => l.id));
    const intervalMs = config.probeIntervalMinutes * 60_000;
    const last = stored.lastProbeAt ? Date.parse(stored.lastProbeAt) : 0;
    if (refreshIfStale && config.links.length && !probing && Date.now() - last > intervalMs) probeFriendLinks().catch(() => {});
    return {
        ...config,
        statuses: Object.fromEntries(Object.entries(stored.byId).filter(([id]) => live.has(id))),
        lastProbeAt: stored.lastProbeAt,
        nextProbeAt: last ? new Date(last + intervalMs).toISOString() : null,
        isProbing: Boolean(probing),
        desktopAutoInstallAvailable: false,
    };
}

export async function saveFriendLinks(input) {
    await saveSetting(LINKS_KEY, normalizeLinksConfig(input));
    return getFriendLinks();
}

export async function probeFriendLinks(linkId = '') {
    if (probing) { await probing; return getFriendLinks(); }
    probing = (async () => {
        const config = normalizeLinksConfig((await getSetting(LINKS_KEY, null)) || {});
        const targets = linkId ? config.links.filter((l) => l.id === linkId) : config.links;
        if (linkId && !targets.length) throw new BusinessError('友情链接不存在', 404);
        const results = [];
        // 两个一组，避免一次打出太多出站请求
        for (let i = 0; i < targets.length; i += 2) results.push(...await Promise.all(targets.slice(i, i + 2).map(probeLink)));
        const stored = await linkStatuses();
        const byId = { ...stored.byId };
        targets.forEach((link, index) => { byId[link.id] = results[index]; });
        await saveSetting(LINKS_STATUS_KEY, { byId, lastProbeAt: linkId ? stored.lastProbeAt : new Date().toISOString() });
        return { link: targets[0], result: results[0] };
    })();
    try {
        const single = await probing;
        return linkId ? single : getFriendLinks();
    } finally {
        probing = null;
    }
}

// ── 平台推广 ─────────────────────────────────────────────
const PROMO_KEY = 'platform_promotions_config';
const PROMO_COLORS = ['teal', 'blue', 'violet', 'orange', 'rose', 'green'];
// 随包自带的推广链接：可隐藏、可换封面，不能删除或改地址
const BUILTIN_PROMOS = [{
    id: 'netcare', name: 'NetCare', nameEn: 'NetCare', badge: 'NetCare', badgeEn: 'NetCare',
    description: '维护作战地图', descriptionEn: 'Maintenance Operation Map',
    url: 'https://netcare.huawei.com', color: 'teal', coverImage: 'assets/promotions/netcare-operation-map.svg',
}];

function normalizeCover(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^\/?assets\/promotions\/[a-zA-Z0-9/_-]+\.(?:svg|png|jpg|jpeg|webp)$/.test(raw) && !raw.includes('..')) return raw;
    if (raw.startsWith('data:')) {
        const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
        if (!match) throw new BusinessError('封面图片仅支持 PNG、JPEG、WebP');
        const bytes = Buffer.from(match[2], 'base64');
        const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
                : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
        if (!valid || bytes.length > 512 * 1024) throw new BusinessError('封面图片无效或超过 512 KB');
        return raw;
    }
    return normalizeUrl(raw, '封面图片');
}

function normalizePromoConfig(input = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const rawLinks = Array.isArray(source.links) ? source.links.filter((item) => item && typeof item === 'object') : [];
    const builtinById = new Map(BUILTIN_PROMOS.map((link) => [link.id, link]));
    if (rawLinks.filter((item) => !builtinById.has(item.id)).length > 30) throw new BusinessError('自定义推广链接最多支持 30 个');
    const used = new Set(builtinById.keys());
    const placed = new Set();
    const links = [];
    rawLinks.forEach((item, index) => {
        const builtin = builtinById.get(item.id);
        if (builtin) {
            if (placed.has(builtin.id)) return;
            placed.add(builtin.id);
            links.push({ ...builtin, builtin: true, enabled: item.enabled !== false, coverImage: Object.hasOwn(item, 'coverImage') ? normalizeCover(item.coverImage) : builtin.coverImage });
            return;
        }
        const url = normalizeUrl(item.url, '推广链接');
        const name = text(item.name, 40);
        if (!name) throw new BusinessError('推广链接名称不能为空');
        links.push({
            id: uniqueId(item.id, 'promo', url, index, used), builtin: false, enabled: item.enabled !== false,
            name, nameEn: text(item.nameEn, 60), badge: text(item.badge, 12) || '推广', badgeEn: text(item.badgeEn, 16),
            description: text(item.description, 120), descriptionEn: text(item.descriptionEn, 160),
            url, color: PROMO_COLORS.includes(item.color) ? item.color : 'blue', coverImage: normalizeCover(item.coverImage),
        });
    });
    BUILTIN_PROMOS.filter((link) => !placed.has(link.id)).reverse().forEach((link) => links.unshift({ ...link, builtin: true, enabled: true }));
    return {
        schemaVersion: 2,
        enabled: true,
        maxLinks: clampInt(source.maxLinks, 1, 10, 3),
        rotateSeconds: clampInt(source.rotateSeconds, 10, 600, 30),
        desktopStack: false,
        videos: [], // 介绍视频体积大，不随 基座 Web 版发布
        links,
        defaultsWritable: false,
        updatedAt: source.updatedAt || null,
    };
}

export async function getPromotions() {
    return normalizePromoConfig((await getSetting(PROMO_KEY, null)) || {});
}

export async function savePromotions(input) {
    const config = normalizePromoConfig({ ...(input || {}), updatedAt: new Date().toISOString() });
    const { defaultsWritable: _w, videos: _v, ...stored } = config;
    await saveSetting(PROMO_KEY, stored);
    return config;
}

// 点击统计：按月一份，结构 { 日期: { 推广项: { clicks, users: [工号…] } } }。只给管理员看汇总，不展示谁点了什么。
const clicksKey = (day) => `platform_promotion_clicks:${day.slice(0, 7)}`;
const localDay = (date = new Date()) => date.toLocaleDateString('sv');
const recentClicks = new Map(); // 同一个人几秒内重复点同一项只算一次（进程内即可）

export async function recordPromotionClick({ id, kind, username }) {
    if (kind !== 'link' && kind !== 'video') throw new BusinessError('无效的推广类型');
    const config = await getPromotions();
    const promoId = text(id, 80);
    if (!config.links.some((link) => link.id === promoId)) throw new BusinessError('推广项不存在', 404);
    const user = text(username, 120) || 'anonymous';
    const dedupeKey = `${user}\n${promoId}`;
    if (Date.now() - (recentClicks.get(dedupeKey) || 0) < 5000) return false;
    recentClicks.set(dedupeKey, Date.now());
    if (recentClicks.size > 2000) recentClicks.clear();
    const day = localDay();
    const month = (await getSetting(clicksKey(day), null)) || {};
    const slot = ((month[day] ||= {})[promoId] ||= { clicks: 0, users: [] });
    slot.clicks += 1;
    if (!slot.users.includes(user) && slot.users.length < 500) slot.users.push(user);
    await saveSetting(clicksKey(day), month);
    return true;
}

export async function promotionStats({ days = 30 } = {}) {
    const span = clampInt(days, 1, 365, 30);
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - span + 1);
    const from = localDay(start);
    const to = localDay(now);
    const months = new Set();
    for (const cursor = new Date(start.getFullYear(), start.getMonth(), 1); cursor <= now; cursor.setMonth(cursor.getMonth() + 1)) months.add(localDay(cursor).slice(0, 7));
    const byId = new Map();
    const daily = [];
    const everyone = new Set();
    for (const month of months) {
        const data = (await getSetting(`platform_promotion_clicks:${month}`, null)) || {};
        for (const [day, items] of Object.entries(data)) {
            if (day < from || day > to) continue;
            let dayClicks = 0;
            for (const [promoId, slot] of Object.entries(items || {})) {
                const item = byId.get(promoId) || { id: promoId, kind: 'link', clicks: 0, userSet: new Set(), channels: { tab: 0 }, lastClickedAt: null };
                item.clicks += Number(slot.clicks) || 0;
                item.channels.tab = item.clicks;
                (slot.users || []).forEach((u) => { item.userSet.add(u); everyone.add(u); });
                if (!item.lastClickedAt || day > item.lastClickedAt) item.lastClickedAt = day;
                byId.set(promoId, item);
                dayClicks += Number(slot.clicks) || 0;
            }
            daily.push({ date: day, clicks: dayClicks });
        }
    }
    const items = [...byId.values()].map(({ userSet, ...item }) => ({ ...item, users: userSet.size })).sort((a, b) => b.clicks - a.clicks);
    return { days: span, from, to, totalClicks: items.reduce((sum, item) => sum + item.clicks, 0), totalUsers: everyone.size, items, daily: daily.sort((a, b) => a.date.localeCompare(b.date)) };
}
