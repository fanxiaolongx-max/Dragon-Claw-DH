import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

// Playwright 与 Chromium 不是本包依赖：用环境变量指定，或从本机常见位置自动发现；找不到时本用例跳过
const PW_CANDIDATES = [
    process.env.PLAYWRIGHT_MODULE_PATH,
    'playwright',
    'playwright-core',
].filter(Boolean);

function discoverChromium() {
    const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
    const linuxCache = path.join(os.homedir(), '.cache', 'ms-playwright');
    const found = [];
    for (const root of [cache, linuxCache]) {
        if (!fs.existsSync(root)) continue;
        // 完整版 Chromium 优先于 headless shell（后者截图不稳定），同类里按目录名顺序
        const dirs = fs.readdirSync(root).sort();
        for (const dir of [...dirs.filter((d) => d.startsWith('chromium-')), ...dirs.filter((d) => d.startsWith('chromium_headless_shell-'))]) {
            for (const rel of [
                'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
                'chrome-headless-shell-mac-arm64/chrome-headless-shell',
                'chrome-linux/chrome',
                'chrome-headless-shell-linux/chrome-headless-shell',
            ]) found.push(path.join(root, dir, rel));
        }
    }
    return found;
}

const CHROME_CANDIDATES = [
    process.env.CHROMIUM_EXECUTABLE_PATH,
    ...discoverChromium(),
].filter(Boolean);

function loadPlaywright() {
    for (const candidate of PW_CANDIDATES) {
        try {
            return require(candidate);
        } catch (_) {
            // Try next candidate
        }
    }
    return null;
}

function findChromiumExecutable() {
    for (const candidate of CHROME_CANDIDATES) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = http.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            srv.close((err) => (err ? reject(err) : resolve(addr.port)));
        });
    });
}

