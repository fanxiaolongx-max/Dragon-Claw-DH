import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { streamModel } from '../src/agent/provider.js';

test('streamModel: parses fallback GLM XML tool_calls when model emits raw text', async () => {
    // Start a mock SSE server simulating GLM-52 emitting raw XML <tool_call>
    const server = http.createServer((req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        const glmXml = '<tool_call>calculate<arg_key>expressions</arg_key><arg_value>["29+4+2", "1433+87+16"]</arg_value></tool_call>';
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: glmXml } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
        const deltas = [];
        const result = await streamModel({
            settings: {
                apiBaseUrl: `http://127.0.0.1:${port}`,
                apiKey: 'test-key',
                model: 'glm-52',
            },
            system: 'system prompt',
            messages: [{ role: 'user', content: 'test' }],
            tools: [{ name: 'calculate', description: 'calc', parameters: {} }],
            onDelta: (d) => deltas.push(d),
        });

        assert.equal(result.toolCalls.length, 1);
        assert.equal(result.toolCalls[0].name, 'calculate');
        assert.deepEqual(result.toolCalls[0].args, {
            expressions: ['29+4+2', '1433+87+16'],
        });
        assert.equal(result.text, ''); // Cleaned raw XML from user-visible text
        assert.equal(deltas.join('').includes('<tool_call>'), false, 'Deltas should not leak tool_call XML to client');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
