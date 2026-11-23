import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { startMockBaseServer } from './helpers/mock-base.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let mock;
test.before(async () => {
    mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        APP_SCHEMA: 'bg-test',
        APP_UUID: 'bg-test',
        APP_DATASOURCE_ID: '2',
    });
});

test.after(async () => {
    await mock?.close();
});

test('A12 chat-live-runs: buffers deltas, enforces per-user limit, isolates owners, replays & stops cleanly', async () => {
    const runs = await import('../src/services/chat-live-runs.js');
    runs._clearForTest();
    try {
        const r1 = runs.createRun({ owner: 'alice', clientRunId: 'run_alpha_001', question: '第一个问题' });
        runs.bindSession(r1, 'sess-1');
        runs.pushEvent(r1, { type: 'start', sessionId: 'sess-1' });
        runs.pushEvent(r1, { type: 'delta', delta: '你好，' });
        runs.pushEvent(r1, { type: 'delta', delta: '世界' });

        assert.equal(runs.isRunning('sess-1', 'alice'), true);
        assert.equal(runs.isRunning('sess-1', 'bob'), false);
        assert.equal(runs.findBySession('sess-1', { owner: 'bob' }), null);
        assert.equal(runs.runningSessions('alice').length, 1);

        // Delta coalescing
        const deltas = r1.events.filter((e) => e.type === 'delta');
        assert.equal(deltas.length, 1);
        assert.equal(deltas[0].delta, '你好，世界');

        // Replaying to a reconnecting watcher via watchRun
        const written = [];
        let ended = false;
        let hijacked = false;
        const raw = Object.assign(new EventEmitter(), {
            headersSent: false,
            destroyed: false,
            writableEnded: false,
            writeHead() { this.headersSent = true; },
            write(chunk) { written.push(chunk); },
            end() { ended = true; this.writableEnded = true; },
        });
        const reply = { raw, hijack() { hijacked = true; } };
        runs.watchRun(r1, reply, { prelude: { type: 'live', runId: r1.id, sessionId: 'sess-1', question: r1.question } });
        assert.equal(hijacked, true);
        runs.pushEvent(r1, { type: 'delta', delta: '！' });
        runs.pushEvent(r1, { type: 'done', sessionId: 'sess-1', reply: '你好，世界！' });
        runs.finishRun(r1);
        assert.equal(ended, true);
        const parsed = written.join('').trim().split('\n').map((l) => JSON.parse(l));
        assert.equal(parsed[0].type, 'live');
        assert.equal(parsed.some((e) => e.type === 'delta' && e.delta.includes('你好，世界')), true);
        assert.equal(parsed.at(-1).type, 'done');
        assert.equal(runs.isRunning('sess-1', 'alice'), false);
        // Recently completed run is still attachable with includeDone
        assert.ok(runs.findBySession('sess-1', { owner: 'alice', includeDone: true }));

        // Concurrency limit per user
        const active = [];
        for (let i = 0; i < runs.MAX_PARALLEL; i += 1) {
            active.push(runs.createRun({ owner: 'alice', question: `q${i}` }));
        }
        assert.throws(() => runs.createRun({ owner: 'alice', question: 'overflow' }), (err) => err.code === 'AI_TOO_MANY_RUNS' && err.status === 429);
        // Another user is unaffected
        const bobRun = runs.createRun({ owner: 'bob', question: 'bob q' });
        assert.ok(bobRun.id);

        // Stop checks ownership
        assert.equal(runs.stopRun({ runId: active[0].id, owner: 'bob' }), false);
        assert.equal(active[0].abortController.signal.aborted, false);
        assert.equal(runs.stopRun({ runId: active[0].id, owner: 'alice' }), true);
        assert.equal(active[0].abortController.signal.aborted, true);
    } finally {
        runs._clearForTest();
    }
});

