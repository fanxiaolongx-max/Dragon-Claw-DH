// 长期记忆：每个用户一份，保存“以后都这样做”的偏好与约定，跨对话有效，并按主题相关性注入提示词。
import { BusinessError } from '../core/errors.js';
import { kvGet, kvSet } from '../dao/scoped.js';
import { redactText } from '../agent/redact.js';
import { terms, topicScore } from '../agent/topic-context.js';

export const MAX_ITEMS = 100;
const MAX_CHARS = 500;
const MAX_TOPIC_CHARS = 100;
const PROMPT_CHARS = 4000;
const keyOf = (username) => `agent_memory:${String(username || 'anonymous').toLowerCase()}`;
// 凭据不进记忆：记忆会进系统提示，也会被同平台其他应用读到
const SECRET_RE = /(password|passwd|密码|口令|secret|token|api[_-]?key|密钥|cookie|authorization)\s*[:：=是为]?\s*\S*/i;
const CREDENTIAL_RE = /(密码|口令|password|passwd|pwd|api[_\s-]?key|secret|token|cookie|authorization)\s*[:：=]/i;

export async function listMemories(username) {
    const list = await kvGet(keyOf(username), []);
    return Array.isArray(list) ? list : [];
}

function cleanText(value, secrets = []) {
    return redactText(String(value || '').replace(/\s+/g, ' ').trim(), { secrets });
}

function validateContent(value, secrets = []) {
    const text = cleanText(value, secrets);
    if (!text) throw new BusinessError('记忆内容不能为空');
    if (text.length > MAX_CHARS) throw new BusinessError(`记忆内容最多 ${MAX_CHARS} 字，请精简成一句话`);
    if (CREDENTIAL_RE.test(text) || SECRET_RE.test(text)) throw new BusinessError('不能把密码、密钥这类凭据存进记忆');
    return text;
}

function cleanTopic(value, secrets = []) {
    if (!value) return '';
    const topic = cleanText(value, secrets);
    if (topic.length > MAX_TOPIC_CHARS) throw new BusinessError(`适用主题最多 ${MAX_TOPIC_CHARS} 字`);
    if (CREDENTIAL_RE.test(topic)) throw new BusinessError('不能把密码、密钥这类凭据存进记忆主题');
    return topic;
}

export async function changeMemory(username, { action, id, content, topic, secrets = [] } = {}) {
    const list = await listMemories(username);
    if (action === 'list') return { items: list };
    if (action === 'add') {
        const text = validateContent(content, secrets);
        const cleanTp = cleanTopic(topic, secrets);
        const same = list.find((x) => x.content === text && String(x.topic || '') === cleanTp);
        if (same) return { item: same, deduplicated: true };
        if (list.length >= MAX_ITEMS) throw new BusinessError(`记忆已满（${MAX_ITEMS} 条），请先合并或删除不再需要的`);
        const item = {
            id: list.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1,
            content: text,
            ...(cleanTp ? { topic: cleanTp } : {}),
            updatedAt: Date.now(),
        };
        await kvSet(keyOf(username), [...list, item]);
        return { item };
    }
    const target = list.find((x) => Number(x.id) === Number(id));
    if (!target) throw new BusinessError(`没有编号为 ${id} 的记忆`);
    if (action === 'update') {
        const text = validateContent(content, secrets);
        const cleanTp = topic !== undefined ? cleanTopic(topic, secrets) : String(target.topic || '');
        Object.assign(target, { content: text, updatedAt: Date.now() });
        if (cleanTp) target.topic = cleanTp;
        else delete target.topic;
        await kvSet(keyOf(username), list);
        return { item: target };
    }
    if (action === 'delete') {
        await kvSet(keyOf(username), list.filter((x) => x !== target));
        return { deleted: target.id };
    }
    throw new BusinessError('action 只能是 add / update / delete / list');
}

/** 按当前问题主题相关性筛选记忆并格式化进系统提示；没有相关记忆时返回空数组 */
export async function selectMemoriesForPrompt(username, question = null) {
    const rows = await listMemories(username).catch(() => []);
    if (!rows.length) return [];
    const words = question === null ? null : terms(question);
    const query = String(question ?? '').normalize('NFKC').toLowerCase();
    const ranked = rows
        .map((row) => {
            const tp = String(row?.topic || '');
            const topicNorm = tp.trim().normalize('NFKC').toLowerCase();
            const general = tp === '*' || (!tp && /^(?:默认|始终|总是|请一直)(?:使用|用)?(?:中文|英文|简体中文)(?:回复|回答)/.test(String(row?.content || '')));
            const exact = topicNorm.length >= 2 && /\p{Script=Han}/u.test(topicNorm) && query.includes(topicNorm);
            const score = general || words === null ? 1 : (exact ? 100 : 0) + topicScore(tp || row.content, words) * 2;
            return { row, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || (Number(b.row.updatedAt) || 0) - (Number(a.row.updatedAt) || 0) || (Number(b.row.id) || 0) - (Number(a.row.id) || 0));
    const selected = [];
    let chars = 0;
    for (const { row } of ranked) {
        const line = `- #${row.id} ${row.content}${row.topic ? `（适用：${row.topic}）` : ''}`;
        if (chars + line.length + 1 > PROMPT_CHARS && selected.length) break;
        selected.push(row);
        chars += line.length + 1;
    }
    return selected;
}
