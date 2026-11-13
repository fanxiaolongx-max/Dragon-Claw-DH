import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, STATIC_DIR } from '../config.js';
import { resolveRequestIdentity } from '../core/identity.js';
import { pushLog, listLogs } from '../core/log-ring.js';
import { getSetting as kvGet, saveSetting as kvSet } from '../services/system-service.js';
import { getOnboardingStatus, applyOnboardingDecision } from '../services/onboarding-service.js';
import { listScripts as listUivScripts } from '../services/uiv-service.js';
import { platformSummary, trackToolOpen } from '../services/platform-metrics-service.js';

const DEFAULT_IDENTITY = {
    platformName: 'Dragon Claw',
    platformNameZh: 'Dragon Claw',
    platformNameEn: 'Dragon Claw',
    platformSubtitle: '工具与知识中心',
    platformSubtitleEn: 'Tools & Knowledge Center',
    platformSlogan: '“认真做好每一个工具。”',
    platformSloganEn: '“Build every tool with care. Make everyday work easier.”',
    platformGuideVideoUrl: '',
    scanLinks: { weixin: '', welink: '' },
    f12QuickDownloads: [],
};

const DEFAULT_NAV_LAYOUT = {
    primaryIds: [
        'home',
        'uivf12',
        'sla',
        'report',
        'custom-report',
        'expedite',
        'monthly',
        'bigscreen',
        'topic-analysis',
        'custom:network_safety_meeting_summary',
    ],
    categories: [
        { id: 'audit', name: '审计与核算', nameEn: 'Audit & KPI' },
        { id: 'cat_mu9po0me', name: '奖惩管理', nameEn: 'Incentive & Negative' },
        { id: 'cat_mq0nny3v', name: '五个端到端', nameEn: '“5” E2E' },
        { id: 'cat_msbmuup1', name: '实用工具', nameEn: 'Useful' },
        { id: 'cat_msbmvd5l', name: '网络安全', nameEn: 'Safety' },
        { id: 'cat_mshv1h0m', name: '汇报呈现', nameEn: 'Report' },
        { id: 'custom', name: '自定义工具', nameEn: 'Custom Tools' },
        { id: 'cat_mshua5iu', name: '休闲娱乐', nameEn: 'Play' },
        { id: 'cat_ms2192c7', name: '行政餐饮', nameEn: 'Admin' },
        { id: 'system', name: '系统治理', nameEn: 'System Governance' },
    ],
    categoryByItem: {
        frt: 'audit',
        praudit: 'audit',
        storage: 'system',
        'db-explorer': 'system',
        'custom:eos_tool-v2': 'cat_mq0nny3v',
        'custom:eos': 'cat_mq0nny3v',
        'custom:eos_tool-v4': 'cat_mq0nny3v',
        'custom:eos_tool-v8': 'cat_mq0nny3v',
        'custom:esn-check': 'cat_mq0nny3v',
        'custom:pr': 'audit',
        'custom:tool-mro1gt5o': 'cat_ms2192c7',
        'custom:tool-mr87218d': 'cat_ms2192c7',
        'custom:tool-mrlpwjk3': 'cat_ms2192c7',
        'custom:tool-ms1saxuh': 'cat_ms2192c7',
        'custom:tool-msbmscxd': 'audit',
        'custom:tool-msbmu55i': 'audit',
        'custom:tool-ms4xb66s': 'cat_mu9po0me',
        'custom:tool-mrhqjeya': 'cat_msbmuup1',
        'custom:tool-mrsw86w8': 'cat_mshv1h0m',
        'custom:pr-2': 'cat_msbmuup1',
        'custom:f12-to-extension': 'cat_msbmuup1',
        'custom:tool-mrrgpqy4': 'cat_ms2192c7',
        'custom:particle-effects': 'cat_mshua5iu',
        'custom:tool-mrrn48dc': 'cat_mshua5iu',
        'custom:optical-transfer': 'cat_mshua5iu',
        'custom:tool-msf5b7nn': 'cat_mu9po0me',
        'custom:nis_2026h1_summary': 'cat_mshv1h0m',
        'custom:tool-msh8aro4': 'cat_mshv1h0m',
        'custom:question-bank-assistant-privacy': 'cat_mshv1h0m',
        'custom:tool-mr88gv9x': 'cat_mshv1h0m',
        'custom:tool-mtpx4vtr': 'cat_ms2192c7',
        'custom:supplier-quotation-comparison': 'cat_ms2192c7',
        'custom:tool-mttuw8kn': 'cat_ms2192c7',
        'custom:tool-mu2t8wi3': 'cat_ms2192c7',
        'custom:tool-mu2t8i0i': 'cat_msbmuup1',
        'custom:department-reward-penalty': 'cat_mu9po0me',
        'custom:reward-program': 'cat_mu9po0me',
        'duty-roster': 'cat_msbmuup1',
        'custom:tool-dining-card-wechat': 'cat_ms2192c7',
        'python-updater': 'audit',
        'custom:python-updater': 'cat_msbmuup1',
        'custom:tool-mumxi3px': 'audit',
        'custom:question-bank-study': 'cat_msbmuup1',
        'custom:chat-history-center': 'cat_msbmuup1',
        'custom:tool-mr0vvmyi': 'cat_msbmuup1',
        'custom:mayrig': 'cat_mshua5iu',
        'custom:tool-mv9strpn': 'cat_ms2192c7',
        'custom:cnbg-_': 'cat_mshv1h0m',
        'custom:tool-msqfmv82': 'cat_msbmuup1',
        'custom:tool-msqfplq0': 'cat_msbmuup1',
        'custom:tool-mqp55fna': 'cat_mshv1h0m',
        'custom:tool-mqtlwcrv': 'cat_msbmuup1',
        'custom:parkst': 'cat_mshua5iu',
        'custom:network_safety_meeting_summary': 'cat_mshv1h0m',
        'custom:picture-island': 'cat_msbmuup1',
        'custom:datacom-protocol-expert': 'custom',
    },
    itemOrder: [
        'praudit', 'custom:pr', 'frt', 'storage', 'db-explorer',
        'custom:eos_tool-v8', 'custom:f12-to-extension', 'custom:python-updater',
        'custom:chat-history-center', 'custom:question-bank-study',
        'custom:tool-msqfmv82', 'custom:tool-msqfplq0', 'custom:tool-mqtlwcrv',
        'custom:network_safety_meeting_summary', 'custom:nis_2026h1_summary',
        'custom:tool-ms4xb66s', 'custom:particle-effects', 'custom:esn-check',
        'custom:tool-mqp55fna', 'custom:tool-mrrn48dc', 'custom:tool-ms1saxuh',
        'custom:tool-mr88gv9x', 'custom:tool-mrlpwjk3', 'custom:tool-mrrgpqy4',
        'custom:tool-mrhqjeya', 'custom:tool-mr87218d', 'custom:tool-mr0vvmyi',
        'custom:tool-mro1gt5o', 'custom:tool-mrsw86w8', 'custom:datacom-protocol-expert',
        'custom:tool-mtakhxqm', 'report', 'custom:tool-mtpx4vtr', 'bigscreen',
        'custom:department-reward-penalty', 'home',
        'custom:supplier-quotation-comparison', 'custom:optical-transfer',
        'custom:tool-msf5b7nn', 'custom:reward-program', 'custom:tool-mu2t8wi3',
        'custom:question-bank-assistant-privacy', 'custom:tool-msh8aro4',
        'custom:tool-mumxi3px', 'custom:tool-msbmscxd', 'custom:tool-msbmu55i',
        'sla', 'uivf12', 'custom:pr-2', 'custom:tool-mu2t8i0i',
        'custom:tool-mttuw8kn', 'expedite', 'custom:tool-mv9strpn',
        'custom:tool-dining-card-wechat', 'monthly', 'custom:acceptance-checklist',
        'duty-roster', 'custom:picture-island', 'topic-analysis',
        'custom:hostedapptestkit', 'custom:mayrig', 'netcare-explorer',
        'custom:parkst', 'custom:aiops-report',
    ],
};