async function waitForHealth(baseUrl, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${baseUrl}/api/healthz`);
            if (res.ok) return await res.json();
            lastErr = new Error(`HTTP ${res.status}`);
        } catch (err) {
            lastErr = err;
        }
        await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`Server failed healthcheck within ${timeoutMs}ms: ${lastErr?.message}`);
}

const SUBPATH_PREFIX = '/digital-human/dh/11111111-2222-3333-4444-555555555555';
const PHASE1_ROUTES = ['/', '/uivf12', '/sla', '/report', '/expedite', '/monthly', '/monthly/legacy', '/bigscreen'];

test('Headless Chromium UI E2E: root & subpath fidelity, zero console/HTTP errors, Phase-2 guard, and Debug Console', async (t) => {
    const pw = loadPlaywright();
    const executablePath = findChromiumExecutable();
    if (!pw || !executablePath) {
        t.skip(`Playwright or Chromium not found (pw=${Boolean(pw)}, chrome=${Boolean(executablePath)})`);
        return;
    }

    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const logs = [];
    const child = spawn(process.execPath, [path.join(APP_ROOT, 'run.js')], {
        cwd: APP_ROOT,
        env: {
            ...process.env,
            HOST: '127.0.0.1',
            PORT: String(port),
            LOCAL_DEV_MEMORY: '1',
            LOG_LEVEL: 'info',
            SSO_DEFAULT_USER: 'pw_tester',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => logs.push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => logs.push(chunk.toString('utf8')));

    let browser;
    try {
        await waitForHealth(baseUrl);

        // 1. Bare subpath redirect must append trailing slash and preserve query params (relative Location safe behind proxies)
        const bareRes = await fetch(`${baseUrl}${SUBPATH_PREFIX}?tab=ai`, { redirect: 'manual' });
        assert.equal(bareRes.status, 302);
        const resolvedBare = new URL(bareRes.headers.get('location'), `${baseUrl}${SUBPATH_PREFIX}?tab=ai`);
        assert.equal(resolvedBare.pathname, `${SUBPATH_PREFIX}/`);
        assert.equal(resolvedBare.search, '?tab=ai');

        browser = await pw.chromium.launch({
            headless: true,
            executablePath,
            args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
        });

        async function auditRoute(fullUrl, label) {
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const page = await context.newPage();
            const pageErrors = [];
            const consoleErrors = [];
            const badResponses = [];

            page.on('pageerror', (err) => pageErrors.push(err.message));
            page.on('console', (msg) => {
                if (msg.type() === 'error') {
                    consoleErrors.push(msg.text());
                }
            });
            page.on('response', (res) => {
                if (res.url().startsWith(baseUrl) && res.status() >= 400) {
                    badResponses.push(`${res.status()} ${res.url()}`);
                }
            });

            await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 25000 });
            try {
                await page.waitForSelector('#dhDebugPill', { timeout: 10000 });
            } catch (err) {
                err.message = `${label}: ${err.message} | badResponses=${JSON.stringify(badResponses)} | pageErrors=${JSON.stringify(pageErrors)} | consoleErrors=${JSON.stringify(consoleErrors)}`;
                throw err;
            }
            await page.waitForTimeout(350);

            const bodyTextLen = await page.evaluate(() => (document.body?.innerText || '').trim().length);
            assert.ok(bodyTextLen > 20, `${label}: body innerText unexpectedly empty`);
            assert.deepEqual(badResponses, [], `${label}: unexpected HTTP >= 400 responses`);
            assert.deepEqual(pageErrors, [], `${label}: unexpected pageerrors`);
            assert.deepEqual(consoleErrors, [], `${label}: unexpected console.error`);

            await context.close();
        }

        // 2. Audit all 8 Phase-1 routes at root (/)
        for (const route of PHASE1_ROUTES) {
            await auditRoute(`${baseUrl}${route}`, `root ${route}`);
        }

        // 3. Audit all 8 Phase-1 routes behind gateway subpath prefix
        for (const route of PHASE1_ROUTES) {
            const target = route === '/' ? `${baseUrl}${SUBPATH_PREFIX}/` : `${baseUrl}${SUBPATH_PREFIX}${route}`;
            await auditRoute(target, `subpath ${route}`);
        }

        // 4. Homepage interactivity, Phase-2 notice, & Debug Drawer E2E under subpath
        {
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            await context.addCookies([{ name: 'iLearningXUserName', value: 'pw_tester', url: baseUrl }]);
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));

            await page.goto(`${baseUrl}${SUBPATH_PREFIX}/`, { waitUntil: 'networkidle', timeout: 25000 });
            await page.waitForSelector('#dhDebugPill', { timeout: 10000 });

            const detectedBase = await page.evaluate(() => window.DH_BASE);
            assert.equal(detectedBase, SUBPATH_PREFIX);

            // Check no blocking login overlay traps the homepage
            const loginBlocking = await page.evaluate(() => {
                const body = document.body?.innerText || '';
                const modal = document.querySelector('.relogin-modal, #loginModal');
                const modalVisible = modal ? getComputedStyle(modal).display !== 'none' : false;
                return { modalVisible, hasComposerOrTitle: body.includes('AI') || document.querySelectorAll('a').length > 3 };
            });
            assert.equal(loginBlocking.modalVisible, false, 'Login modal must not block homepage');
            assert.equal(loginBlocking.hasComposerOrTitle, true, 'Homepage content did not render');

            // Open #tools (or visible card) and click a Phase-2 link: must stay on page and pop Phase-2 notice
            if (await page.locator('#v2DiscoverBtn').isVisible()) {
                await page.click('#v2DiscoverBtn');
                await page.waitForTimeout(200);
            }
            let visiblePhase2 = page.locator('a[href*="praudit"]:visible, a[href*="duty-roster"]:visible, a[href*="frt"]:visible').first();
            if (!(await visiblePhase2.count())) {
                await page.goto(`${baseUrl}${SUBPATH_PREFIX}/#tools`, { waitUntil: 'networkidle', timeout: 25000 });
                await page.waitForSelector('#dhDebugPill', { timeout: 10000 });
                visiblePhase2 = page.locator('a[href*="praudit"]:visible, a[href*="duty-roster"]:visible, a[href*="frt"]:visible').first();
            }
            if (await visiblePhase2.count()) {
                await visiblePhase2.click();
                await page.waitForTimeout(250);
                assert.ok(page.url().startsWith(`${baseUrl}${SUBPATH_PREFIX}`), 'Phase-2 click navigated away unexpectedly');
                const hasNotice = await page.evaluate(() => {
                    const p2 = document.getElementById('dhPhase2Toast');
                    const p2Text = p2 && !p2.hidden ? p2.textContent : '';
                    const body = document.body?.innerText || '';
                    return p2Text.includes('二期规划') || body.includes('二期规划');
                });
                assert.equal(hasNotice, true, 'Clicking Phase-2 card must display Phase-2 notice toast');
            }

            // Open Persistent Debug Console
            await page.click('#dhDebugPill');
            await page.waitForSelector('#dhDebugDrawer', { state: 'visible', timeout: 5000 });

            // Run All Self-Check Probes
            await page.click('button:has-text("一键全量自检")');
            await page.waitForFunction(
                () => document.querySelectorAll('.dh-dbg-probe-card').length >= 14,
                undefined,
                { timeout: 15000 }
            );
            const probeOkCount = await page.locator('.dh-dbg-pill-ok').count();
            assert.ok(probeOkCount >= 14, `Expected >= 14 passing probes in memory mode, got ${probeOkCount}`);

            // Check Identity & Env Tab
            await page.click('.dh-dbg-tab:has-text("身份与环境")');
            await page.waitForFunction(
                () => document.querySelectorAll('.dh-dbg-kv').length >= 6,
                undefined,
                { timeout: 5000 }
            );
            const idText = await page.locator('.dh-dbg-panel.active').innerText();
            assert.ok(idText.includes('pw_tester'), `Identity panel missing username pw_tester: ${idText}`);
            assert.ok(idText.includes(SUBPATH_PREFIX), `Identity panel missing subpath DH_BASE: ${idText}`);

            // Check Real-time Backend Logs SSE Tab
            await page.click('.dh-dbg-tab:has-text("实时后端日志")');
            await page.waitForFunction(
                () => document.querySelectorAll('.dh-dbg-log-row').length >= 1,
                undefined,
                { timeout: 8000 }
            );

            assert.deepEqual(errors, [], 'Unexpected pageerrors during homepage debug E2E');
            await context.close();
        }

        // 5. Verify Debug Pill also mounts & opens on a subpage (/report under subpath)
        {
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const page = await context.newPage();
            await page.goto(`${baseUrl}${SUBPATH_PREFIX}/report`, { waitUntil: 'networkidle', timeout: 25000 });
            await page.waitForSelector('#dhDebugPill', { timeout: 10000 });
            await page.click('#dhDebugPill');
            await page.waitForSelector('#dhDebugDrawer', { state: 'visible', timeout: 5000 });
            await context.close();
        }
    } catch (err) {
        err.message = `${err.message}\n--- SERVER LOGS ---\n${logs.join('')}`;
        throw err;
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            await Promise.race([
                new Promise((r) => child.once('exit', r)),
                new Promise((r) => setTimeout(() => { try { child.kill('SIGKILL'); } catch {} r(); }, 2500)),
            ]);
        }
    }
});
