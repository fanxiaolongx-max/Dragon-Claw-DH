// 思考内容与正文分离（与主线版 tools-platform/backend/models/ai-provider-client.js 同一套规则）：
// 识别各家模型的思考字段、正文里的 think 标签（含对话模板已写好开头、正文只剩收尾标签的情况），
// 只出思考就被输出上限截断时由调用方放宽上限重试。

/** 流式增量里的思考内容：reasoning_content / reasoning / thinking / thought，以及 reasoning_details */
export function reasoningDelta(delta) {
    if (!delta) return "";
    for (const key of ["reasoning_content", "reasoning", "thinking", "thought"]) if (typeof delta[key] === "string" && delta[key]) return delta[key];
    if (Array.isArray(delta.reasoning_details)) return delta.reasoning_details.map((item) => (item && typeof item.text === "string" ? item.text : "")).join("");
    return "";
}

export const TRUNCATED_FINISH_RE = /^(length|max_tokens|max_output_tokens)$/i;
export const REASONING_RETRY_TOKENS = 8192;
const reasoningSplitSeen = new Set(); // 已确认会把思考和正文分开返回的「地址|模型」
export const reasoningHungry = new Set(); // 曾把输出上限全花在思考上的「地址|模型」：之后直接用放宽后的上限

export const reasoningKey = (settings = {}) => `${settings.apiBaseUrl || settings.provider || ""}|${settings.model || ""}`;

/**
 * 正文为空、只有思考时：被截断或这个模型以前正常分开返回过 → 返回空（不把思考当正文）；
 * 否则多半是网关把整段回答都归进了思考字段，把它当正文，保证这类部署能用。
 */
export function settleReasoningOnly(key, { text, reasoning, toolCalls, finishReason }) {
    if (text) {
        if (reasoning) reasoningSplitSeen.add(key);
        return { text, reasoningOnly: false };
    }
    if (!reasoning || (toolCalls && toolCalls.length)) return { text: "", reasoningOnly: false };
    if (TRUNCATED_FINISH_RE.test(String(finishReason || "")) || reasoningSplitSeen.has(key)) return { text: "", reasoningOnly: true };
    return { text: stripReasoningText(reasoning), reasoningOnly: false };
}

export function stripReasoningText(value) {
    let text = String(value || '');
    if (!text) return '';

    text = text.replace(/^\s*(AI|Assistant|助手)?\s*(?=<think\b)/i, '');
    text = text.replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '');
    text = text.replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi, '');

    // 对话模板已经替模型写好了开头的 <think>（DeepSeek-R1 / Qwen 等常见），正文里只剩一个收尾标签：标签之前全是思考
    const orphanClose = text.match(/<\/think(?:ing)?>/i);
    if (orphanClose && !/<think(?:ing)?\b[^>]*>/i.test(text.slice(0, orphanClose.index))) text = text.slice(orphanClose.index + orphanClose[0].length);

    const openThink = text.search(/<think(?:ing)?\b[^>]*>/i);
    if (openThink >= 0) {
        const afterOpen = text.slice(openThink).replace(/^<think(?:ing)?\b[^>]*>/i, '');
        const markers = [
            /\n\s*(?:最终答案|答案|总结|结论|回复|输出)\s*[:：]\s*/i,
            /\n\s*(?:Final Answer|Answer|Response|Summary)\s*[:：]\s*/i,
            /\n\s*<\/think(?:ing)?>\s*/i
        ];
        let best = -1;
        let bestLength = 0;
        markers.forEach(marker => {
            const match = afterOpen.match(marker);
            if (match && (best === -1 || match.index < best)) {
                best = match.index;
                bestLength = match[0].length;
            }
        });
        text = best >= 0 ? afterOpen.slice(best + bestLength) : '';
    }

    text = text
        .replace(/^\s*(?:最终答案|答案|总结|结论|回复|输出|Final Answer|Answer|Response|Summary)\s*[:：]\s*/i, '')
        .trim();
    return text;
}
/**
 * 流式输出里直接写在正文中的 think 标签：思考部分交给 onReasoning，其余交给 onText（两者都可以是异步函数，按顺序执行）。
 * 标签可能被切在两个分片之间，未确定的尾部先留着等下一片。
 */
export function createThinkSplitter(onText, onReasoning) {
    let buffer = "";
    let inThink = false;
    const OPEN = /<think(?:ing)?\b[^>]*>/i;
    const CLOSE = /<\/think(?:ing)?>/i;
    const pendingTag = (text) => {
        const at = text.lastIndexOf("<");
        return at >= 0 && at > text.length - 12 && !text.slice(at).includes(">") ? at : -1;
    };
    async function drain(final) {
        for (;;) {
            const match = buffer.match(inThink ? CLOSE : OPEN);
            if (match) {
                const before = buffer.slice(0, match.index);
                buffer = buffer.slice(match.index + match[0].length);
                if (before) await (inThink ? onReasoning : onText)(before);
                inThink = !inThink;
                continue;
            }
            const hold = final ? -1 : pendingTag(buffer);
            const ready = hold >= 0 ? buffer.slice(0, hold) : buffer;
            buffer = hold >= 0 ? buffer.slice(hold) : "";
            if (ready) await (inThink ? onReasoning : onText)(ready);
            return;
        }
    }
    return { push: (chunk) => { buffer += String(chunk || ""); return drain(false); }, flush: () => drain(true) };
}