const SIDEBAR_PRIMARY = ['channels', 'skillHub', 'schedule', 'library', 'opsDrafts'];
const SIDEBAR_MORE = ['links', 'requirements', 'promotions'];
const SIDEBAR_IDS = new Set([...SIDEBAR_PRIMARY, ...SIDEBAR_MORE]);

const BOOTSTRAP_ALLOWED_PATHS = new Set([
    '/api/app-version',
    '/api/asset-version',
    '/api/tenants',
    '/api/migration-status',
    '/api/platform-promotions',
    '/api/platform-promotions/desktop',
    '/api/nav-settings',
    '/api/auth/me',
    '/api/custom-tools',
    '/api/custom-tools/f12-to-extension/scripts',
    '/api/alert-center/summary',
    '/api/builtin-promotion/status',
    '/api/home/capabilities',
    '/api/agent-skills',
    '/api/agent-workspace/capability',
    '/api/agent-workspace/prefs',
    '/api/ai/conversation-list',
    '/api/ai/sessions',
    '/api/ai/schedules',
    '/api/ai/models',
    '/api/channels/available',
    '/api/channels/ops/pending',
    '/api/desktop-agents/settings',
    '/api/desktop-agents/sessions',
    '/api/desktop-license/status',
    '/api/recent-nav',
    '/api/favorite-nav',
    '/api/onboarding/defaults/status',
]);

