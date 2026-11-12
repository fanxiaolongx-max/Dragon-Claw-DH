import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config, STATIC_DIR } from './config.js';
import { BusinessError } from './core/errors.js';
import { parseIdentity } from './core/identity.js';
import { resolveAdmin, denyReason } from './core/access.js';
import { ok, fail } from './core/response.js';
import { pushLog } from './core/log-ring.js';
import { requestContext } from './dao/scoped.js';
import { healthRoutes, healthHandler } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { debugRoutes } from './routes/debug.js';
import { aiRoutes, aiSettingsRoutes } from './routes/ai.js';
import { uivRoutes, uivAiAdapterRoutes, uivAutoImportRoutes } from './routes/uiv.js';
import { slaRoutes } from './routes/sla.js';
import { uploadRoutes } from './routes/upload.js';
import { dbRoutes, expediteRoutes } from './routes/db.js';
import { monthlySnapshotsRoutes, reportMsgRoutes, aiReportRoutes } from './routes/monthly.js';
import { platformShellRoutes } from './routes/platform-shell.js';
import { alertCenterRoutes, platformLogoRoutes, agentToolsRoutes, dbExplorerRoutes, sendLogo } from './routes/platform-extras.js';
import { frtRoutes, prauditRoutes, dutyRosterRoutes, topicSnapshotsRoutes } from './routes/business.js';
import { agentSkillsRoutes, customToolsRoutes, agentFilesRoutes, agentWorkspaceRoutes, registerCustomToolPages } from './routes/agent-extras.js';

const gzipAsync = promisify(zlib.gzip);
const DH_SUBPATH_RE = /^\/digital-human\/dh\/[0-9a-f-]+(?=\/|$|\?)/i;
const DH_BARE_SUBPATH_RE = /^\/digital-human\/dh\/[0-9a-f-]+$/i;

const PHASE1_PAGES = new Map([
    ['/uivf12', 'uivf12.html'],
    ['/sla', 'sla.html'],
    ['/report', 'report.html'],
    ['/expedite', 'expedite.html'],
    ['/monthly', 'monthly.html'],
    ['/monthly/legacy', 'monthly-legacy.html'],
    ['/bigscreen', 'bigscreen.html'],
    ['/db-explorer', 'db-explorer.html'],
    ['/topic-analysis', 'topic-analysis.html'],
    ['/duty-roster', 'duty-roster.html'],
    ['/frt', 'frt.html'],
    ['/praudit', 'praudit.html'],
]);

const PHASE2_ROUTES = new Set([
    '/storage',
    '/netcare-explorer',
    '/requirements',
    '/custom-report',
]);

function stripSubpathPrefix(rawUrl, forwardedPrefixHeader) {
    const urlStr = String(rawUrl || '/');
    const qIdx = urlStr.indexOf('?');
    const pathname = qIdx >= 0 ? urlStr.slice(0, qIdx) : urlStr;
    const search = qIdx >= 0 ? urlStr.slice(qIdx) : '';

    let stripped = pathname;
    const forwardedPrefix = String(forwardedPrefixHeader || '')
        .split(',')[0]
        .trim()
        .replace(/\/+$/, '');

    if (forwardedPrefix && stripped.startsWith(forwardedPrefix)
        && (stripped.length === forwardedPrefix.length || stripped[forwardedPrefix.length] === '/')) {
        stripped = stripped.slice(forwardedPrefix.length) || '/';
    } else {
        const m = stripped.match(DH_SUBPATH_RE);
        if (m) {
            stripped = stripped.slice(m[0].length) || '/';
        }
    }

    if (!stripped.startsWith('/')) stripped = `/${stripped}`;
    return `${stripped}${search}`;
}

