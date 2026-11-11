// 长期记忆：每个用户一份，保存“以后都这样做”的偏好与约定，跨对话有效。
import { BusinessError } from '../core/errors.js';
import { kvGet, kvSet } from '../dao/scoped.js';

const MAX_ITEMS = 30;
const MAX_CHARS = 300;
const keyOf = (username) => `agent_memory:${String(username || 'anonymous').toLowerCase()}`;
// 凭据不进记忆：记忆会进系统提示，也会被同平台其他应用读到
const SECRET_RE = /(password|passwd|密码|口令|secret|token|api[_-]?key|密钥)\s*[:：=是为]\s*\S{4,}/i;

export async function listMemories(username) {
    const list = await kvGet(keyOf(username), []);
    return Array.isArray(list) ? list : [];
}

export async function changeMemory(username, { action, id, content } = {}) {
    const list = await listMemories(username);
    const text = String(content || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
    if (action === 'list') return { items: list };
    if (action === 'add') {
        if (!text) throw new BusinessError('记忆内容不能为空');
        if (SECRET_RE.test(text)) throw new BusinessError('不能把密码、密钥这类凭据存进记忆');
        if (list.length >= MAX_ITEMS) throw new BusinessError(`记忆已满（${MAX_ITEMS} 条），请先删除不再需要的`);
        const item = { id: list.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1, content: text, updatedAt: Date.now() };
        await kvSet(keyOf(username), [...list, item]);
        return { item };
    }
    const target = list.find((x) => Number(x.id) === Number(id));
    if (!target) throw new BusinessError(`没有编号为 ${id} 的记忆`);
    if (action === 'update') {
        if (!text) throw new BusinessError('记忆内容不能为空');
        if (SECRET_RE.test(text)) throw new BusinessError('不能把密码、密钥这类凭据存进记忆');
        Object.assign(target, { content: text, updatedAt: Date.now() });
        await kvSet(keyOf(username), list);
        return { item: target };
    }
    if (action === 'delete') {
        await kvSet(keyOf(username), list.filter((x) => x !== target));
        return { deleted: target.id };
    }
    throw new BusinessError('action 只能是 add / update / delete / list');
}
