import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.LOCAL_DEV_MEMORY = '1';
process.env.LOG_LEVEL = 'silent';

const { streamModel } = await import('../src/agent/provider.js');
const { runAgent } = await import('../src/agent/loop.js');

function startMockServer(handler) {
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        await handler(req, res, body);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            close: () => new Promise((r) => server.close(r)),
        }));
    });
}

test('Gemini thought_signature: multi-turn runAgent preserves & replays extra_content without concatenation', async () => {
    const seenBodies = [];
    const srv = await startMockServer((req, res, body) => {
        seenBodies.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (seenBodies.length === 1) {
            res.write(`data: ${JSON.stringify({
                choices: [{
                    delta: {
                        tool_calls: [{
                            index: 0,
                            id: 'call_calc_1',
                            type: 'function',
                            function: { name: 'calculate', arguments: '{"expression":' },
                            extra_content: { google: { thought_signature: 'sig_opaque_123' } },
                        }],
                    },
                }],
            })}\n\n`);
            // Repeat same signature + trailing delta without index/id
            res.write(`data: ${JSON.stringify({
                choices: [{
                    delta: {
                        tool_calls: [{
                            function: { arguments: '"9+9+9+9+9+9"}' },
                            extra_content: { google: { thought_signature: 'sig_opaque_123' } },
                        }],
                    },
                    finish_reason: 'tool_calls',
                }],
            })}\n\n`);
        } else {
            const assistantMsg = body.messages.find((m) => m.role === 'assistant' && m.tool_calls?.length);
            if (!assistantMsg?.tool_calls?.[0]?.extra_content?.google?.thought_signature) {
                res.end();
                return;
            }
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '结果是 54。' }, finish_reason: 'stop' }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
    });

    try {
        const result = await runAgent({
            settings: {
                provider: 'gemini',
                apiBaseUrl: `http://127.0.0.1:${srv.port}`,
                apiKey: 'test-key',
                model: 'gemini-3.1-flash-lite',
            },
            identity: { username: 'u1', displayName: 'User 1', isAdmin: true, isSuper: true, identified: true },
            history: [{ role: 'user', content: '9+9+9+9+9+9' }],
        });

        assert.equal(seenBodies.length, 2);
        const sentAssistant = seenBodies[1].messages.find((m) => m.role === 'assistant');
        assert.equal(sentAssistant.tool_calls.length, 1);
        assert.deepEqual(sentAssistant.tool_calls[0].extra_content, {
            google: { thought_signature: 'sig_opaque_123' },
        });
        assert.match(result.text, /54/);
    } finally {
        await srv.close();
    }
});

test('Gemini thought_signature: parallel calls preserve signature on first only, trailing delta, and provider_specific_fields', async () => {
    const seenBodies = [];
    const srv = await startMockServer((req, res, body) => {
        seenBodies.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (seenBodies.length === 1) {
            // Parallel calls: index 0 gets extra_content in trailing delta, index 1 has no signature
            res.write(`data: ${JSON.stringify({
                choices: [{
                    delta: {
                        tool_calls: [
                            { index: 0, id: 'c0', type: 'function', function: { name: 'calculate', arguments: '{"expression":"1+1"}' } },
                            { index: 1, id: 'c1', type: 'function', function: { name: 'calculate', arguments: '{"expression":"2+2"}' } },
                        ],
                    },
                }],
            })}\n\n`);
            res.write(`data: ${JSON.stringify({
                choices: [{
                    delta: {
                        tool_calls: [{ index: 0, extra_content: { google: { thought_signature: 'sig_parallel_0' } } }],
                    },
                    finish_reason: 'tool_calls',
                }],
            })}\n\n`);
        } else if (seenBodies.length === 2) {
            // Second tool call uses LiteLLM provider_specific_fields
            res.write(`data: ${JSON.stringify({
                choices: [{
                    delta: {
                        tool_calls: [{
                            index: 0,
                            id: 'c2',
                            type: 'function',
                            function: { name: 'calculate', arguments: '{"expression":"3+3"}' },
                            provider_specific_fields: { thought_signature: 'sig_litellm' },
                        }],
                    },
                    finish_reason: 'tool_calls',
                }],
            })}\n\n`);
        } else {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
    });

    try {
        const settings = {
            provider: 'openai',
            apiBaseUrl: `http://127.0.0.1:${srv.port}`,
            apiKey: 'k',
            model: 'gemini-3.1-flash-lite',
        };
        const r1 = await streamModel({
            settings,
            system: 'sys',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ name: 'calculate', description: 'calc', parameters: {} }],
        });
        assert.equal(r1.toolCalls.length, 2);
        assert.equal(r1.toolCalls[0].thoughtSignature, 'sig_parallel_0');
        assert.equal(r1.toolCalls[1].thoughtSignature, undefined);

        const r2 = await streamModel({
            settings,
            system: 'sys',
            messages: [
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: '', toolCalls: r1.toolCalls },
                { role: 'tool', toolCallId: 'c0', name: 'calculate', content: '2' },
                { role: 'tool', toolCallId: 'c1', name: 'calculate', content: '4' },
            ],
            tools: [{ name: 'calculate', description: 'calc', parameters: {} }],
        });
        assert.deepEqual(seenBodies[1].messages[2].tool_calls[0].extra_content, { google: { thought_signature: 'sig_parallel_0' } });
        assert.equal(seenBodies[1].messages[2].tool_calls[1].extra_content, undefined);
        assert.equal(r2.toolCalls[0].thoughtSignature, 'sig_litellm');

        await streamModel({
            settings,
            system: 'sys',
            messages: [
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: '', toolCalls: r2.toolCalls },
                { role: 'tool', toolCallId: 'c2', name: 'calculate', content: '6' },
            ],
            tools: [{ name: 'calculate', description: 'calc', parameters: {} }],
        });
        assert.deepEqual(seenBodies[2].messages[2].tool_calls[0].provider_specific_fields, { thought_signature: 'sig_litellm' });
    } finally {
        await srv.close();
    }
});

