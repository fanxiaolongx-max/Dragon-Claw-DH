import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { streamModel } from '../src/agent/provider.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readStatic = (rel) => fs.readFileSync(path.join(ROOT, 'static', rel), 'utf8');

test('HTML responses inject cache-busting ?v= query strings and CSS/JS set no-cache headers', async () => {
    const app = await createServer();
    await app.ready();
    try {
        const resHome = await app.inject({
            method: 'GET',
            url: '/digital-human/dh/11111111-2222-3333-4444-555555555555/',
            headers: { 'x-dh-user': 'tester_01' },
        });
        assert.equal(resHome.statusCode, 200);
        assert.equal(resHome.headers['cache-control'], 'no-store');
        assert.match(resHome.payload, /href="css\/home-theme\.css\?v=[^"]+"/);
        assert.match(resHome.payload, /src="js\/home\/tool-frame\.js\?v=[^"]+"/);
        assert.doesNotMatch(resHome.payload, /id="dcSpotlight"/);

        const resToolHtml = await app.inject({
            method: 'GET',
            url: '/digital-human/dh/11111111-2222-3333-4444-555555555555/uivf12.html',
            headers: { 'x-dh-user': 'tester_01' },
        });
        assert.equal(resToolHtml.statusCode, 200);
        assert.equal(resToolHtml.headers['cache-control'], 'no-store');
        assert.match(resToolHtml.payload, /\.(?:css|js)\?v=[^"]+/);

        const resCss = await app.inject({ method: 'GET', url: '/css/home-theme.css' });
        assert.equal(resCss.statusCode, 200);
        assert.equal(resCss.headers['cache-control'], 'no-cache');

        const resJs = await app.inject({ method: 'GET', url: '/js/home/tool-frame.js' });
        assert.equal(resJs.statusCode, 200);
        assert.equal(resJs.headers['cache-control'], 'no-cache');
    } finally {
        await app.close();
    }
});

test('streamModel computes real TPS/TTFT on streamed chunks and estimated metrics on single-chunk fallback', async () => {
    let mode = 'stream';
    const server = http.createServer(async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (mode === 'stream') {
            await new Promise((r) => setTimeout(r, 25));
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '第一段' } }] })}\n\n`);
            await new Promise((r) => setTimeout(r, 35));
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '第二段输出内容用于测算真实生成速率' } }], usage: { prompt_tokens: 120, completion_tokens: 24 } })}\n\n`);
            res.write('data: [DONE]\n\n');
        } else {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '单块快速响应内容' } }] })}\n\n`);
            res.write('data: [DONE]\n\n');
        }
        res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        const resStream = await streamModel({
            settings: { apiBaseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'glm-52' },
            system: 'sys',
            messages: [{ role: 'user', content: 'hi' }],
        });
        assert.equal(resStream.metrics.timingSource, 'request-stream');
        assert.equal(resStream.metrics.timingEstimated, false);
        assert.ok(resStream.metrics.ttftMs >= 15);
        assert.ok(resStream.metrics.tps > 0);
        assert.equal(resStream.usage.outputTokens, 24);

        mode = 'single';
        const resSingle = await streamModel({
            settings: { apiBaseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'glm-52' },
            system: 'sys',
            messages: [{ role: 'user', content: 'hi' }],
        });
        assert.equal(resSingle.metrics.timingEstimated, true);
        assert.ok(resSingle.metrics.ttftMs >= 1);
        assert.ok(resSingle.metrics.tps > 0);
        assert.ok(resSingle.usage.outputTokens >= 1);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('home-shell appGlyph and tool-navigation handle gateway subpath for Discover Apps and embedded iframe open', () => {
    const basePrefix = '/digital-human/dh/da8d3449-344f-4b10-805d-0f831e2ad754';
    const dhStripBase = (p) => (p.startsWith(basePrefix) ? p.slice(basePrefix.length) || '/' : p);

    const homeShellCode = readStatic('js/home/home-shell.js');
    const fnMatch = homeShellCode.match(/function appGlyph\(href\)\s*\{[\s\S]*?\n    \}/);
    assert.ok(fnMatch, 'appGlyph should exist in home-shell.js');

    const sandbox = {
        window: { dhStripBase },
        location: { href: `https://example.test${basePrefix}/`, origin: 'https://example.test' },
        URL,
    };
    const appGlyph = vm.runInNewContext(`(${fnMatch[0]})`, sandbox);
    assert.equal(appGlyph(`${basePrefix}/uivf12.html`), 'capture');
    assert.equal(appGlyph(`${basePrefix}/sla`), 'importData');
    assert.equal(appGlyph(`${basePrefix}/bigscreen.html`), 'dashboard');
    assert.equal(appGlyph(`${basePrefix}/monthly-legacy.html`), 'calendar');
    assert.equal(appGlyph(`${basePrefix}/custom-tool.html?slug=demo`), 'puzzle');
    assert.notEqual(appGlyph(`${basePrefix}/uivf12.html`), 'grid');

    const toolFrameCode = readStatic('js/home/tool-frame.js');
    assert.match(toolFrameCode, /if \(!frameGuard\) close\(\{ restore: false \}\)/, 'tool-frame guards against home:mode closing newly opened frame');
});

