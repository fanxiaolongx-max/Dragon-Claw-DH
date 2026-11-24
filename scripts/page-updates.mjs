import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 构建期页面更新时间生成器（用于基座版发包与本地刷新 static/assets/page-updates.json）。
// 与主线 page-update-times.js 保持同一套规则：
// - 优先取页面 HTML 及其专属 js/css 的最近一次实质 git 提交时间（未提交改动取 mtime）；
// - 忽略公共资源（js/shared、shared.css、startup-screen.css、api.js、vendor、*.min.*）及仅刷新 ?v= 的提交；
// - 跨页复用的非共享模块（如 ai-bi 引用的 js/ai-report/*、css/ai-report.css）仅归属给命名空间匹配的主页面。

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const PAGE_FILES = {
    '/uivf12': 'uivf12.html',
    '/sla': 'sla.html',
    '/report': 'report.html',
    '/expedite': 'expedite.html',
    '/monthly': 'monthly.html',
    '/ai-bi': 'ai-bi.html',
    '/bigscreen': 'bigscreen.html',
    '/db-explorer': 'db-explorer.html',
    '/topic-analysis': 'topic-analysis.html',
    '/duty-roster': 'duty-roster.html',
    '/frt': 'frt.html',
    '/praudit': 'praudit.html',
    '/requirements': 'requirements.html',
};

const PAGE_NAMESPACES = {
    '/monthly': ['ai-report', 'monthly'],
};

const GIT_LOG_DEPTH = 200;
const ASSET_REF_RE = /<(?:script|link)\b[^>]*?\s(?:src|href)=["']([^"'?#\s]+\.(?:m?js|css))(?:\?[^"']*)?["']/gi;
const SHARED_ASSET_RE = /^(?:\/)?(?:js\/shared\/|css\/(?:shared|startup-screen)\.css$|js\/api\.js$|js\/vendor\/|vendor\/)|\.min\.(?:js|css)$/i;
const SHARED_TAG_LINE_RE = /^\s*<(?:script|link)\b[^>]*(?:\/js\/shared\/|\/css\/(?:shared|startup-screen)\.css|\/js\/api\.js|dh-runtime\.js|rel=["'](?:shortcut )?icon["']|rel=["']apple-touch-icon["'])[^>]*>(?:\s*<\/script>)?\s*$/i;

function mtimeOf(filePath) {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return 0;
    }
}

function escapeRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function namespacesFor(href, relPath) {
    if (PAGE_NAMESPACES[href]) return PAGE_NAMESPACES[href];
    const set = new Set();
    const routeSlug = String(href || '').replace(/^\/+|\/+$/g, '');
    const htmlBase = path.basename(String(relPath || ''), '.html');
    if (routeSlug) set.add(routeSlug);
    if (htmlBase) set.add(htmlBase);
    return [...set];
}

function assetBelongsToPage(href, relPath, relAsset) {
    const normalized = String(relAsset || '').replace(/\\/g, '/');
    return namespacesFor(href, relPath).some((ns) =>
        new RegExp(`(?:^|/)${escapeRegExp(ns)}(?:[/.]|$)`).test(normalized),
    );
}

function git(args, cwd) {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
        });
    });
}

async function readGitState(staticDir) {
    try {
        const root = (await git(['rev-parse', '--show-toplevel'], staticDir)).trim();
        const status = await git(['status', '--porcelain', '-z', '--', '.'], staticDir);
        const dirty = new Set(status.split('\0')
            .filter((entry) => entry.length > 3)
            .map((entry) => path.join(root, entry.slice(3))));
        return { root, dirty };
    } catch {
        return null;
    }
}

function rawPageFiles(staticDir, relPath) {
    const htmlPath = path.join(staticDir, relPath);
    let html;
    try {
        html = fs.readFileSync(htmlPath, 'utf8');
    } catch {
        return [];
    }
    const files = new Set([htmlPath]);
    for (const [, url] of html.matchAll(ASSET_REF_RE)) {
        if (/^(?:[a-z]+:|\/\/)/i.test(url) || SHARED_ASSET_RE.test(url)) continue;
        const clean = url.replace(/^\/+/, '');
        const assetPath = url.startsWith('/') ? path.join(staticDir, clean) : path.resolve(path.dirname(htmlPath), url);
        if (assetPath.startsWith(staticDir + path.sep) && fs.existsSync(assetPath)) files.add(assetPath);
    }
    return [...files];
}

