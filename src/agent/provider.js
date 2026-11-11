// 模型适配：带工具调用的流式对话。支持 OpenAI 兼容接口（含大多数内网网关、Gemini 的 OpenAI 兼容端点）与 Anthropic Messages。
// 内部消息格式（与厂商无关）：
//   { role: 'user', content }
//   { role: 'assistant', content, toolCalls: [{ id, name, args }] }
//   { role: 'tool', toolCallId, name, content }
import { Agent, fetch as undiciFetch } from 'undici';
import { config } from '../config.js';
import { BusinessError } from '../core/errors.js';
import { buildCompletionRequest } from '../services/ai-service.js';

const dispatcher = new Agent({
    connect: { rejectUnauthorized: config.httpVerifySsl, timeout: 15_000 },
    headersTimeout: 120_000,
    bodyTimeout: 180_000,
});

function toOpenAiMessages(system, messages) {
    const out = system ? [{ role: 'system', content: system }] : [];
    for (const m of messages) {
        if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
        else if (m.role === 'assistant' && m.toolCalls?.length) {
            out.push({
                role: 'assistant',
                content: m.content || null,
                tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })),
            });
        } else out.push({ role: m.role, content: m.content || '' });
    }
    return out;
}

function toAnthropicMessages(messages) {
    const out = [];
    const push = (role, blocks) => {
        const last = out[out.length - 1];
        if (last && last.role === role) last.content.push(...blocks);
        else out.push({ role, content: blocks });
    };
    for (const m of messages) {
        if (m.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]);
        else if (m.role === 'assistant') {
            const blocks = [];
            if (m.content) blocks.push({ type: 'text', text: m.content });
            for (const c of m.toolCalls || []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} });
            if (blocks.length) push('assistant', blocks);
        } else if (m.content) push('user', [{ type: 'text', text: m.content }]);
    }
    return out;
}

async function* sseEvents(body) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const payload = t.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try { yield JSON.parse(payload); } catch { /* 网关的保活行或半截数据 */ }
        }
    }
}

function parseArgs(raw) {
    if (!raw || !String(raw).trim()) return {};
    try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
        return { __invalid: String(raw).slice(0, 400) };
    }
}

// 限流、网关抖动、连接被重置这类瞬时故障：在还没开始输出之前重试一次（间隔 1.2 秒）
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504, 529]);
async function post(url, headers, body, signal) {
    for (let attempt = 1; ; attempt += 1) {
        try {
            const resp = await undiciFetch(url, { method: 'POST', headers, body: JSON.stringify(body), dispatcher, signal });
            if (attempt === 1 && TRANSIENT_STATUS.has(resp.status)) {
                await resp.body?.cancel?.().catch(() => {});
            } else {
                return resp;
            }
        } catch (error) {
            if (signal?.aborted) throw error;
            if (attempt > 1) throw new BusinessError(`连接模型服务失败：${error.cause?.code || error.message}`, 502);
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
}

/**
 * 发起一轮模型调用。返回 { text, toolCalls, usage, stopReason, toolsSupported }。
 * onDelta(text) 正文增量；onThinking(text) 思考增量。
 */
export async function streamModel({ settings, system, messages, tools = [], signal, onDelta = () => {}, onThinking = () => {} }) {
    const spec = buildCompletionRequest(settings, [], { stream: true, maxTokens: Number(settings.maxOutputTokens) || 4096 });
    const usage = { inputTokens: 0, outputTokens: 0 };
    let text = '';
    let stopReason = '';

    if (spec.provider === 'anthropic') {
        const body = { ...spec.body, system: system || undefined, messages: toAnthropicMessages(messages) };
        if (typeof body.temperature !== 'number') delete body.temperature;
        if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
        const resp = await post(spec.url, spec.headers, body, signal);
        if (!resp.ok) throw new BusinessError(`模型服务 HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 300)}`, 502);
        const blocks = new Map();
        for await (const ev of sseEvents(resp.body)) {
            if (ev.type === 'message_start') usage.inputTokens += Number(ev.message?.usage?.input_tokens || 0);
            else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
                blocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, raw: '' });
            } else if (ev.type === 'content_block_delta') {
                const d = ev.delta || {};
                if (d.type === 'text_delta' && d.text) { text += d.text; await onDelta(d.text); }
                else if (d.type === 'thinking_delta' && d.thinking) await onThinking(d.thinking);
                else if (d.type === 'input_json_delta' && blocks.has(ev.index)) blocks.get(ev.index).raw += d.partial_json || '';
            } else if (ev.type === 'message_delta') {
                usage.outputTokens += Number(ev.usage?.output_tokens || 0);
                if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
            } else if (ev.type === 'error') {
                throw new BusinessError(`模型服务返回错误：${ev.error?.message || JSON.stringify(ev.error).slice(0, 200)}`, 502);
            }
        }
        const toolCalls = [...blocks.values()].map((b) => ({ id: b.id, name: b.name, args: parseArgs(b.raw) }));
        return { text, toolCalls, usage, stopReason, toolsSupported: true };
    }

    // OpenAI 兼容
    const base = { ...spec.body, messages: toOpenAiMessages(system, messages), stream: true };
    if (typeof base.temperature !== 'number') delete base.temperature;
    const attempts = [
        { tools: true, usage: true },
        { tools: true, usage: false }, // 部分网关不认 stream_options
        { tools: false, usage: false }, // 模型或网关不支持工具调用：退回纯对话
    ].filter((a) => tools.length || !a.tools).filter((a, i, list) => list.findIndex((b) => b.tools === a.tools && b.usage === a.usage) === i);
    let resp;
    let used = attempts[0];
    let lastError = '';
    for (const attempt of attempts) {
        const body = { ...base };
        if (attempt.tools) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
        if (attempt.usage) body.stream_options = { include_usage: true };
        resp = await post(spec.url, spec.headers, body, signal);
        used = attempt;
        if (resp.ok) break;
        lastError = `模型服务 HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 300)}`;
        // 只有“请求格式不被接受”才值得换一种格式重试；鉴权、限流、服务端错误直接报
        if (![400, 404, 422].includes(resp.status)) break;
    }
    if (!resp.ok) throw new BusinessError(lastError, 502);

    const calls = new Map();
    for await (const ev of sseEvents(resp.body)) {
        if (ev.error) throw new BusinessError(`模型服务返回错误：${ev.error.message || JSON.stringify(ev.error).slice(0, 200)}`, 502);
        if (ev.usage) {
            usage.inputTokens = Number(ev.usage.prompt_tokens || usage.inputTokens);
            usage.outputTokens = Number(ev.usage.completion_tokens || usage.outputTokens);
        }
        const choice = ev.choices?.[0];
        if (!choice) continue;
        const d = choice.delta || {};
        const thinking = d.reasoning_content || d.reasoning;
        if (typeof thinking === 'string' && thinking) await onThinking(thinking);
        if (typeof d.content === 'string' && d.content) { text += d.content; await onDelta(d.content); }
        for (const tc of d.tool_calls || []) {
            const idx = Number(tc.index ?? calls.size);
            if (!calls.has(idx)) calls.set(idx, { id: '', name: '', raw: '' });
            const slot = calls.get(idx);
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name += tc.function.name;
            if (tc.function?.arguments) slot.raw += tc.function.arguments;
        }
        if (choice.finish_reason) stopReason = choice.finish_reason;
    }
    const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({
        id: c.id || `call_${Date.now().toString(36)}_${i}`,
        name: c.name,
        args: parseArgs(c.raw),
    })).filter((c) => c.name);
    return { text, toolCalls, usage, stopReason, toolsSupported: used.tools };
}
