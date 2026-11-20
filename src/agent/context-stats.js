import { config } from '../config.js';

// 智能体上下文窗口估算与循环内裁剪：CJK 字符按 1.5 token、图片按 1500 估算，超预算时先按整轮移除，再分阶缩短更早的工具结果。
const IMAGE_TOKENS = 1500;
const IMAGE_STANDIN = 'i'.repeat(IMAGE_TOKENS * 3);
const withoutImageData = (key, value) => (key === 'images' && Array.isArray(value) ? value.map(() => IMAGE_STANDIN) : value);

export function estimateTokens(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value || '', withoutImageData);
    const dense = (text.match(/[\u2e80-\u9fff\uac00-\ud7af]/g) || []).length;
    return Math.ceil((text.length - dense) / 3 + dense * 1.5);
}

// 常见模型的默认上下文窗口；配置显式改过且大于默认 64k 兜底时以配置为准
const DEFAULT_WINDOWS = [
    [/\[1m\]|[-_]1m\b/, 1_000_000],
    [/claude/, 200_000],
    [/gemini-1\.5-pro/, 2_000_000],
    [/gemini/, 1_000_000],
    [/minimax-m1/, 1_000_000],
    [/minimax-m2|minimax-m3/, 200_000],
    [/gpt-4\.1/, 1_000_000],
    [/gpt-5/, 400_000],
    [/gpt-4o|^o\d/, 128_000],
    [/gpt-4(?!o)/, 8_192],
    [/deepseek|qwen|glm|kimi|moonshot/, 128_000],
];

export function windowFor(model, configured = 0) {
    const fixed = Math.round(Number(configured) || 0);
    const name = String(model || '').toLowerCase();
    const hit = DEFAULT_WINDOWS.find(([pattern]) => pattern.test(name));
    if (fixed > 0 && fixed !== 64000) return fixed;
    return hit ? hit[1] : (fixed || 128_000);
}

export function budgetFor(windowTokens, maxOutputTokens = 4096) {
    return Math.max(1024, Math.floor(windowTokens * 0.9) - Math.max(2048, Number(maxOutputTokens) || 4096));
}

export function compactThreshold(windowTokens, maxOutputTokens = 4096) {
    const ratio = config.agentCompactRatio || 0.8;
    return Math.max(512, Math.min(Math.floor(windowTokens * ratio), budgetFor(windowTokens, maxOutputTokens) - Math.floor(windowTokens * 0.05)));
}

export function estimateRequest(systemPrompt, tools, messages) {
    const payload = JSON.stringify([systemPrompt || '', (tools || []).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })), messages || []], withoutImageData);
    return estimateTokens(payload);
}

/**
 * 保证 OpenAI 消息序列配对合法（assistant(toolCalls) 后紧跟对应的 role='tool'），按用户提问划分整轮：
 * 先移出最老的整轮，必要时再从早到晚缩短工具返回值，最新工具结果最后才碰。
 */
export function fitMessages({ model, contextWindow = 0, systemPrompt = '', messages = [], tools = [], maxOutputTokens = 4096 } = {}) {
    const window = windowFor(model, contextWindow);
    const budget = budgetFor(window, maxOutputTokens);
    const turns = [];
    for (const message of messages) {
        if (message.role === 'user' || !turns.length) turns.push([]);
        turns[turns.length - 1].push(message);
    }
    const cost = () => estimateRequest(systemPrompt, tools, turns);
    let droppedTurns = 0;
    while (turns.length > 1 && cost() > budget) {
        turns.shift();
        droppedTurns += 1;
    }
    // 单轮内多步工具调用超过预算时，先删去最老的 (assistant(toolCalls) + tool...) 组，保留首条 user 和最新步骤
    if (turns.length === 1 && cost() > budget) {
        const only = turns[0];
        const firstUser = only[0]?.role === 'user' ? [only[0]] : [];
        const rest = firstUser.length ? only.slice(1) : [...only];
        while (rest.length > 2 && estimateRequest(systemPrompt, tools, [...firstUser, ...rest]) > budget) {
            if (rest[0]?.role === 'assistant' && rest[0].toolCalls?.length) {
                const next = rest.findIndex((message, index) => index > 0 && message.role !== 'tool');
                if (next < 0) break; // 最后一个并行调用即使有多个结果也必须成组保留。
                rest.splice(0, next);
            } else {
                rest.shift();
            }
            droppedTurns += 1;
        }
        turns[0] = [...firstUser, ...rest];
    }
    const toolSlots = [];
    turns.forEach((turn, turnIndex) => turn.forEach((entry, entryIndex) => { if (entry.role === 'tool') toolSlots.push([turnIndex, entryIndex]); }));
    const latest = toolSlots.pop();
    for (const slots of [toolSlots, latest ? [latest] : []]) {
        for (const limit of [1000, 300]) {
            for (const [turnIndex, entryIndex] of slots) {
                if (cost() <= budget) break;
                const entry = turns[turnIndex][entryIndex];
                const raw = String(entry.content || '');
                if (raw.length > limit + 80) {
                    turns[turnIndex][entryIndex] = { ...entry, content: `${raw.slice(0, limit)}\n…（上下文已缩短，以适配模型窗口上限）` };
                }
            }
        }
    }
    return { messages: turns.flat(), droppedTurns, budget, window };
}