export function collectPageFiles(staticDir, pageMap = PAGE_FILES) {
    const rawByPage = {};
    const refCount = new Map();
    for (const [href, relPath] of Object.entries(pageMap)) {
        const htmlPath = path.join(staticDir, relPath);
        const files = rawPageFiles(staticDir, relPath);
        rawByPage[href] = { htmlPath, relPath, files };
        for (const file of files) {
            if (file === htmlPath) continue;
            refCount.set(file, (refCount.get(file) || 0) + 1);
        }
    }
    const ownedByPage = {};
    for (const [href, { htmlPath, relPath, files }] of Object.entries(rawByPage)) {
        ownedByPage[href] = files.filter((file) => {
            if (file === htmlPath) return true;
            if ((refCount.get(file) || 0) <= 1) return true;
            return assetBelongsToPage(href, relPath, path.relative(staticDir, file));
        });
    }
    return ownedByPage;
}

export function isSharedChurnOnly(diffLines) {
    if (!diffLines.length) return false;
    const meaningful = diffLines
        .map((line) => [line[0], line.slice(1).replace(/\?v=[\w.-]*/g, '')])
        .filter(([, text]) => !SHARED_TAG_LINE_RE.test(text));
    const removed = meaningful.filter(([sign]) => sign === '-').map(([, text]) => text).sort();
    const added = meaningful.filter(([sign]) => sign === '+').map(([, text]) => text).sort();
    return removed.join('\n') === added.join('\n');
}

async function lastMeaningfulCommitTime(files, root) {
    let log;
    try {
        log = await git(['log', '-n', String(GIT_LOG_DEPTH), '-p', '--unified=0', '--format=%x00%ct', '--', ...files], root);
    } catch {
        return 0;
    }
    let oldest = 0;
    for (const entry of log.split('\0').slice(1)) {
        const [header, ...lines] = entry.split('\n');
        oldest = Number(header) * 1000;
        const diffLines = lines.filter((line) => /^[+-]/.test(line) && !/^(?:\+\+\+|---) /.test(line));
        if (!isSharedChurnOnly(diffLines)) return oldest;
    }
    return oldest;
}

function readExistingManifest(staticDir) {
    const manifestPath = path.join(staticDir, 'assets', 'page-updates.json');
    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const valid = {};
        for (const [href, value] of Object.entries(parsed)) {
            const ms = Date.parse(String(value || ''));
            if (Number.isFinite(ms) && ms > 0) valid[href] = ms;
        }
        return valid;
    } catch {
        return {};
    }
}

export async function computePageUpdateTimes(rootDir = ROOT) {
    const staticDir = path.join(rootDir, 'static');
    const gitState = await readGitState(staticDir);
    const existing = gitState ? {} : readExistingManifest(staticDir);
    const ownedByPage = collectPageFiles(staticDir);
    const entries = await Promise.all(Object.keys(PAGE_FILES).map(async (href) => {
        const files = ownedByPage[href] || [];
        if (!files.length) return [href, existing[href] || 0];
        if (!gitState) return [href, existing[href] || Math.max(...files.map(mtimeOf))];
        const dirty = files.filter((file) => gitState.dirty.has(file));
        const committed = files.filter((file) => !gitState.dirty.has(file));
        const dirtyAt = dirty.length ? Math.max(...dirty.map(mtimeOf)) : 0;
        const committedAt = committed.length ? await lastMeaningfulCommitTime(committed, gitState.root) : 0;
        return [href, Math.max(dirtyAt, committedAt) || existing[href] || Math.max(...files.map(mtimeOf))];
    }));
    return Object.fromEntries(entries
        .filter(([, latest]) => latest)
        .map(([href, latest]) => [href, new Date(latest).toISOString()]));
}

export async function writePageUpdatesManifest(rootDir = ROOT) {
    const times = await computePageUpdateTimes(rootDir);
    const outPath = path.join(rootDir, 'static', 'assets', 'page-updates.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(times, null, 2)}\n`, 'utf8');
    return { outPath, times };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { outPath, times } = await writePageUpdatesManifest(ROOT);
    console.log(`✅ 已生成 ${path.relative(ROOT, outPath)} (${Object.keys(times).length} 个页面)`);
}