test('A36 agent loop: detects finish_reason=length truncated tool args, raises maxTokens and reports AGENT_TOOL_ARGS_TRUNCATED', async () => {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const payload = JSON.parse(body || '{}');
            requests.push(payload);
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
            if (requests.length === 1) {
                res.write(`data: ${JSON.stringify({
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{ index: 0, id: 'call_trunc_1', type: 'function', function: { name: 'save_skill', arguments: '{"skill_md":"---\\nid: huge\\n---\\nvery long content' } }],
                        },
                        finish_reason: null,
                    }],
                })}\n\n`);
                res.write(`data: ${JSON.stringify({
                    choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
                    usage: { prompt_tokens: 100, completion_tokens: 1024 },
                })}\n\n`);
                res.write('data: [DONE]\n\n');
            } else {
                res.write(`data: ${JSON.stringify({
                    choices: [{ index: 0, delta: { content: '已精简说明，请在技能广场导入。' }, finish_reason: null }],
                })}\n\n`);
                res.write(`data: ${JSON.stringify({
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 120, completion_tokens: 30 },
                })}\n\n`);
                res.write('data: [DONE]\n\n');
            }
            res.end();
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
        const { runAgent } = await import('../src/agent/loop.js');
        const events = [];
        const res = await runAgent({
            settings: {
                provider: 'openai-compatible',
                apiBaseUrl: `http://127.0.0.1:${port}/v1`,
                apiKey: 'test-key',
                model: 'mock-trunc-model',
                maxOutputTokens: 1024,
            },
            identity: { username: 'admin', isAdmin: true, isSuper: true },
            history: [{ role: 'user', content: '保存一个很长的技能' }],
            emit: (ev) => events.push(ev),
        });
        assert.equal(requests.length, 2);
        assert.equal(requests[0].max_tokens, 1024);
        assert.ok(requests[1].max_tokens >= 8192, `expected raised max_tokens >= 8192, got ${requests[1].max_tokens}`);
        const toolMsg = requests[1].messages.find((m) => m.role === 'tool');
        assert.ok(toolMsg && /AGENT_TOOL_ARGS_TRUNCATED/.test(toolMsg.content));
        assert.match(toolMsg.content, /技能广场/);
        assert.equal(events.some((e) => e.type === 'tool_result' && /截断/.test(e.summary || '')), true);
        assert.match(res.text, /技能广场/);
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('C9 frontend contract: base shared-conversations.js beforeOpen throws SHARE_REVOKED and dragon-claw.js handles error.revoked', () => {
    const sharedJs = fs.readFileSync(path.join(ROOT, 'static/js/home/shared-conversations.js'), 'utf8');
    const dcJs = fs.readFileSync(path.join(ROOT, 'static/js/home/dragon-claw.js'), 'utf8');
    assert.match(sharedJs, /beforeOpen:\s*async\s+sessionId[\s\S]*handleSyncClose\(sessionId,\s*res\.result\)[\s\S]*SHARE_REVOKED/);
    assert.match(dcJs, /if\s*\(error\?\.revoked\)\s*\{\s*state\.restoring\s*=\s*false;\s*newChat\(\);\s*return;\s*\}/);
});

test('前端对齐契约（A34/A35/A14/A21/C15）：主题变量、图标回退、Markdown 渲染、团队横幅与成员弹窗', () => {
    const readStatic = (rel) => fs.readFileSync(path.join(ROOT, 'static', rel), 'utf8');
    // A34
    const homeTheme = readStatic('css/home-theme.css');
    assert.match(homeTheme, /html\.platform-home\[data-theme="dark"\] #toolMarketModal/);
    assert.match(homeTheme, /--market-surface:\s*var\(--v2-pop/);
    // A35
    const homeShell = readStatic('js/home/home-shell.js');
    assert.match(homeShell, /function renderAccountLogo\(/);
    assert.match(homeShell, /\/assets\/icon\.png/);
    assert.match(homeShell, /\/assets\/logo\.png/);
    // A14
    const convList = readStatic('js/home/conversation-list.js');
    assert.match(convList, /const sourceOf=\(config,item\)=>.*itemSource/);
    assert.match(convList, /const bySource=new Map\(\)/);
    const aiAssistant = readStatic('js/shared/ai-assistant.js');
    assert.match(aiAssistant, /ai-emoji ai-emoji-keycap/);
    assert.match(aiAssistant, /blocks\.push\('<hr>'\)/);
    const sharedCss = readStatic('css/shared.css');
    assert.match(sharedCss, /Apple Color Emoji/);
    const dcCss = readStatic('css/dragon-claw.css');
    assert.match(dcCss, /\.ai-emoji-keycap\s*\{/);
    assert.match(dcCss, /\.dc-think-panel\s*\{/);
    // A21
    const platformCore = readStatic('js/shared/platform-core.js');
    assert.match(platformCore, /function ensureViewingTeamBannerStyle\(\)/);
    assert.match(platformCore, /function setViewingTeamBannerSwitching\(/);
    assert.match(platformCore, /window\.location\.href = `\$\{window\.DH_BASE \|\| ''\}\/`;/);
    // C15
    const platformSettings = readStatic('js/shared/platform-settings.js');
    assert.match(platformSettings, /data-dh-team-members/);
    assert.match(platformSettings, /是团队「.*」当前唯一成员/);
});