test('Gemini thought_signature: injects validator bypass only for Gemini 3+ without signature, strips on non-Gemini failover', async () => {
    const seenBodies = [];
    const srv = await startMockServer((req, res, body) => {
        seenBodies.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    });

    try {
        const msgs = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'calculate', args: { expression: '1+1' } }, { id: 'c1', name: 'calculate', args: { expression: '2+2' } }] },
            { role: 'tool', toolCallId: 'c0', name: 'calculate', content: '2' },
            { role: 'tool', toolCallId: 'c1', name: 'calculate', content: '4' },
        ];
        // Gemini 3 model with unsigned calls -> placeholder ONLY on first call
        await streamModel({
            settings: { provider: 'gemini', apiBaseUrl: `http://127.0.0.1:${srv.port}`, apiKey: 'k', model: 'gemini-3.1-flash-lite' },
            system: 'sys',
            messages: msgs,
            tools: [],
        });
        assert.deepEqual(seenBodies[0].messages[2].tool_calls[0].extra_content, {
            google: { thought_signature: 'skip_thought_signature_validator' },
        });
        assert.equal(seenBodies[0].messages[2].tool_calls[1].extra_content, undefined);

        // Non-Gemini model -> NO extra_content injected; failover from Gemini also strips Google fields
        await streamModel({
            settings: { provider: 'openai', apiBaseUrl: `http://127.0.0.1:${srv.port}`, apiKey: 'k', model: 'gpt-4o-mini' },
            system: 'sys',
            messages: [
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'calculate', args: {}, thoughtSignature: 'gemini_sig', model: 'gemini-3.1-flash-lite' }] },
                { role: 'tool', toolCallId: 'c0', name: 'calculate', content: '2' },
            ],
            tools: [],
        });
        assert.equal(seenBodies[1].messages[2].tool_calls[0].extra_content, undefined);
    } finally {
        await srv.close();
    }
});

test('Gemini thought_signature: 400 missing thought_signature is not retried with tools:false', async () => {
    let requestCount = 0;
    const srv = await startMockServer((req, res) => {
        requestCount += 1;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{
            error: {
                code: 400,
                message: 'Function call is missing a thought_signature in functionCall parts.',
            },
        }]));
    });

    try {
        await assert.rejects(
            () => streamModel({
                settings: { provider: 'gemini', apiBaseUrl: `http://127.0.0.1:${srv.port}`, apiKey: 'k', model: 'gemini-3.1-flash-lite' },
                system: 'sys',
                messages: [{ role: 'user', content: 'hi' }],
                tools: [{ name: 'calculate', description: 'calc', parameters: {} }],
            }),
            /thought_signature/
        );
        assert.equal(requestCount, 1);
    } finally {
        await srv.close();
    }
});