const DROPPED_SUB_HEADERS = new Set([
    'content-length', 'content-type', 'transfer-encoding',
    'if-none-match', 'if-modified-since', 'accept-encoding', 'connection', 'expect',
]);
const HIDDEN_RES_HEADERS = new Set(['set-cookie', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

function defaultNavSettings() {
    return {
        ...DEFAULT_IDENTITY,
        primaryIds: [...DEFAULT_NAV_LAYOUT.primaryIds],
        categories: DEFAULT_NAV_LAYOUT.categories.map((c) => ({ ...c })),
        categoryByItem: { ...DEFAULT_NAV_LAYOUT.categoryByItem },
        itemOrder: [...DEFAULT_NAV_LAYOUT.itemOrder],
    };
}

function normalizeNavSettings(raw) {
    const base = defaultNavSettings();
    if (!raw || typeof raw !== 'object') return base;
    return {
        ...base,
        platformName: typeof raw.platformName === 'string' && raw.platformName.trim() ? raw.platformName.trim() : base.platformName,
        platformNameZh: typeof raw.platformNameZh === 'string' && raw.platformNameZh.trim() ? raw.platformNameZh.trim() : base.platformNameZh,
        platformNameEn: typeof raw.platformNameEn === 'string' && raw.platformNameEn.trim() ? raw.platformNameEn.trim() : base.platformNameEn,
        platformSubtitle: typeof raw.platformSubtitle === 'string' && raw.platformSubtitle.trim() ? raw.platformSubtitle.trim() : base.platformSubtitle,
        platformSubtitleEn: typeof raw.platformSubtitleEn === 'string' && raw.platformSubtitleEn.trim() ? raw.platformSubtitleEn.trim() : base.platformSubtitleEn,
        platformSlogan: typeof raw.platformSlogan === 'string' && raw.platformSlogan.trim() ? raw.platformSlogan.trim() : base.platformSlogan,
        platformSloganEn: typeof raw.platformSloganEn === 'string' && raw.platformSloganEn.trim() ? raw.platformSloganEn.trim() : base.platformSloganEn,
        platformGuideVideoUrl: typeof raw.platformGuideVideoUrl === 'string' ? raw.platformGuideVideoUrl : base.platformGuideVideoUrl,
        scanLinks: raw.scanLinks && typeof raw.scanLinks === 'object' ? { weixin: raw.scanLinks.weixin || '', welink: raw.scanLinks.welink || '' } : base.scanLinks,
        primaryIds: Array.isArray(raw.primaryIds) && raw.primaryIds.length ? raw.primaryIds.map(String) : base.primaryIds,
        categories: Array.isArray(raw.categories) && raw.categories.length ? raw.categories : base.categories,
        categoryByItem: raw.categoryByItem && typeof raw.categoryByItem === 'object' ? raw.categoryByItem : base.categoryByItem,
        itemOrder: Array.isArray(raw.itemOrder) && raw.itemOrder.length ? raw.itemOrder.map(String) : base.itemOrder,
        f12QuickDownloads: Array.isArray(raw.f12QuickDownloads) ? raw.f12QuickDownloads : [],
    };
}

function normalizeBootstrapPath(rawPath) {
    if (typeof rawPath !== 'string' || rawPath.length > 600) return null;
    const trimmed = rawPath.trim();
    const apiIdx = trimmed.indexOf('/api/');
    const normalized = apiIdx >= 0 ? trimmed.slice(apiIdx) : trimmed;
    if (!normalized.startsWith('/api/')) return null;
    let parsed;
    try {
        parsed = new URL(normalized, 'http://bootstrap.local');
    } catch {
        return null;
    }
    if (parsed.origin !== 'http://bootstrap.local' || !BOOTSTRAP_ALLOWED_PATHS.has(parsed.pathname)) {
        return null;
    }
    return parsed.pathname + parsed.search;
}

function uivScriptOrigin(script) {
    const fromCode = (code) => (String(code || '').match(/URL:\s*(https?:\/\/[^\s]+)/) || [])[1]
        || (String(code || '').match(/fetch\("([^"]+)"/) || [])[1]
        || '';
    for (const candidate of [script?.openUrl, script?.url, fromCode(script?.code), fromCode(script?.consoleCode)]) {
        if (!candidate) continue;
        try {
            const parsed = new URL(candidate);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
        } catch {
            // Try next candidate
        }
    }
    return '';
}

function uivSiteLabel(origin, lang) {
    let host = '';
    try { host = new URL(origin).hostname.toLowerCase(); } catch { host = origin; }
    const en = lang === 'en-US';
    if (host === 'netcare.huawei.com') return en ? 'NetCare China' : 'NetCare 中国';
    if (host === 'netcare-ae.gts.huawei.com') return en ? 'NetCare Middle East' : 'NetCare 中东';
    if (host === 'netcare-de.gts.huawei.com') return en ? 'NetCare Germany' : 'NetCare 德国';
    if (host.includes('datafab')) return 'DataFab';
    return host || 'Web';
}

function safeStaticAssetPath(rel) {
    const clean = String(rel || '').replace(/^\/+/, '');
    if (!clean || clean.includes('..')) return null;
    const resolved = path.resolve(STATIC_DIR, clean);
    if (!resolved.startsWith(path.resolve(STATIC_DIR) + path.sep)) return null;
    return resolved;
}

export async function platformShellRoutes(fastify) {
    // ── 导航布局 & 平台品牌标识 ─────────────────────────────
    fastify.get('/api/nav-settings', async () => {
        const stored = await kvGet('nav_settings', null);
        return normalizeNavSettings(stored);
    });

    fastify.put('/api/nav-settings', async (req) => {
        const merged = normalizeNavSettings(req.body || {});
        await kvSet('nav_settings', merged);
        return merged;
    });

    fastify.post('/api/nav-settings/restore-defaults', async () => {
        const defaults = defaultNavSettings();
        await kvSet('nav_settings', defaults);
        return defaults;
    });

    fastify.post('/api/nav-settings/set-as-default', async (req) => {
        const candidate = req.body?.settings || req.body?.layout || null;
        const next = normalizeNavSettings(candidate || await kvGet('nav_settings', null));
        await kvSet('nav_settings', next);
        return next;
    });

    fastify.get('/api/platform-identity', async (_req, reply) => {
        reply.header('Cache-Control', 'no-store');
        const settings = normalizeNavSettings(await kvGet('nav_settings', null));
        return { ...settings, mediaEnabled: false, digitalHumanMode: true };
    });

    fastify.get('/api/app-version', async (_req, reply) => {
        reply.header('Cache-Control', 'no-store');
        return {
            name: config.appName || 'Dragon Claw Digital Human',
            version: config.appVersion || '1.0.0',
            build: { version: config.appVersion || '1.0.0', mode: 'digital-human-web' },
        };
    });

    fastify.get('/api/asset-version', async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        const assetPath = String(req.query?.path || '');
        if (!/^(?:\/?(?:js|css)\/[\w./-]+\.(?:js|css))$/.test(assetPath) || assetPath.includes('..')) {
            return reply.code(400).send({ error: 'Invalid asset path' });
        }
        const full = safeStaticAssetPath(assetPath);
        if (!full || !fs.existsSync(full)) {
            return { path: assetPath, version: config.appVersion || '1.0.0' };
        }
        const hash = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex').slice(0, 12);
        return { path: assetPath, version: hash };
    });

    fastify.get('/api/migration-status', async (_req, reply) => {
        reply.header('Cache-Control', 'no-store');
        return { status: 'ready', mode: 'digital-human-web', pending: 0, errors: [] };
    });

    // ── 最近使用 / 收藏 / 侧边栏菜单 ────────────────────────
    fastify.get('/api/recent-nav', async (req) => {
        const id = resolveRequestIdentity(req);
        const ids = await kvGet(`recent_nav:${id.username}`, []);
        return { ids: Array.isArray(ids) ? ids : [] };
    });

    fastify.post('/api/recent-nav', async (req, reply) => {
        const toolId = req.body?.toolId;
        if (typeof toolId !== 'string' || !toolId.trim() || toolId.length > 160) {
            return reply.code(400).send({ error: '工具 ID 无效' });
        }
        const id = resolveRequestIdentity(req);
        const current = await kvGet(`recent_nav:${id.username}`, []);
        const next = [toolId.trim(), ...(Array.isArray(current) ? current : []).filter((x) => x !== toolId.trim())].slice(0, 12);
        await kvSet(`recent_nav:${id.username}`, next);
        return { ids: next };
    });

    fastify.get('/api/favorite-nav', async (req) => {
        const id = resolveRequestIdentity(req);
        const ids = await kvGet(`favorite_nav:${id.username}`, []);
        return { ids: Array.isArray(ids) ? ids : [] };
    });

    fastify.put('/api/favorite-nav', async (req, reply) => {
        const ids = req.body?.ids;
        if (!Array.isArray(ids) || ids.length > 20) {
            return reply.code(400).send({ error: '收藏列表无效' });
        }
        const id = resolveRequestIdentity(req);
        const clean = ids.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
        await kvSet(`favorite_nav:${id.username}`, clean);
        return { ids: clean };
    });

    fastify.get('/api/sidebar-menu', async (req) => {
        const id = resolveRequestIdentity(req);
        const stored = await kvGet(`sidebar_menu:${id.username}`, null);
        if (stored && Array.isArray(stored.primary) && Array.isArray(stored.more)) {
            return stored;
        }
        return { primary: [...SIDEBAR_PRIMARY], more: [...SIDEBAR_MORE] };
    });

    fastify.put('/api/sidebar-menu', async (req, reply) => {
        const input = req.body || {};
        if (!Array.isArray(input.primary) || !Array.isArray(input.more)) {
            return reply.code(400).send({ error: '菜单配置无效' });
        }
        const ids = [...input.primary, ...input.more];
        if (ids.length !== SIDEBAR_IDS.size || ids.some((x) => !SIDEBAR_IDS.has(x))) {
            return reply.code(400).send({ error: '菜单配置无效' });
        }
        const id = resolveRequestIdentity(req);
        const layout = { primary: [...input.primary], more: [...input.more] };
        await kvSet(`sidebar_menu:${id.username}`, layout);
        return layout;
    });

    // ── Platform Metrics（友情链接、平台推广见 routes/home-extras.js）──
    fastify.get('/api/platform-metrics/summary', async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        return platformSummary({ identity: req.userIdentity });
    });

    fastify.post('/api/platform-metrics/open', async (req) => ({ success: true, ...(await trackToolOpen(req.body?.toolKey)) }));

    fastify.get('/api/platform-metrics/service-status', async () => ({
        healthy: true,
        days: [],
        services: [],
        license: { enabled: false, valid: true },
        channels: { enabled: false, channels: [] },
    }));

    fastify.get('/api/platform-metrics/service-status/logs', async (req) => {
        const pageSize = Math.min(200, Math.max(1, Number(req.query?.pageSize) || 50));
        const requestedPage = Math.max(1, Number(req.query?.page) || 1);
        const all = listLogs({
            limit: 500,
            levels: req.query?.levels || '',
            level: req.query?.level || '',
            q: req.query?.q || '',
            startDate: req.query?.startDate || '',
            endDate: req.query?.endDate || '',
            newestFirst: true,
        });
        const total = all.length;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(requestedPage, totalPages);
        const start = (page - 1) * pageSize;
        const logs = all.slice(start, start + pageSize).map((e) => {
            const extra = e.detail == null ? '' : (typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail, null, 2));
            return {
                id: e.id,
                timestamp: e.ts,
                level: e.level,
                source: e.category || 'APP',
                detail: extra ? `${e.message}\n${extra}` : (e.message || ''),
                requestId: e.requestId || '',
                statusCode: e.statusCode ?? null,
                durationMs: e.durationMs ?? null,
                userId: e.userId || '',
            };
        });
        return { logs, total, page, pageSize, totalPages, retentionDays: 30 };
    });

    fastify.get('/api/builtin-promotion/status', async () => ({
        writable: false,
        kinds: {},
        lockedTools: [],
    }));

    // ── Home Capabilities & Page Updates & Bootstrap ────────
    fastify.get('/api/home/capabilities', async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        const lang = req.query?.lang === 'en-US' ? 'en-US' : 'zh-CN';
        const scripts = await listUivScripts().catch(() => []);
        const byOrigin = new Map();
        for (const s of scripts) {
            const origin = uivScriptOrigin(s);
            if (!origin) continue;
            if (!byOrigin.has(origin)) byOrigin.set(origin, []);
            byOrigin.get(origin).push(s);
        }
        const floatItems = [...byOrigin.entries()].map(([origin, list]) => {
            const name = uivSiteLabel(origin, lang);
            const sample = list.slice(0, 3).map((x) => x.name).filter(Boolean).join('、');
            return {
                id: `float:${origin}`,
                kind: 'float',
                icon: '🪟',
                color: '#a78bfa',
                name: lang === 'en-US' ? `${name} floating panel` : `${name} 浮窗`,
                nameEn: `${uivSiteLabel(origin, 'en-US')} floating panel`,
                description: lang === 'en-US'
                    ? `${list.length} capture scripts available: ${sample}`
                    : `包含 ${list.length} 个数据抓取脚本：${sample}`,
                href: 'uivf12?siteScripts=1',
                badge: String(list.length),
                updatedAt: '',
            };
        });
        const groups = [];
        if (floatItems.length) {
            groups.push({
                kind: 'float',
                icon: '🪟',
                color: '#a78bfa',
                label: '数据抓取浮窗脚本',
                labelEn: 'Data capture floating scripts',
                where: '「数据抓取」→ 浮窗脚本',
                whereEn: 'Data Capture → Floating scripts',
                href: 'uivf12?siteScripts=1',
                count: floatItems.length,
                items: floatItems,
            });
        }
        return { groups, generatedAt: new Date().toISOString() };
    });

    fastify.get('/api/home/page-updates', async () => {
        const pageFiles = {
            '/uivf12': 'uivf12.html',
            '/sla': 'sla.html',
            '/report': 'report.html',
            '/expedite': 'expedite.html',
            '/monthly': 'monthly.html',
            '/bigscreen': 'bigscreen.html',
            '/db-explorer': 'db-explorer.html',
            '/topic-analysis': 'topic-analysis.html',
            '/duty-roster': 'duty-roster.html',
            '/frt': 'frt.html',
            '/praudit': 'praudit.html',
        };
        const out = {};
        for (const [key, rel] of Object.entries(pageFiles)) {
            const full = path.join(STATIC_DIR, rel);
            if (fs.existsSync(full)) {
                out[key] = fs.statSync(full).mtime.toISOString();
            }
        }
        return out;
    });

    fastify.post('/api/home/bootstrap', async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        const requested = Array.isArray(req.body?.paths) ? req.body.paths.slice(0, 40) : [];
        const resolvedList = [];
        for (const rawPath of requested) {
            const clean = normalizeBootstrapPath(rawPath);
            if (clean) resolvedList.push([rawPath, clean]);
        }
        const forwardedHeaders = {};
        for (const [k, v] of Object.entries(req.headers || {})) {
            // 子请求的结果要原样塞回前端的预取缓存，不能带统一响应体的声明头
            if (!DROPPED_SUB_HEADERS.has(k.toLowerCase()) && k.toLowerCase() !== 'x-dh-envelope' && v !== undefined) {
                forwardedHeaders[k] = v;
            }
        }
        const entries = await Promise.all(resolvedList.map(async ([rawKey, urlPath]) => {
            try {
                const res = await fastify.inject({
                    method: 'GET',
                    url: urlPath,
                    headers: forwardedHeaders,
                });
                const cleanHeaders = {};
                for (const [hk, hv] of Object.entries(res.headers || {})) {
                    if (!HIDDEN_RES_HEADERS.has(hk.toLowerCase())) {
                        cleanHeaders[hk] = Array.isArray(hv) ? hv.join(', ') : String(hv);
                    }
                }
                return [rawKey, { status: res.statusCode, headers: cleanHeaders, body: res.payload }];
            } catch (err) {
                pushLog({ level: 'WARN', category: 'BOOTSTRAP', message: `bootstrap sub-request failed: ${urlPath}`, detail: err.message });
                return [rawKey, { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ error: 'bootstrap failed' }) }];
            }
        }));
        return { results: Object.fromEntries(entries) };
    });

    // ── Phase-2 Clean Web Stubs (Zero Console 404/500) ──────
    fastify.get('/api/tenants', async (req) => {
        const id = resolveRequestIdentity(req);
        return {
            tenants: [{ id: id.tenantId || 'default', name: '数字人工作空间', status: 'active' }],
            activeTenantId: id.tenantId || 'default',
        };
    });


    fastify.get('/api/agent-workspace/capability', async () => ({
        enabled: false,
        reason: 'DIGITAL_HUMAN_WEB_MODE',
        homeDir: '',
        confined: true,
        readOnly: true,
        permissionModes: [],
    }));
    fastify.get('/api/agent-workspace/prefs', async () => ({ prefs: {} }));
    fastify.get('/api/agent-workspace/suggest', async () => ({ items: [] }));

    fastify.get('/api/ai/uploads', async () => ({ items: [] }));
    fastify.get('/api/ai/proactive-alert-message', async () => ({ message: null }));

    fastify.get('/api/channels/available', async () => ({ items: [], summary: {} }));
    fastify.get('/api/channels/ops/pending', async () => ({ canManage: false, items: [], total: 0, hasMore: false, offset: 0 }));
    fastify.get('/api/channels/ops', async () => ({ items: [], total: 0 }));
    fastify.get('/api/channels/:channel/threads', async () => ({ items: [], threads: [] }));
    fastify.get('/api/channels', async () => ({ channels: [] }));

    fastify.get('/api/desktop-agents', async () => ({ agents: [], sessions: [] }));
    fastify.get('/api/desktop-agents/settings', async () => ({ owned: false, settings: null, reason: '数字人 Web 版暂未开放桌面协作' }));
    fastify.get('/api/desktop-agents/sessions', async () => ({ sessions: [], items: [] }));
    fastify.get('/api/desktop-agents/quota', async () => ({ quota: { remaining: 0, limit: 0 }, webMode: true }));
    fastify.get('/api/desktop-license/status', async () => ({ enabled: false, valid: true }));

    fastify.get('/api/onboarding/defaults/status', async (req) => {
        const identity = resolveRequestIdentity(req);
        return getOnboardingStatus({ role: identity.role });
    });
    fastify.post('/api/onboarding/defaults/decision', async (req, reply) => {
        const identity = resolveRequestIdentity(req);
        try {
            const body = req.body || {};
            return await applyOnboardingDecision({
                action: body.action,
                importScripts: body.importScripts !== false && Boolean(body.importScripts),
                importMetricRules: body.importMetricRules !== false && Boolean(body.importMetricRules),
                allowRepeat: body.allowRepeat === true,
                role: identity.role,
            });
        } catch (err) {
            const code = err.statusCode || (Number.isInteger(err.code) ? err.code : 400);
            return reply.code(code).send({ error: err.message, code: typeof err.code === 'string' ? err.code : undefined });
        }
    });
    fastify.post('/api/onboarding/defaults/apply', async (req, reply) => {
        const identity = resolveRequestIdentity(req);
        try {
            const body = req.body || {};
            const importScripts = body.importScripts !== undefined ? Boolean(body.importScripts) : true;
            const importMetricRules = body.importMetricRules !== undefined ? Boolean(body.importMetricRules) : true;
            return await applyOnboardingDecision({
                action: 'import',
                importScripts,
                importMetricRules,
                allowRepeat: true,
                role: identity.role,
            });
        } catch (err) {
            const code = err.statusCode || (Number.isInteger(err.code) ? err.code : 400);
            return reply.code(code).send({ error: err.message, code: typeof err.code === 'string' ? err.code : undefined });
        }
    });

    fastify.get('/api/vault', async () => ({ items: [] }));
    fastify.get('/api/chat-history/status', async () => ({ enabled: false, indexedCount: 0 }));
    fastify.get('/api/distribution/catalog', async () => ({ items: [] }));
    fastify.get('/api/distribution/personal', async () => ({ entries: {} }));
    fastify.get('/api/hosted-apps/preview', async () => ({ apps: [] }));
    fastify.get('/api/desktop-pet/language', async () => ({ lang: 'zh-CN' }));
    fastify.post('/api/desktop-pet/language', async (req) => ({ success: true, lang: req.body?.language || req.body?.lang || 'zh-CN' }));
    fastify.get('/api/ai/speech', async () => ({ ready: false, available: false, offlineOnly: false, local: { ready: false }, webMode: true }));
}
