// 模型适配：带工具调用的流式对话。支持 OpenAI 兼容接口（含大多数内网网关、Gemini 的 OpenAI 兼容端点）与 Anthropic Messages。
// 内部消息格式（与厂商无关）：
//   { role: 'user', content }
//   { role: 'assistant', content, toolCalls: [{ id, name, args }] }
//   { role: 'tool', toolCallId, name, content }
import { Agent, fetch as undiciFetch } from 'undici';
import { reasoningDelta, stripReasoningText, createThinkSplitter, settleReasoningOnly, reasoningKey, reasoningHungry, TRUNCATED_FINISH_RE, REASONING_RETRY_TOKENS } from './reasoning.js';
import { BusinessError } from '../core/errors.js';
import { buildCompletionRequest } from '../services/ai-service.js';

// 每套模型方案自己决定是否校验 HTTPS 证书（默认不校验，兼容内网自签证书网关）
const agentOptions = (verify) => ({ connect: { rejectUnauthorized: verify, timeout: 15_000 }, headersTimeout: 120_000, bodyTimeout: 180_000 });
const strictDispatcher = new Agent(agentOptions(true));
const insecureDispatcher = new Agent(agentOptions(false));
const dispatcherFor = (settings) => (settings?.verifySsl === true ? strictDispatcher : insecureDispatcher);

const GEMINI_PLACEHOLDER_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

function requiresGeminiThoughtSignature(model = '') {
    return /gemini[-_./]?(?:[3-9]|\d{2,})(?:\.|-|_|$)/i.test(String(model || ''));
}

function isGeminiTarget(model = '', provider = '') {
    return provider === 'gemini' || /gemini/i.test(String(model || ''));
}

function extractThoughtSignature(obj) {
    const candidates = [
        [obj?.extra_content?.google?.thought_signature, 'extra_content'],
        [obj?.extra_content?.google?.thoughtSignature, 'extra_content'],
        [obj?.provider_specific_fields?.thought_signature, 'provider_specific_fields'],
        [obj?.provider_specific_fields?.thoughtSignature, 'provider_specific_fields'],
        [obj?.thought_signature, 'extra_content'],
        [obj?.thoughtSignature, 'extra_content'],
        [obj?.function?.thought_signature, 'extra_content'],
        [obj?.function?.thoughtSignature, 'extra_content'],
    ];
    for (const [value, source] of candidates) {
        if (typeof value === 'string' && value) return { thoughtSignature: value, source };
    }
    return null;
}

function resolveToolCallIndex(tc, calls, totalInDelta) {
    if (tc.index !== undefined && tc.index !== null && Number.isInteger(Number(tc.index))) {
        return Number(tc.index);
    }
    if (tc.id) {
        for (const [idx, slot] of calls.entries()) {
            if (slot.id && slot.id === tc.id) return idx;
        }
    }
    if (!tc.id && !tc.function?.name && calls.size > 0 && totalInDelta === 1) {
        return Math.max(...calls.keys());
    }
    return calls.size ? Math.max(...calls.keys()) + 1 : 0;
}

function mergeNestedExtra(base, incoming) {
    if (!incoming || typeof incoming !== 'object') return base;
    if (!base || typeof base !== 'object') return { ...incoming };
    const merged = { ...base };
    for (const [k, v] of Object.entries(incoming)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && merged[k] && typeof merged[k] === 'object' && !Array.isArray(merged[k])) {
            merged[k] = { ...merged[k], ...v };
        } else {
            merged[k] = v;
        }
    }
    return merged;
}