test('dragon-claw fallback TPS/TTFT, pinned sidebar section, and theme CSS checks hold', () => {
    const dcCode = readStatic('js/home/dragon-claw.js');
    const helperMatch = dcCode.match(/function estimateTokensClient[\s\S]*?function speedSummary\(rounds = \[\]\)\s*\{[\s\S]*?\n    \}/);
    assert.ok(helperMatch, 'estimateTokensClient, buildFallbackRounds, and speedSummary exist');

    const { buildFallbackRounds, speedSummary } = vm.runInNewContext(
        `${helperMatch[0]}; ({ buildFallbackRounds, speedSummary })`,
        {},
    );

    // Client-stream fallback
    const streamFb = buildFallbackRounds({
        modelName: 'glm-52',
        text: '测试输出文本，确保能算出估算吞吐',
        usage: { inputTokens: 100, outputTokens: 20 },
        clientTiming: { startedAt: 1000, firstDeltaAt: 1500, endedAt: 2500 },
    });
    const streamSum = speedSummary(streamFb);
    assert.equal(streamSum.isEstimated, true);
    assert.equal(streamSum.ttft, 500);
    assert.equal(streamSum.avg, 20);

    // History-delta fallback
    const histFb = buildFallbackRounds({
        modelName: 'glm-52',
        text: '历史消息估算回复',
        usage: { inputTokens: 500, outputTokens: 30 },
        historyTiming: { modelTime: 10_000, prevTime: 4_000 },
    });
    const histSum = speedSummary(histFb);
    assert.equal(histSum.isEstimated, true);
    assert.ok(histSum.ttft > 0);
    assert.ok(histSum.avg > 0);

    // Ultimate fallback when zero timing metadata exists
    const ultFb = buildFallbackRounds({ modelName: 'glm-52', text: '只有正文没有时间戳兜底估算', usage: {} });
    const ultSum = speedSummary(ultFb);
    assert.equal(ultSum.isEstimated, true);
    assert.ok(ultSum.ttft > 0);
    assert.ok(ultSum.avg > 0);

    // Pinned collapsible section above tasks in renderChatList
    assert.match(dcCode, /categoryPinned:\s*'置顶'/);
    assert.match(dcCode, /data-section="pinned"/);

    // CSS brace balance on home-skill-hub.css
    const hubCss = readStatic('css/home-skill-hub.css');
    const opens = (hubCss.match(/\{/g) || []).length;
    const closes = (hubCss.match(/\}/g) || []).length;
    assert.equal(opens, closes, `home-skill-hub.css braces should be balanced (${opens} vs ${closes})`);

    // Theme CSS includes light think/activity/resume contrast & dark table/#toolMarketModal & compact import modal
    const themeCss = readStatic('css/home-theme.css');
    assert.match(themeCss, /html\.platform-home:not\(\[data-theme="dark"\]\) \.dc-think-phase/);
    assert.match(themeCss, /html\.platform-home:not\(\[data-theme="dark"\]\) \.dc-activity/);
    assert.match(themeCss, /html\.platform-home\[data-theme="dark"\] \.dc-msg-body table/);
    assert.match(themeCss, /html\.platform-home\[data-theme="dark"\] #toolMarketModal/);
    assert.match(themeCss, /#customToolImportModal \.tool-import-dialog[^}]*width:\s*min\(460px/);
});
