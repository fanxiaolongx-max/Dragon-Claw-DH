// 对话标题精简与清洗（与主线版 models/conversation-title.js & ai-title-generator.js 对齐）。
// 1. conversationTitle(question)：新对话创建瞬间立刻给出干净的规则短标题（去寒暄、附件、URL、代码块，按句意收拢），避免生硬截断 40 字。
// 2. cleanGeneratedTitle(raw, question)：清洗模型返回的 JSON 或纯文本标题，兼容思考模型输出与脱敏校验。
import { redactText } from '../agent/redact.js';

export const MAX_AI_TITLE_ZH = 14;
export const MAX_AI_TITLE_EN = 48;

const isZh = (text) => /[\u3400-\u9fff]/u.test(String(text || ''));

function compact(value, maxZh = 16, maxEn = 32) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const zhCount = (text.match(/[\u3400-\u9fff]/gu) || []).length;
    const enCount = text.length - zhCount;
    const weight = zhCount + Math.ceil(enCount / 2);
    const maxWeight = zhCount > 0 ? maxZh : maxEn;
    if (weight <= maxWeight) {
        return text.replace(/[\s，、:：;；的与和及(（\[【“"‘'.\-_]+$/u, '');
    }
    const words = text.split(' ');
    if (zhCount === 0 && words.length > 1) {
        let result = '';
        for (const word of words.slice(0, 7)) {
            if ((`${result} ${word}`).trim().length > 40) break;
            result = (`${result} ${word}`).trim();
        }
        if (result) return result;
    }
    let accWeight = 0;
    let cutIndex = 0;
    for (const ch of text) {
        accWeight += /[\u3400-\u9fff]/u.test(ch) ? 1 : 0.5;
        if (accWeight > maxWeight) break;
        cutIndex += ch.length;
    }
    return text.slice(0, cutIndex).replace(/[\s，、:：;；的与和及(（\[【“"‘'.\-_]+$/u, '');
}

/** 规则短标题：新对话创建时立刻显示，也在模型不可用或超时时作为干净兜底 */
export function conversationTitle(question) {
    const original = redactText(String(question || '')).slice(0, 8000);
    const urlMatch = original.match(/https?:\/\/[a-zA-Z0-9][-a-zA-Z0-9@:%._+~#=]{1,256}\b[-a-zA-Z0-9@:%_+.~#?&/=]*/i);
    const url = urlMatch ? urlMatch[0] : '';
    let text = original
        .replace(/\n?\s*(?:📎\s*)?(?:附件|Attachments?)\s*[:：][\s\S]*$/i, '')
        .replace(/https?:\/\/[^\s<>"'）。，；！？、\u4e00-\u9fa5\u3400-\u4dbf]+/gi, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/(?:^|\s)@[a-z][\w-]*/gi, ' ')
        .replace(/[#*`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const zh = isZh(text);

    if (/^[\d\s()+\-*/×÷=.]+$/.test(text) && /[+\-*/×÷]/.test(text)) {
        const cleanCalc = text.replace(/[^0-9+\-*/×÷.]/g, '').replace(/[+\-*/×÷.]+$/, '');
        return compact(`计算 ${cleanCalc || text.trim()}`);
    }
    if (/^(?:hi|hello|hey|你好|您好)$/i.test(text.trim()) || /\[object\s+\w+\]/i.test(original)) {
        return '新对话';
    }
    if (/NetCare/i.test(original) && /整改/i.test(original) && /表/i.test(original)) {
        return 'NetCare 整改相关表查询';
    }
    const atMatch = original.match(/@([a-zA-Z0-9_-]+)/);
    if (atMatch && /你能做|你能看|你可以做|做啥|看啥|做什么|可以做什么/.test(original)) {
        return `${atMatch[1]} 智能体咨询`;
    }

    if (zh) {
        if (/数据库/.test(text) && /有哪些|什么表|哪些表|看到|概览/.test(text)) return '平台数据库概览';
        if (/KPI.*(?:提醒|预警)|主动.*KPI/.test(text)) return 'KPI 预警深入分析';
        if (/指标/.test(text)) {
            if (/目标值|每个月目标/.test(text)) return '月度指标目标值查询';
            if (/最近.*如何|变化如何|趋势/.test(text)) return '近期指标趋势分析';
            if (/未达标|没达标|不达标/.test(text)) return `${/本月/.test(text) ? '本月' : ''}未达标指标`;
        }
        if (/截图|截一张图|截屏/.test(text)) {
            let site = '';
            try { site = url ? `${new URL(url).hostname.replace(/^www\./, '')} ` : ''; } catch { /* ignore */ }
            return compact(`${site}网页截图`);
        }
        if (/attachment|附件/i.test(original) && /这是什么|看.*什么/.test(text)) return '图片内容识别';
        if (/怎么用/.test(text) && text.length < 15) return '使用指引';
        if (/可以做什么|能做啥|可以做啥|能做什么|回答那些类型/.test(text) && text.length < 25) return '助手能力咨询';
    }

    text = text
        .replace(/^(?:(?:你好|请问|麻烦|请|帮我|帮忙|你能否|你能|你可以|能否|能不能|可以|我想要|我想|我们需要|单纯从|一下)\s*)+/i, '')
        .replace(/^(?:could you|can you|please|I would like to|I want to)\s+/i, '')
        .replace(/^(?:自动)?(?:创建|做)(?:一个|一份)(?=.{6})/, '创建')
        .replace(/[，,]?\s*(?:谢谢|多谢|thanks|thank you)[!！。.]?$/i, '')
        .replace(/[吗呢吧？?。！!]+$/u, '')
        .split(/[。！？!?；;\n]|[，,](?=.{6})/u)[0]
        .replace(/(?:看一下|一下|看下|看看)/g, '')
        .trim();
    return compact(text) || (zh ? '新对话' : 'New chat');
}

/** 清洗模型生成的标题：支持 {"title":"..."} JSON 或纯文本，拒绝过长/答非所问的输出 */
export function cleanGeneratedTitle(raw, question = '') {
    let text = String(raw || '').trim();
    if (!text) return '';
    const unwrapped = text.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1').trim();
    if (unwrapped.startsWith('{')) {
        try {
            const parsed = JSON.parse(unwrapped);
            if (typeof parsed?.title === 'string') text = parsed.title;
        } catch {
            const m = unwrapped.match(/"title"\s*:\s*"([^"]+)"/);
            if (m) text = m[1];
        }
    } else {
        text = unwrapped.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
    }
    text = text
        .replace(/^(?:标题|Title)\s*[:：]\s*/i, '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/^["'“”‘’《「【『\s]+|["'“”‘’》」】』。.!！?？\s]+$/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return '';
    const zh = isZh(text);
    const limit = zh ? MAX_AI_TITLE_ZH : MAX_AI_TITLE_EN;
    const chars = [...text];
    if (chars.length > limit + 8) return '';
    const clipped = chars.slice(0, limit).join('').replace(/[\s，、:：;；]+$/u, '').trim();
    if (!clipped) return '';
    return redactText(clipped) === clipped ? clipped : conversationTitle(question);
}

/** 判断已有标题是否已经足够精炼，不需要后台补齐 */
export function isTitleAlreadyShort(title) {
    const value = String(title || '').trim();
    if (!value) return false;
    return [...value].length <= (isZh(value) ? MAX_AI_TITLE_ZH : 28);
}