function toOpenAiMessages(system, messages, { model = '', provider = '' } = {}) {
    const out = system ? [{ role: 'system', content: system }] : [];
    const geminiTarget = isGeminiTarget(model, provider);
    for (const m of messages) {
        if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
        else if (m.role === 'assistant' && m.toolCalls?.length) {
            const hasAnySignature = m.toolCalls.some((c) => Boolean(c.thoughtSignature));
            const needsPlaceholder = requiresGeminiThoughtSignature(model) && !hasAnySignature;
            out.push({
                role: 'assistant',
                content: m.content || null,
                tool_calls: m.toolCalls.map((c, index) => {
                    const tc = {
                        id: c.id,
                        type: 'function',
                        function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
                    };
                    const compatibleModel = geminiTarget || !c.model || (model && c.model === model);
                    if (compatibleModel) {
                        if (c.thoughtSignature) {
                            if (c.thoughtSignatureSource === 'provider_specific_fields') {
                                tc.provider_specific_fields = {
                                    ...(c.providerSpecificFields || {}),
                                    thought_signature: c.thoughtSignature,
                                };
                            } else {
                                tc.extra_content = {
                                    ...(c.extraContent || {}),
                                    google: {
                                        ...(c.extraContent?.google || {}),
                                        thought_signature: c.thoughtSignature,
                                    },
                                };
                            }
                        } else if (c.extraContent) {
                            tc.extra_content = c.extraContent;
                        } else if (needsPlaceholder && index === 0) {
                            tc.extra_content = { google: { thought_signature: GEMINI_PLACEHOLDER_THOUGHT_SIGNATURE } };
                        }
                    }
                    return tc;
                }),
            });
        } else if (m.images?.length) {
            out.push({
                role: m.role,
                content: [
                    { type: 'text', text: m.content || '' },
                    ...m.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } })),
                ],
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
        } else if (m.content || m.images?.length) {
            push('user', [
                ...(m.content ? [{ type: 'text', text: m.content }] : []),
                ...(m.images || []).map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.base64 } })),
            ]);
        }
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

function httpError(status, text) {
    const error = new BusinessError(`模型服务 HTTP ${status}: ${String(text || '').slice(0, 300)}`, 502);
    error.httpStatus = status;
    return error;
}

// 限流、网关抖动、连接被重置这类瞬时故障：在还没开始输出之前重试一次（间隔 1.2 秒）
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504, 529]);
async function post(url, headers, body, signal, dispatcher) {
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
function createToolTagFilter(onDelta) {
    let pending = '';
    return {
        async feed(chunk) {
            pending += chunk;
            const tagIdx = pending.search(/<\|?tool_call/i);
            if (tagIdx === -1) {
                const partial = pending.match(/<\|?(?:t(?:o(?:o(?:l(?:_(?:c(?:a(?:l(?:l)?)?)?)?)?)?)?)?)?$/i);
                if (partial) {
                    const emitText = pending.slice(0, partial.index);
                    pending = pending.slice(partial.index);
                    if (emitText) await onDelta(emitText);
                } else {
                    const emitText = pending;
                    pending = '';
                    if (emitText) await onDelta(emitText);
                }
            } else {
                const emitText = pending.slice(0, tagIdx);
                pending = pending.slice(tagIdx);
                if (emitText) await onDelta(emitText);
            }
        },
        async flush(isToolCall) {
            if (!isToolCall && pending) {
                await onDelta(pending);
            }
            pending = '';
        }
    };
}

function extractFallbackToolCalls(rawText) {
    const re = /<\|?tool_call\|?>\s*([a-zA-Z0-9_-]+)([\s\S]*?)(?:<\/\|?tool_call\|?>|$)/gi;
    const calls = [];
    let cleanedText = rawText;
    let m;
    while ((m = re.exec(rawText)) !== null) {
        const name = m[1].trim();
        const body = m[2];
        const args = {};
        const kvRe = /<arg_key>([^<]+)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;
        let kv;
        let foundKv = false;
        while ((kv = kvRe.exec(body)) !== null) {
            foundKv = true;
            const k = kv[1].trim();
            const rawV = kv[2].trim();
            try {
                args[k] = JSON.parse(rawV);
            } catch {
                args[k] = rawV;
            }
        }
        if (!foundKv) {
            const trimmed = body.trim();
            if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                Object.assign(args, parseArgs(trimmed));
            }
        }
        if (name) {
            calls.push({
                id: `call_${Date.now().toString(36)}_${calls.length}`,
                name,
                args,
            });
            cleanedText = cleanedText.replace(m[0], '');
        }
    }
    return { calls, text: cleanedText.trim() };
}

export function estimateTokens(text) {
    const value = String(text || '');
    if (!value) return 0;
    const cjk = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    return Math.max(1, Math.round(cjk / 1.6 + (value.length - cjk) / 4));
}

