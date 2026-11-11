import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config, STATIC_DIR } from './config.js';
import { BusinessError } from './core/errors.js';
import { resolveRequestIdentity } from './core/identity.js';
import { pushLog } from './core/log-ring.js';
import { requestContext, scopedCheckHealth, isMemoryMode } from './dao/scoped.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { debugRoutes } from './routes/debug.js';
import { aiRoutes, aiSettingsRoutes } from './routes/ai.js';
import { uivRoutes, uivAiAdapterRoutes, uivAutoImportRoutes } from './routes/uiv.js';
import { slaRoutes } from './routes/sla.js';
import { uploadRoutes } from './routes/upload.js';
import { dbRoutes, expediteRoutes } from './routes/db.js';
import { monthlySnapshotsRoutes, reportMsgRoutes, aiReportRoutes } from './routes/monthly.js';
import { platformShellRoutes } from './routes/platform-shell.js';

const DH_SUBPATH_RE = /^\/digital-human\/dh\/[0-9a-f-]+(?=\/|$|\?)/i;
const DH_BARE_SUBPATH_RE = /^\/digital-human\/dh\/[0-9a-f-]+$/i;

const PHASE1_PAGES = new Map([
    ['/uivf12', 'pages/uivf12.html'],
    ['/sla', 'pages/sla.html'],
    ['/report', 'pages/report.html'],
    ['/expedite', 'pages/expedite.html'],
    ['/monthly', 'pages/ai-report.html'],
    ['/monthly/legacy', 'pages/monthly.html'],
    ['/bigscreen', 'pages/bigscreen.html'],
]);

const PHASE2_ROUTES = new Set([
    '/praudit',
    '/frt',
    '/storage',
    '/db-explorer',
    '/netcare-explorer',
    '/topic-analysis',
    '/duty-roster',
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

    await app.register(multipart, {
        limits: {
            fileSize: 64 * 1024 * 1024,
            files: 10,
        },
    });

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

    app.addHook('onRequest', (req, reply, done) => {
        const requestId = String(req.headers['x-request-id'] || crypto.randomUUID());
        const identity = resolveRequestIdentity(req);
        req.requestId = requestId;
        req.startedAt = Date.now();
        req.userIdentity = identity;
        reply.header('x-request-id', requestId);

        requestContext.run({
            requestId,
            userId: identity.username,
            cookieHeader: req.headers.cookie || '',
        }, done);
    });

    app.addHook('onResponse', async (req, reply) => {
        const url = String(req.url || '');
        if (!url.startsWith('/api/') && !url.startsWith('/debug')) return;
        if (url.startsWith('/api/debug/logs')) return;
        const durationMs = req.startedAt ? Date.now() - req.startedAt : 0;
        const status = reply.statusCode;
        const level = status >= 500 ? 'ERROR' : (status >= 400 ? 'WARN' : 'INFO');
        pushLog({
            level,
            category: 'HTTP',
            message: `${req.method} ${url} -> ${status}`,
            requestId: req.requestId || '',
            userId: req.userIdentity?.username || '',
            durationMs,
        });
    });

    app.setErrorHandler((err, req, reply) => {
        const status = err instanceof BusinessError
            ? (err.code >= 400 && err.code < 600 ? err.code : 400)
            : (err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500);
        pushLog({
            level: status >= 500 ? 'ERROR' : 'WARN',
            category: 'ERR',
            message: `${req.method} ${req.url} -> ${status}: ${err.message}`,
            requestId: req.requestId || '',
            userId: req.userIdentity?.username || '',
            detail: config.debug ? { name: err.name, stack: String(err.stack || '').split('\n').slice(0, 4) } : null,
        });
        if (reply.sent) return;
        return reply.code(status).send({
            error: err.message || '服务内部错误',
            code: err.code || (status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'),
            requestId: req.requestId || '',
        });
    });

    // ── 健康检查兼容根路径 & /api ──────────────────────────
    app.get('/healthz', async () => ({
        status: 'ok',
        service: config.appName,
        version: config.appVersion,
        memoryMode: isMemoryMode(),
        db: isMemoryMode() ? { healthy: true, mode: 'memory' } : await scopedCheckHealth().catch((e) => ({ healthy: false, error: e.message })),
    }));

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
    await app.register(platformShellRoutes);

    // ── 静态资源前缀兼容（确保 /pages/*.html 与 /monthly/legacy 下相对资源与无前缀资源一致）─
    for (const staticPrefix of ['/pages', '/monthly']) {
        app.get(`${staticPrefix}/css/*`, async (req, reply) => reply.sendFile(`css/${req.params['*']}`));
        app.get(`${staticPrefix}/js/*`, async (req, reply) => reply.sendFile(`js/${req.params['*']}`));
        app.get(`${staticPrefix}/assets/*`, async (req, reply) => reply.sendFile(`assets/${req.params['*']}`));
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
        const allowed = new Set(['uivf12.html', 'sla.html', 'report.html', 'expedite.html', 'monthly.html', 'ai-report.html', 'bigscreen.html']);
        if (allowed.has(file)) {
            return sendHtmlFile(reply, `pages/${file}`);
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

    app.get('/custom-tools/*', async (req, reply) => {
        reply.type('text/html; charset=utf-8');
        return phase2PlaceholderHtml(`自定义工具 (${req.params['*']})`);
    });

    return app;
}
