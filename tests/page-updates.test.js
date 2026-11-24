import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { PAGE_FILES, collectPageFiles, isSharedChurnOnly } from '../scripts/page-updates.mjs';
import { startMockBaseServer } from './helpers/mock-base.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATIC_DIR = path.join(ROOT, 'static');

let mock;
test.before(async () => {
    mock = await startMockBaseServer();
    Object.assign(process.env, {
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        BASE_APP_SCHEMA_QUERY_URL: `${mock.baseUrl}/app/query`,
        BASE_APP_SCHEMA_EXECUTE_URL: `${mock.baseUrl}/app/execute`,
        APP_ID: 'test-app',
        APP_NAME: 'test-app',
    });
});

test.after(async () => {
    await mock?.close();
});

test('page-updates: cross-page asset ownership isolates /ai-bi from /js/ai-report/* and ignores shared churn', () => {
    const owned = collectPageFiles(STATIC_DIR);
    const rel = (files) => files.map((f) => path.relative(STATIC_DIR, f).replace(/\\/g, '/'));
    const aiBiFiles = rel(owned['/ai-bi'] || []);
    const monthlyFiles = rel(owned['/monthly'] || []);

    assert.ok(aiBiFiles.includes('ai-bi.html'));
    assert.ok(aiBiFiles.includes('css/ai-bi.css'));
    assert.ok(!aiBiFiles.some((f) => f.startsWith('js/ai-report/') || f === 'css/ai-report.css'),
        `ai-bi should not include ai-report assets: ${aiBiFiles.join(', ')}`);
    assert.ok(monthlyFiles.includes('js/ai-report/query.js'));
    for (const [href, files] of Object.entries(owned)) {
        assert.ok(!rel(files).includes('css/startup-screen.css'), `${href} should not include startup-screen.css`);
    }

    assert.equal(isSharedChurnOnly([
        '-    <script src="/js/shared/dh-runtime.js?v=1"></script>',
        '+    <script src="/js/shared/dh-runtime.js?v=2"></script>',
    ]), true);
    assert.equal(isSharedChurnOnly([
        '-    <h1>Old</h1>',
        '+    <h1>New</h1>',
    ]), false);
});

test('page-updates: static/assets/page-updates.json covers all 13 pages and /api/home/page-updates serves it', async () => {
    const manifestPath = path.join(STATIC_DIR, 'assets', 'page-updates.json');
    assert.ok(fs.existsSync(manifestPath), 'static/assets/page-updates.json exists');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(Object.keys(manifest).sort(), Object.keys(PAGE_FILES).sort());
    assert.ok('/requirements' in manifest);
    for (const value of Object.values(manifest)) {
        assert.ok(Number.isFinite(Date.parse(value)), `invalid ISO timestamp: ${value}`);
    }

    const { platformShellRoutes } = await import('../src/routes/platform-shell.js');
    const app = Fastify();
    await app.register(platformShellRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/home/page-updates' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body['/ai-bi'], manifest['/ai-bi']);
    assert.equal(body['/requirements'], manifest['/requirements']);
    assert.equal(body['/monthly'], manifest['/monthly']);
    assert.deepEqual(Object.keys(body).sort(), Object.keys(PAGE_FILES).sort());
    await app.close();
});