function finalizeRoundMetrics({ settings, system, messages, usage, text, thinkingText, toolCallsRaw, startedAt, firstTokenAt, chunks, cachedInputTokens, reasoningOutputTokens }) {
    const endedAt = Date.now();
    const ms = Math.max(1, endedAt - startedAt);
    const reportedIn = Number(usage.inputTokens) || 0;
    const reportedOut = Number(usage.outputTokens) || 0;
    if (!reportedIn) {
        const promptChars = [system || '', ...(Array.isArray(messages) ? messages.map((m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || ''))) : [])].join('\n');
        usage.inputTokens = estimateTokens(promptChars);
    }
    if (!reportedOut) {
        usage.outputTokens = estimateTokens(`${text || ''}${thinkingText || ''}${toolCallsRaw || ''}`);
    }
    const usageEstimated = !reportedOut;
    const hasStreamTiming = firstTokenAt > 0 && endedAt - firstTokenAt >= 15 && chunks > 1;
    const ttftMs = firstTokenAt > 0 ? Math.max(1, firstTokenAt - startedAt) : Math.max(1, Math.min(ms, Math.round(ms * 0.22)));
    const generationMs = hasStreamTiming ? (endedAt - firstTokenAt) : Math.max(10, ms - ttftMs);
    const timingEstimated = !hasStreamTiming || usageEstimated;
    const decodeTokens = hasStreamTiming && usage.outputTokens > 1 ? usage.outputTokens - 1 : Math.max(1, usage.outputTokens);
    const tps = generationMs > 0 ? Math.max(0.1, Math.round((decodeTokens / (generationMs / 1000)) * 10) / 10) : null;
    return {
        model: settings?.model || settings?.name || '',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimated: usageEstimated,
        cachedInputTokens: Number.isFinite(cachedInputTokens) && cachedInputTokens >= 0 ? cachedInputTokens : null,
        reasoningOutputTokens: Number.isFinite(reasoningOutputTokens) && reasoningOutputTokens >= 0 ? reasoningOutputTokens : (thinkingText ? estimateTokens(thinkingText) : 0),
        timingSource: 'request-stream',
        timingEstimated,
        decodeTokens,
        ms,
        ttftMs,
        generationMs,
        tps,
        at: new Date(startedAt).toISOString(),
    };
}

/**
 * 流式调用模型。只输出了思考就被输出上限截断时（推理模型把上限全花在思考上），
 * 放宽上限重试一次，并记住这个模型，之后的请求直接用放宽后的上限。
 */
export async function streamModel(args) {
    const { settings, signal } = args;
    const key = reasoningKey(settings);
    const configured = Number(settings.maxOutputTokens) || 4096;
    let maxTokens = reasoningHungry.has(key) && configured < REASONING_RETRY_TOKENS ? REASONING_RETRY_TOKENS : configured;
    let result = await streamModelOnce(args, maxTokens);
    if (result.reasoningOnly && TRUNCATED_FINISH_RE.test(String(result.stopReason || '')) && maxTokens < REASONING_RETRY_TOKENS && !signal?.aborted) {
        reasoningHungry.add(key);
        maxTokens = REASONING_RETRY_TOKENS;
        result = await streamModelOnce(args, maxTokens);
    }
    return result;
}