function phase2PlaceholderHtml(title) {
    const safeTitle = String(title || '该功能').replace(/[<>&"']/g, '');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeTitle} · Web 版暂未开放</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0f172a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .card { max-width: 520px; padding: 32px; border-radius: 16px; background: rgba(30,41,59,0.92);
          border: 1px solid rgba(148,163,184,0.22); box-shadow: 0 20px 50px rgba(0,0,0,0.4); }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 600;
           background: rgba(56,189,248,0.16); color: #38bdf8; margin-bottom: 14px; }
  h1 { margin: 0 0 10px; font-size: 22px; }
  p { margin: 0 0 20px; color: #94a3b8; line-height: 1.65; font-size: 14px; }
  a.btn { display: inline-flex; align-items: center; gap: 6px; padding: 10px 18px; border-radius: 10px;
          background: #0284c7; color: #fff; text-decoration: none; font-size: 14px; font-weight: 600; }
</style>
<script src="js/shared/dh-runtime.js"></script>
</head>
<body>
  <div class="card">
    <div class="badge">Digital Human Web · 二期规划能力</div>
    <h1>${safeTitle}</h1>
    <p>Web 版暂未开放（二期接入）。当前一期已完整开放：AI 对话、数据抓取、数据导入、报表看板、一键催办、AI 月报与大屏看板。</p>
    <a class="btn" href="./">← 返回平台首页</a>
  </div>
</body>
</html>`;
}

function sendHtmlFile(reply, relPath) {
    reply.header('Cache-Control', 'no-store');
    reply.type('text/html; charset=utf-8');
    return reply.sendFile(relPath);
}

export async function createServer() {
    const app = Fastify({
        logger: false,
        bodyLimit: 64 * 1024 * 1024,
        ignoreTrailingSlash: true,
        rewriteUrl(req) {
            const rawUrl = String(req.url || '/');
            const qIdx = rawUrl.indexOf('?');
            const rawPath = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
            req._dhRawPath = rawPath;
            req._dhRawSearch = qIdx >= 0 ? rawUrl.slice(qIdx) : '';
            req._dhNeedsTrailingSlash = DH_BARE_SUBPATH_RE.test(rawPath);
            return stripSubpathPrefix(rawUrl, req.headers['x-forwarded-prefix']);
        },
    });

    // 文件上传插件不在规范依赖白名单内：有就注册，没有（精简包）时上传接口给出明确提示
    let multipart = null;
    try { multipart = (await import('@fastify/multipart')).default; } catch { /* 精简包 */ }
    if (multipart) {
        await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 10 } });
    } else {
        app.decorateRequest('file', async function file() {
            throw new BusinessError('当前安装包未包含文件上传组件（精简包），请改用完整包或在页面内粘贴/解析后提交', 501);
        });
        app.addContentTypeParser('multipart/form-data', (_req, payload, done) => { payload.resume(); done(null, {}); });
        pushLog({ level: 'WARN', category: 'BOOT', message: '未安装 @fastify/multipart：文件上传接口不可用' });
    }

    if (fs.existsSync(STATIC_DIR)) {
        await app.register(fastifyStatic, {
            root: STATIC_DIR,
            prefix: '/',
            decorateReply: true,
            index: false,
            setHeaders(res, filePath) {
                if (/\.html?$/i.test(filePath)) {
                    res.setHeader('Cache-Control', 'no-store');
                }
            },
        });
    }

    const apiPathOf = (url) => {
        const pathname = String(url || '').split('?')[0];
        return pathname.startsWith('/api/') ? pathname.slice(4) : null;
    };

    app.addHook('onRequest', (req, reply, done) => {
        const requestId = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 80);
        const identity = parseIdentity(req);
        req.requestId = requestId;
        req.startedAt = Date.now();
        req.userIdentity = identity;
        reply.header('x-request-id', requestId);
        requestContext.run({ requestId, userId: identity.username }, done);
    });

    // 权限：先判定是否管理员，再按桌面版同款规则拦截非管理员的写操作
    app.addHook('preHandler', async (req, reply) => {
        const apiPath = apiPathOf(req.url);
        if (apiPath === null || /^\/(?:healthz|health|ping)$/.test(apiPath)) return;
        const identity = req.userIdentity;
        if (await resolveAdmin(identity)) {
            identity.isAdmin = true;
            identity.isSuper = true;
            identity.role = 'admin';
        }
        const reason = denyReason(req.method, apiPath, identity);
        if (reason) {
            pushLog({ level: 'WARN', category: 'AUTH', message: `${req.method} ${req.url} 被拒绝：${reason}`, requestId: req.requestId, userId: identity.username });
            return reply.code(403).send({ error: reason, code: 'ADMIN_REQUIRED', requestId: req.requestId });
        }
    });

    // 统一响应体（规范 §8）：前端垫片带 x-dh-envelope 请求头时，JSON 响应包成
    // {code,message,data,total,elapsed_ms,cache_hit} 且业务失败一律 HTTP 200，避免网关把 4xx/5xx 换成错误页；
    // 垫片收到后还原成桌面版前端原有的协议。未带该头的调用方（curl、探活、脚本）保持原样。
    app.addHook('onSend', async (req, reply, payload) => {
        if (req.headers['x-dh-envelope'] !== '1' || apiPathOf(req.url) === null) return payload;
        const type = String(reply.getHeader('content-type') || '');
        if (!type.includes('application/json') || typeof payload !== 'string') return payload;
        let body;
        try { body = JSON.parse(payload); } catch { return payload; }
        if (body && typeof body === 'object' && 'code' in body && 'data' in body && 'elapsed_ms' in body) return payload;
        const status = reply.statusCode;
        const elapsedMs = req.startedAt ? Date.now() - req.startedAt : 0;
        reply.header('x-dh-envelope', '1');
        if (status >= 400) {
            reply.header('x-dh-status', String(status));
            reply.code(status >= 500 && !(body && body.business) ? status : 200);
            const wrapped = { ...fail(body?.error || body?.message || `HTTP ${status}`, status), data: body, elapsed_ms: elapsedMs };
            return JSON.stringify(wrapped);
        }
        return JSON.stringify(ok(body, { elapsedMs, total: Array.isArray(body) ? body.length : (Array.isArray(body?.items) ? body.items.length : 0) }));
    });

    // 大响应压缩：快照、月报这类 JSON 动辄十几 MB，gzip 后通常只剩一成，网关和浏览器都轻松得多。
    // 只处理已经在内存里的文本响应；流式对话和静态文件不经过这里。
    app.addHook('onSend', async (req, reply, payload) => {
        if (typeof payload !== 'string' || payload.length < 32 * 1024) return payload;
        if (reply.getHeader('content-encoding') || !/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return payload;
        if (!/json|text|javascript|xml/.test(String(reply.getHeader('content-type') || ''))) return payload;
        const zipped = await gzipAsync(payload, { level: 5 });
        reply.header('content-encoding', 'gzip');
        reply.header('vary', 'Accept-Encoding');
        reply.removeHeader('content-length');
        return zipped;
    });

    app.addHook('onResponse', async (req, reply) => {
        const url = String(req.url || '');
        if (!url.startsWith('/api/') && !url.startsWith('/debug')) return;
        if (url.startsWith('/api/debug/logs') || url.startsWith('/api/platform-metrics/service-status/logs')) return;
        const durationMs = req.startedAt ? Date.now() - req.startedAt : 0;
        const status = Number(reply.getHeader('x-dh-status')) || reply.statusCode;
        const level = status >= 500 ? 'ERROR' : (status >= 400 ? 'WARN' : 'INFO');
        pushLog({
            level,
            category: 'HTTP',
            message: `${req.method} ${url} -> ${status}`,
            requestId: req.requestId || '',
            userId: req.userIdentity?.username || '',
            statusCode: status,
            durationMs,
        });
    });

    app.setErrorHandler((err, req, reply) => {
        const status = err instanceof BusinessError
            ? (err.code >= 400 && err.code < 600 ? err.code : 400)
            // 请求体 / 查询参数格式不对（JSON 解析失败、类型不符）：规范 §8.4 要求 422
            : (err.validation || (err instanceof SyntaxError && err.statusCode === 400) || ['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY', 'FST_ERR_VALIDATION'].includes(err.code)) ? 422
            // 业务服务沿用桌面版写法，用 error.status 标注 400/404 等业务状态
            : ([err.statusCode, err.status].find((c) => Number.isInteger(c) && c >= 400 && c < 600) || 500);
        pushLog({
            level: status >= 500 ? 'ERROR' : 'WARN',
            category: 'ERR',
            message: `${req.method} ${req.url} -> ${status}: ${err.message}`,
            requestId: req.requestId || '',
            userId: req.userIdentity?.username || '',
            statusCode: status,
            detail: config.debug ? { name: err.name, stack: String(err.stack || '').split('\n').slice(0, 4) } : null,
        });
        if (reply.sent) return;
        const business = err instanceof BusinessError;
        // 未捕获异常不回显内部细节，只给 trace_id（规范 §8.3）
        const message = business || status < 500 ? (err.message || '请求处理失败') : `服务内部错误，请联系管理员（trace_id: ${req.requestId || ''}）`;
        return reply.code(status).send({
            error: message,
            code: err.code || (status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'),
            requestId: req.requestId || '',
            ...(business ? { business: true } : {}),
        });
    });

    // ── 健康检查：/api/healthz（规范）与 /health、/healthz（样例包）同一实现 ──
    app.get('/healthz', healthHandler);
    app.get('/health', healthHandler);

    // ── 注册全部 API 路由 ──────────────────────────────────
    await app.register(healthRoutes, { prefix: '/api' });
    await app.register(authRoutes, { prefix: '/api/auth' });
    await app.register(debugRoutes, { prefix: '/api/debug' });
    await app.register(aiRoutes, { prefix: '/api/ai' });
    await app.register(aiSettingsRoutes, { prefix: '/api/ai-settings' });
    await app.register(uivRoutes, { prefix: '/api/uiv' });
    await app.register(uivAiAdapterRoutes, { prefix: '/api/uiv-ai-adapter' });
    await app.register(uivAutoImportRoutes, { prefix: '/api/uiv-auto-import' });
    await app.register(slaRoutes, { prefix: '/api/sla' });
    await app.register(uploadRoutes, { prefix: '/api/upload' });
    await app.register(dbRoutes, { prefix: '/api/db' });
    await app.register(expediteRoutes, { prefix: '/api/expedite' });
    await app.register(monthlySnapshotsRoutes, { prefix: '/api/monthly-snapshots' });
    await app.register(reportMsgRoutes, { prefix: '/api/report-msg' });
    await app.register(aiReportRoutes, { prefix: '/api/ai-report' });
    await app.register(agentSkillsRoutes, { prefix: '/api/agent-skills' });
    await app.register(customToolsRoutes, { prefix: '/api/custom-tools' });
    await app.register(agentFilesRoutes, { prefix: '/api/agent-files' });
    await app.register(agentWorkspaceRoutes, { prefix: '/api/agent-workspace' });
    await app.register(alertCenterRoutes, { prefix: '/api/alert-center' });
    await app.register(platformLogoRoutes, { prefix: '/api/platform-logo' });
    await app.register(agentToolsRoutes, { prefix: '/api/agent-mcp' });
    await app.register(dbExplorerRoutes, { prefix: '/api/db-explorer' });
    await app.register(frtRoutes, { prefix: '/api/frt' });
    await app.register(prauditRoutes, { prefix: '/api/praudit' });
    await app.register(dutyRosterRoutes, { prefix: '/api/duty-roster' });
    await app.register(topicSnapshotsRoutes, { prefix: '/api/topic-snapshots' });
    await app.register(platformShellRoutes);
    // 平台标识：页面里固定引用 assets/logo.png，管理员上传过自定义图标时这里返回自定义的
    app.get('/assets/logo.png', async (_req, reply) => sendLogo(reply));

    // ── 静态资源前缀兼容（确保 /pages/*.html 与 /monthly/legacy 下相对资源与无前缀资源一致）─
    for (const staticPrefix of ['/pages', '/monthly']) {
        app.get(`${staticPrefix}/css/*`, async (req, reply) => reply.sendFile(`css/${req.params['*']}`));
        app.get(`${staticPrefix}/js/*`, async (req, reply) => reply.sendFile(`js/${req.params['*']}`));
        app.get(`${staticPrefix}/assets/*`, async (req, reply) => (req.params['*'] === 'logo.png' ? sendLogo(reply) : reply.sendFile(`assets/${req.params['*']}`)));
        app.get(`${staticPrefix}/downloads/*`, async (req, reply) => reply.sendFile(`downloads/${req.params['*']}`));
        app.get(`${staticPrefix}/favicon.ico`, async (_req, reply) => {
            if (fs.existsSync(path.join(STATIC_DIR, 'favicon.ico'))) return reply.sendFile('favicon.ico');
            return reply.sendFile('assets/icon.png');
        });
    }
    app.get('/favicon.ico', async (_req, reply) => {
        if (fs.existsSync(path.join(STATIC_DIR, 'favicon.ico'))) return reply.sendFile('favicon.ico');
        return reply.sendFile('assets/icon.png');
    });

    // ── HTML 页面路由 ──────────────────────────────────────
    app.get('/', async (req, reply) => {
        if (req.raw._dhNeedsTrailingSlash) {
            const tail = path.posix.basename(req.raw._dhRawPath);
            return reply.redirect(302, `${tail}/${req.raw._dhRawSearch || ''}`);
        }
        return sendHtmlFile(reply, 'index.html');
    });
    app.get('/index.html', async (_req, reply) => sendHtmlFile(reply, 'index.html'));

    for (const [routePath, relHtml] of PHASE1_PAGES.entries()) {
        app.get(routePath, async (_req, reply) => sendHtmlFile(reply, relHtml));
    }

    app.get('/ai-report', async (req, reply) => {
        const search = req.raw._dhRawSearch || '';
        return reply.redirect(302, `monthly${search}`);
    });

    app.get('/pages/:file', async (req, reply) => {
        const file = String(req.params.file || '').replace(/[^a-zA-Z0-9_.-]/g, '');
        const legacyMap = {
            'uivf12.html': 'uivf12.html',
            'sla.html': 'sla.html',
            'report.html': 'report.html',
            'expedite.html': 'expedite.html',
            'monthly.html': 'monthly-legacy.html',
            'ai-report.html': 'monthly.html',
            'bigscreen.html': 'bigscreen.html',
            'db-explorer.html': 'db-explorer.html',
            'topic-analysis.html': 'topic-analysis.html',
            'duty-roster.html': 'duty-roster.html',
            'frt.html': 'frt.html',
            'praudit.html': 'praudit.html',
        };
        if (Object.hasOwn(legacyMap, file)) {
            return sendHtmlFile(reply, legacyMap[file]);
        }
        reply.type('text/html; charset=utf-8');
        return phase2PlaceholderHtml(file.replace(/\.html$/i, ''));
    });

    for (const routePath of PHASE2_ROUTES) {
        app.get(routePath, async (_req, reply) => {
            reply.type('text/html; charset=utf-8');
            return phase2PlaceholderHtml(routePath.replace(/^\//, ''));
        });
    }

    app.get('/tools/*', async (req, reply) => {
        reply.type('text/html; charset=utf-8');
        return phase2PlaceholderHtml(`内置工具 (${req.params['*']})`);
    });

    registerCustomToolPages(app, phase2PlaceholderHtml);

    return app;
}
