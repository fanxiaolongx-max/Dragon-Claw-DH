// 长期记忆：每个用户一份，保存“以后都这样做”的偏好与约定，跨对话有效，并按主题相关性注入提示词。
import { BusinessError } from '../core/errors.js';
import { kvGet, modifyMemoryList } from '../dao/scoped.js';
import { redactText } from '../agent/redact.js';
import { terms, topicScore } from '../agent/topic-context.js';

export const MAX_ITEMS = 100;
const MAX_CHARS = 500;
const MAX_TOPIC_CHARS = 100;
const PROMPT_CHARS = 4000;
const keyOf = (username) => `agent_memory:${String(username || 'anonymous').toLowerCase()}`;
// 凭据不进记忆：记忆会进系统提示，也会被同平台其他应用读到

export async function listMemories(username) {
    const list = await kvGet(keyOf(username), []);
    return Array.isArray(list) ? list : list?.items || [];
}

function cleanText(value, secrets = []) {
    return redactText(String(value || '').replace(/\s+/g, ' ').trim(), { secrets });
}

function validateContent(value, secrets = []) {
    const text = cleanText(value, secrets);
    if (!text) throw new BusinessError('记忆内容不能为空');
    if (text.length > MAX_CHARS) throw new BusinessError(`记忆内容最多 ${MAX_CHARS} 字，请精简成一句话`);
    return text;
}

function cleanTopic(value, secrets = []) {
    if (!value) return '';
    const topic = cleanText(value, secrets);
    if (topic.length > MAX_TOPIC_CHARS) throw new BusinessError(`适用主题最多 ${MAX_TOPIC_CHARS} 字`);
    return topic;
}

function nextTrace(previous, source, isUpdate) {
    const version = (previous?.version || (isUpdate ? 1 : 0)) + 1;
    const entry = { version };
    if (source?.sessionId && source?.messageId) {
        entry.sessionId = source.sessionId;
        entry.messageId = source.messageId;
    }
    return { version, entries: [...(previous?.entries || []), entry].slice(-8) };
}

function temporaryOnly(text = '') {
    return /不(?:要|用)?(?:存入|保存|记入|更新|修改)(?:到)?长期记忆/.test(text)
        || (/(?:仅限|仅|只限|只在|只对)?(?:这期|本期|这次|本次|本轮|这一期).{0,12}(?:不要|不用|不加|例外|临时)|仅(?:本次|这次|本轮)|this (?:time|issue) only/i.test(text)
            && !/以后|从今|今后|永久|从现在起|from now on/i.test(text));
}

const publicItem = ({trace, ...item}) => item;

async function describeSource(username, trace, ctx) {
    const {sessionAccess} = await import('./share-service.js');
    if (ctx.isShared || (ctx.sessionId && (await sessionAccess(ctx.sessionId, username))?.share?.status === 'active')) {
        return '请在个人对话查看记忆出处。';
    }
    if (!trace?.entries?.length) return '旧记忆未记录来源。';
    const {listMessages} = await import('./ai-service.js');
    const versions = [];
    for (const entry of trace.entries) {
        let source = '未记录来源';
        if (entry.sessionId && entry.messageId) {
            const access = await sessionAccess(entry.sessionId, username);
            const message = access && (await listMessages(entry.sessionId)).find(row => row.role === 'user'
                && row.memoryTurn === entry.messageId && String(row.author || '').toLowerCase() === username.toLowerCase());
            source = message ? {sessionId:entry.sessionId, messageId:message.id, time:message.created_at,
                quote:redactText(message.content, {secrets:ctx.secrets || []}).slice(0,300)} : '来源已删除或不可访问';
        }
        versions.push({version:entry.version, current:entry.version === trace.version, source});
    }
    return {version:trace.version, recordedChanges:trace.version - 1, note:'首次创建不计为修改', versions};
}

export async function changeMemory(username, { action, id, content, topic, secrets = [] } = {}, ctx = {}) {
    if (action === 'list' || action === 'source') {
        const list = await listMemories(username);
        if (action === 'list') return { items:list.map(publicItem) };
        const target = list.find(item => Number(item.id) === Number(id));
        if (!target) throw new BusinessError(`没有编号为 ${id} 的记忆`);
        return {source:await describeSource(username, target.trace, {...ctx,secrets})};
    }
    if (['add','update'].includes(action) && temporaryOnly(ctx.currentUserMessage)) return {temporary:true};
    return modifyMemoryList(keyOf(username), state => {
        const list = state.items;
        const target = list.find(item => Number(item.id) === Number(id));
        if (action === 'delete') {
            if (!target) throw new BusinessError(`没有编号为 ${id} 的记忆`);
            state.lastId = Math.max(state.lastId, ...list.map(item=>Number(item.id)));
            state.items = list.filter(item => item !== target);
            return {changed:true, result:{deleted:target.id}};
        }
        if (action !== 'add' && action !== 'update') throw new BusinessError('未知记忆操作');
        if (action === 'update' && !target) throw new BusinessError(`没有编号为 ${id} 的记忆`);
        const text = validateContent(content, secrets);
        const scope = cleanTopic(topic ?? (action === 'update' ? target.topic : ''), secrets);
        const same = action === 'update' ? target : list.find(item=>item.content === text && (item.topic || '') === scope);
        if (same && same.content === text && (same.topic || '') === scope) return {changed:false,result:{item:publicItem(same),deduplicated:true}};
        let item = target;
        if (action === 'add') {
            if (list.length >= MAX_ITEMS) throw new BusinessError(`记忆已满（${MAX_ITEMS} 条），请先合并或删除不再需要的`);
            state.lastId = Math.max(state.lastId, ...list.map(row => Number(row.id))) + 1;
            item = {id:state.lastId};
            list.push(item);
        }
        Object.assign(item, {content:text, updatedAt:Date.now(), trace:nextTrace(item.trace,ctx.memorySource,action === 'update')});
        if (scope) item.topic = scope;
        else delete item.topic;
        return {changed:true, result:{item:publicItem(item)}};
    });
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
