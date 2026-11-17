// 思考内容不能混进正文（与主线版 tests/ai-provider-reasoning.test.js 同一组场景）：
// 各家思考字段、正文里的 think 标签、只出思考被截断时放宽上限重试、网关把回答归进思考字段。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { stripReasoningText, createThinkSplitter } from '../src/agent/reasoning.js';
import { streamModel } from '../src/agent/provider.js';

/** 按顺序返回给定的 SSE 事件列表，并记下每次请求体 */
async function fakeModel(responses) {
    const bodies = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            bodies.push(JSON.parse(raw));
            const events = responses[Math.min(bodies.length, responses.length) - 1];
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n');
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}/v1`, bodies, close: () => new Promise((r) => server.close(r)) };
}
const settings = (url, model) => ({ provider: 'openai', apiBaseUrl: url, apiKey: 'test-key-1234567890', model, maxOutputTokens: 2048 });
const collect = () => { const out = { text: '', thought: '' }; return { out, onDelta: (d) => { out.text += d; }, onThinking: (d) => { out.thought += d; } }; };
const delta = (d, finish) => ({ choices: [{ index: 0, delta: d, ...(finish ? { finish_reason: finish } : {}) }] });
const thinkingOnly = (finish) => [delta({ reasoning_content: 'Let me compare them row by row. ' }), delta({ reasoning_content: '1. Plan=0→0' }), delta({}, finish)];
const answered = [delta({ reasoning_content: '想好了。' }), delta({ content: '计划没有变。' }), delta({}, 'stop')];

test('stripReasoningText drops think blocks and reasoning that only has a closing tag', () => {
    assert.equal(stripReasoningText('Let me check the rows first.\n</think>\n\n计划没有变。'), '计划没有变。');
    assert.equal(stripReasoningText('<think>a</think>答案'), '答案');
    assert.equal(stripReasoningText('没有标签的正文'), '没有标签的正文');
});

test('think tags split across stream chunks go to the thinking channel', async () => {
    const parts = [];
    const splitter = createThinkSplitter(async (t) => parts.push(['text', t]), async (t) => parts.push(['think', t]));
    for (const chunk of ['开头<thi', 'nk>想一想', '</th', 'ink>结论']) await splitter.push(chunk);
    await splitter.flush();
    assert.deepEqual(parts.reduce((acc, [k, t]) => ({ ...acc, [k]: (acc[k] || '') + t }), {}), { text: '开头结论', think: '想一想' });
});

test('thinking that used up the output limit is never returned as the answer; the request is retried once with a larger limit', async () => {
    const model = await fakeModel([thinkingOnly('length'), answered]);
    try {
        const a = collect();
        const result = await streamModel({ settings: settings(model.url, 'glm-truncated'), system: '', messages: [{ role: 'user', content: 'hi' }], ...a });
        assert.equal(result.text, '计划没有变。');
        assert.equal(a.out.text, '计划没有变。', 'no thinking in the streamed answer');
        assert.match(a.out.thought, /row by row/);
        assert.deepEqual(model.bodies.map((b) => b.max_tokens), [2048, 8192]);
        // 之后的请求直接用放宽后的上限
        await streamModel({ settings: settings(model.url, 'glm-truncated'), system: '', messages: [{ role: 'user', content: 'hi' }], ...collect() });
        assert.equal(model.bodies[2].max_tokens, 8192);
    } finally { await model.close(); }
});

test('other reasoning fields, inline think tags, and gateways that put the whole answer in the reasoning field', async () => {
    const model = await fakeModel([
        [delta({ thinking: 'a' }), delta({ thought: 'b' }), delta({ reasoning_details: [{ text: 'c' }] }), delta({ content: '<think>d</think>答案' }), delta({}, 'stop')],
        thinkingOnly('stop'),
    ]);
    try {
        const a = collect();
        const fields = await streamModel({ settings: settings(model.url, 'fields'), system: '', messages: [{ role: 'user', content: 'hi' }], ...a });
        assert.deepEqual([fields.text, a.out.text, a.out.thought], ['答案', '答案', 'abcd']);
        // 模型没开思考、网关的推理解析把整段回答归进 reasoning：当正文用
        const b = collect();
        const merged = await streamModel({ settings: settings(model.url, 'qwen-no-think'), system: '', messages: [{ role: 'user', content: 'hi' }], ...b });
        assert.equal(merged.text, 'Let me compare them row by row. 1. Plan=0→0');
        assert.equal(b.out.text, merged.text);
    } finally { await model.close(); }
});