async function streamModelOnce({
 settings, system, messages, tools = [], signal, onDelta = () => {}, onThinking = () => {} }, maxTokens) {
    const spec = buildCompletionRequest(settings, [], { stream: true, maxTokens });
    const key = reasoningKey(settings);
    const usage = { inputTokens: 0, outputTokens: 0 };
    let text = '';
    let thinkingText = '';
    let stopReason = '';
    let startedAt = Date.now();
    let firstTokenAt = 0;
    let chunks = 0;
    let cachedInputTokens = null;
    let reasoningOutputTokens = null;
    const markToken = () => { if (!firstTokenAt) firstTokenAt = Date.now(); chunks += 1; };

    if (spec.provider === 'anthropic') {
        const body = { ...spec.body, system: system || undefined, messages: toAnthropicMessages(messages) };
        if (typeof body.temperature !== 'number') delete body.temperature;
        if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
        startedAt = Date.now();
        const resp = await post(spec.url, spec.headers, body, signal, dispatcherFor(settings));
        if (!resp.ok) throw httpError(resp.status, await resp.text().catch(() => ''));
        const blocks = new Map();
        for await (const ev of sseEvents(resp.body)) {
            if (ev.type === 'message_start') {
                usage.inputTokens += Number(ev.message?.usage?.input_tokens || 0);
                if (Number.isFinite(Number(ev.message?.usage?.cache_read_input_tokens))) {
                    cachedInputTokens = (cachedInputTokens || 0) + Number(ev.message.usage.cache_read_input_tokens);
                }
            } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
                markToken();
                blocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, raw: '' });
            } else if (ev.type === 'content_block_delta') {
                const d = ev.delta || {};
                if (d.type === 'text_delta' && d.text) { markToken(); text += d.text; await onDelta(d.text); }
                else if (d.type === 'thinking_delta' && d.thinking) { markToken(); thinkingText += d.thinking; await onThinking(d.thinking); }
                else if (d.type === 'input_json_delta' && blocks.has(ev.index)) { markToken(); blocks.get(ev.index).raw += d.partial_json || ''; }
            } else if (ev.type === 'message_delta') {
                usage.outputTokens += Number(ev.usage?.output_tokens || 0);
                if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
            } else if (ev.type === 'error') {
                throw new BusinessError(`模型服务返回错误：${ev.error?.message || JSON.stringify(ev.error).slice(0, 200)}`, 502);
            }
        }
        const toolCallsRaw = [...blocks.values()].map((b) => `${b.name}:${b.raw}`).join('\n');
        const toolCalls = [...blocks.values()].map((b) => ({ id: b.id, name: b.name, args: parseArgs(b.raw) }));
        const settled = settleReasoningOnly(key, { text: stripReasoningText(text), reasoning: thinkingText, toolCalls, finishReason: stopReason });
        if (settled.text && !stripReasoningText(text)) await onDelta(settled.text);
        text = settled.text;
        const metrics = finalizeRoundMetrics({ settings, system, messages, usage, text, thinkingText, toolCallsRaw, startedAt, firstTokenAt, chunks, cachedInputTokens, reasoningOutputTokens });
        return { text, toolCalls, usage, stopReason, toolsSupported: true, metrics, ...(settled.reasoningOnly ? { reasoningOnly: true } : {}) };
    }

    // OpenAI 兼容
    const base = { ...spec.body, messages: toOpenAiMessages(system, messages, { model: settings.model, provider: spec.provider }), stream: true };
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
        startedAt = Date.now();
        resp = await post(spec.url, spec.headers, body, signal, dispatcherFor(settings));
        used = attempt;
        if (resp.ok) break;
        lastError = httpError(resp.status, await resp.text().catch(() => ''));
        // 只有“请求格式不被接受”才值得换一种格式重试；鉴权、限流、服务端错误或缺少 thought_signature 直接报
        if (![400, 404, 422].includes(resp.status) || /thought_signature/i.test(String(lastError?.message || ''))) break;
    }
    if (!resp.ok) throw lastError;

    const calls = new Map();
    const tagFilter = createToolTagFilter(onDelta);
    // 正文里直接写的 think 标签：思考部分归到思考，其余照常经过工具标签过滤器输出
    const onReasoningText = async (chunk) => { thinkingText += chunk; await onThinking(chunk); };
    const splitter = createThinkSplitter((chunk) => tagFilter.feed(chunk), onReasoningText);
    for await (const ev of sseEvents(resp.body)) {
        if (ev.error) throw new BusinessError(`模型服务返回错误：${ev.error.message || JSON.stringify(ev.error).slice(0, 200)}`, 502);
        if (ev.usage) {
            usage.inputTokens = Number(ev.usage.prompt_tokens || ev.usage.input_tokens || usage.inputTokens);
            usage.outputTokens = Number(ev.usage.completion_tokens || ev.usage.output_tokens || usage.outputTokens);
            const cached = ev.usage.prompt_tokens_details?.cached_tokens ?? ev.usage.cache_read_input_tokens ?? ev.usage.cached_tokens;
            if (Number.isFinite(Number(cached)) && Number(cached) >= 0) cachedInputTokens = Number(cached);
            const reasoning = ev.usage.completion_tokens_details?.reasoning_tokens ?? ev.usage.reasoning_tokens;
            if (Number.isFinite(Number(reasoning)) && Number(reasoning) >= 0) reasoningOutputTokens = Number(reasoning);
        }
        const choice = ev.choices?.[0];
        if (!choice) continue;
        const d = choice.delta || {};
        const thinking = reasoningDelta(d);
        if (thinking) {
            markToken();
            await onReasoningText(thinking);
        }
        if (typeof d.content === 'string' && d.content) {
            markToken();
            text += d.content;
            await splitter.push(d.content);
        }
        const deltaCalls = Array.isArray(d.tool_calls) ? d.tool_calls : [];
        const deltaSig = extractThoughtSignature(d) || extractThoughtSignature(choice);
        deltaCalls.forEach((tc, pos) => {
            markToken();
            const idx = resolveToolCallIndex(tc, calls, deltaCalls.length);
            if (!calls.has(idx)) {
                calls.set(idx, {
                    id: '',
                    name: '',
                    raw: '',
                    thoughtSignature: '',
                    thoughtSignatureSource: '',
                    extraContent: null,
                    providerSpecificFields: null,
                });
            }
            const slot = calls.get(idx);
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name += tc.function.name;
            if (tc.function?.arguments) slot.raw += tc.function.arguments;
            if (tc.extra_content && typeof tc.extra_content === 'object') {
                slot.extraContent = mergeNestedExtra(slot.extraContent, tc.extra_content);
            }
            if (tc.provider_specific_fields && typeof tc.provider_specific_fields === 'object') {
                slot.providerSpecificFields = mergeNestedExtra(slot.providerSpecificFields, tc.provider_specific_fields);
            }
            const sig = extractThoughtSignature(tc) || (pos === 0 && !slot.thoughtSignature ? deltaSig : null);
            if (sig) {
                slot.thoughtSignature = sig.thoughtSignature;
                slot.thoughtSignatureSource = sig.source;
            }
        });
        if (choice.finish_reason) stopReason = choice.finish_reason;
    }
    const toolCallsRaw = [...calls.values()].map((c) => `${c.name}:${c.raw}`).join('\n');
    let toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({
        id: c.id || `call_${Date.now().toString(36)}_${i}`,
        name: c.name,
        args: parseArgs(c.raw),
        ...(c.thoughtSignature ? {
            thoughtSignature: c.thoughtSignature,
            thoughtSignatureSource: c.thoughtSignatureSource,
            ...(settings?.model ? { model: settings.model } : {}),
        } : {}),
        ...(c.extraContent ? { extraContent: c.extraContent } : {}),
        ...(c.providerSpecificFields ? { providerSpecificFields: c.providerSpecificFields } : {}),
    })).filter((c) => c.name);

    await splitter.flush();
    text = stripReasoningText(text);
    // 容错兜底：GLM 等国产大模型长文本多轮后可能退化为直接在文本中吐出 <tool_call> XML
    let hasFallback = false;
    if (!toolCalls.length && (text.includes('<tool_call>') || text.includes('<|tool_call|>') || text.includes('<tool_call'))) {
        const fallback = extractFallbackToolCalls(text);
        if (fallback.calls.length) {
            toolCalls = fallback.calls;
            text = fallback.text;
            hasFallback = true;
        }
    }
    const settled = settleReasoningOnly(key, { text, reasoning: thinkingText, toolCalls, finishReason: stopReason });
    // 网关把整段回答归进了思考字段：当正文补发给前端
    if (settled.text && !text) await tagFilter.feed(settled.text);
    text = settled.text;
    await tagFilter.flush(hasFallback);

    const metrics = finalizeRoundMetrics({ settings, system, messages, usage, text, thinkingText, toolCallsRaw, startedAt, firstTokenAt, chunks, cachedInputTokens, reasoningOutputTokens });
    return { text, toolCalls, usage, stopReason, toolsSupported: used.tools, metrics, ...(settled.reasoningOnly ? { reasoningOnly: true } : {}) };
}
