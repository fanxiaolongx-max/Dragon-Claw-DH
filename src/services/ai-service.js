import crypto from 'node:crypto';
import { config } from '../config.js';
import { BusinessError } from '../core/errors.js';
import { Agent, fetch as undiciFetch } from 'undici';
import { encryptSecret, decryptSecret } from '../core/secrets.js';
import { kvGet, kvSet, selectTable, insertRow, upsertRow, updateRows, deleteRows, sqlVal, parseJsonCol } from '../dao/scoped.js';
import { pushLog } from '../core/log-ring.js';

const aiAgent = new Agent({
    connect: { rejectUnauthorized: false, timeout: 20_000 },
    keepAliveTimeout: 10_000,
});

const CONVERSATION_LIST_KEY_PREFIX = 'ai_conversation_list:';
const USAGE_KEY = 'ai_usage_stats';
const DEFAULT_PROFILE_ID = 'default-profile';

const DEFAULT_MODEL_SETTINGS = {
    id: DEFAULT_PROFILE_ID,
    name: '默认模型',
    provider: 'openai',
    anthropicAuthType: 'ANTHROPIC_AUTH_TOKEN',
    apiBaseUrl: config.aiApiBaseUrl,
    model: config.aiModel || 'gpt-4o-mini',
    apiKey: config.aiApiKey,
    maxOutputTokens: 4096,
    contextWindowTokens: 64000,
    temperature: 0.7,
    inputCostPerMillionUsd: 0.15,
    outputCostPerMillionUsd: 0.6,
    usdToCny: 7.2,
    systemPrompt: '',
    headers: {},
    extraBody: {},
    isActive: true,
};

function maskSecret(val) {
    const s = String(val || '').trim();
    if (!s) return '';
    if (s.length <= 8) return '***';
    return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

function normalizeProfile(raw = {}) {
    return {
        ...DEFAULT_MODEL_SETTINGS,
        ...raw,
        id: String(raw.id || crypto.randomUUID()),
        name: String(raw.name || raw.model || '模型配置').trim(),
        provider: String(raw.provider || 'openai').trim().toLowerCase(),
        apiBaseUrl: String(raw.apiBaseUrl || raw.baseUrl || '').trim().replace(/\/+$/, ''),
        model: String(raw.model || 'gpt-4o-mini').trim(),
        maxOutputTokens: Number(raw.maxOutputTokens) || 2048,
        contextWindowTokens: Number(raw.contextWindowTokens) || 64000,
        temperature: Number.isFinite(Number(raw.temperature)) ? Number(raw.temperature) : 0.7,
        headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : {},
        extraBody: raw.extraBody && typeof raw.extraBody === 'object' ? raw.extraBody : {},
        isActive: Boolean(raw.isActive ?? raw.activate),
    };
}

function publicProfile(profile) {
    const p = normalizeProfile(profile);
    return {
        ...p,
        apiKey: '',
        hasApiKey: Boolean(p.apiKey),
        apiKeyMasked: maskSecret(p.apiKey),
        keyLooksValid: Boolean(p.apiKey && p.apiKey.length >= 6),
    };
}

function decryptProfile(raw) {
    return raw && raw.apiKey ? { ...raw, apiKey: decryptSecret(raw.apiKey) } : (raw || {});
}

export async function listProfiles() {
    const rows = await selectTable('ai_settings_profiles', {
        orderBySql: '`is_active` DESC, `updated_at` DESC',
        limit: 100,
        memSort: (a, b) => (Number(b.is_active || 0) - Number(a.is_active || 0)) || ((b.updated_at || 0) - (a.updated_at || 0)),
    });
    if (!rows.length) {
        const def = normalizeProfile(DEFAULT_MODEL_SETTINGS);
        return [def];
    }
    return rows.map((r) => normalizeProfile({ ...decryptProfile(parseJsonCol(r.config_json, {})), id: r.id, name: r.name, provider: r.provider, isActive: Boolean(r.is_active) }));
}

export async function getActiveSettings() {
    const profiles = await listProfiles();
    const active = profiles.find((p) => p.isActive) || profiles[0];
    return normalizeProfile(active);
}

export async function getPublicSettings() {
    const profiles = await listProfiles();
    const active = profiles.find((p) => p.isActive) || profiles[0];
    return {
        ...publicProfile(active),
        activeProfileId: active.id,
        profiles: profiles.map(publicProfile),
        modelAliases: (await kvGet('ai_model_aliases', {})) || {},
        autoSwitchEnabled: await getAutoSwitch(),
    };
}

// 主模型异常时自动切换到其他方案（全局开关，设置页「AI 助手」里）
export async function getAutoSwitch() {
    return Boolean(await kvGet('ai_auto_switch', false));
}

export async function saveProfile(input = {}, idOverride = '') {
    if (typeof input.autoSwitchEnabled === 'boolean') {
        await kvSet('ai_auto_switch', input.autoSwitchEnabled);
        // 只改开关（锁定方案时前端只发这一项）：不动方案本身
        if (Object.keys(input).every((k) => ['autoSwitchEnabled', 'profileId'].includes(k))) return getPublicSettings();
    }
    const existingList = await listProfiles();
    const targetId = String(idOverride || input.id || '').trim() || `profile-${crypto.randomUUID().slice(0, 8)}`;
    const existing = existingList.find((p) => p.id === targetId);
    const keepKey = !input.apiKey && existing ? existing.apiKey : (input.apiKey || '');
    const activeInput = input.isActive !== undefined ? input.isActive : input.activate;
    const merged = normalizeProfile({
        ...(existing || {}),
        ...input,
        id: targetId,
        apiKey: keepKey === '***' && existing ? existing.apiKey : keepKey,
        isActive: activeInput !== undefined ? Boolean(activeInput) : (existing ? existing.isActive : existingList.every((x) => !x.isActive || x.id === DEFAULT_PROFILE_ID)),
    });
    const now = Date.now();
    await upsertRow('ai_settings_profiles', {
        id: merged.id,
        name: merged.name,
        provider: merged.provider,
        is_active: merged.isActive ? 1 : 0,
        config_json: JSON.stringify({ ...merged, apiKey: encryptSecret(merged.apiKey) }),
        created_at: existing?.createdAt || now,
        updated_at: now,
    }, ['id']);
    if (merged.isActive) {
        await activateProfile(merged.id);
    }
    return getPublicSettings();
}

export async function activateProfile(profileId) {
    const profiles = await listProfiles();
    for (const p of profiles) {
        const active = p.id === profileId;
        await upsertRow('ai_settings_profiles', {
            id: p.id,
            name: p.name,
            provider: p.provider,
            is_active: active ? 1 : 0,
            config_json: JSON.stringify({ ...p, isActive: active, apiKey: encryptSecret(p.apiKey) }),
            created_at: p.createdAt || Date.now(),
            updated_at: Date.now(),
        }, ['id']);
    }
    return getPublicSettings();
}

export async function deleteProfile(profileId) {
    await deleteRows('ai_settings_profiles', {
        whereSql: `\`id\` = ${sqlVal(profileId)}`,
        memFilter: (r) => r.id === profileId,
    });
    return getPublicSettings();
}

// 累计用量（读改写，非原子：并发下可能少记几次，只用于展示趋势）
export async function addUsage({ inputTokens = 0, outputTokens = 0 } = {}) {
    try {
        const cur = await getUsage();
        await kvSet(USAGE_KEY, {
            ...cur,
            promptTokens: Number(cur.promptTokens || 0) + Number(inputTokens || 0),
            completionTokens: Number(cur.completionTokens || 0) + Number(outputTokens || 0),
            requests: Number(cur.requests || 0) + 1,
        });
    } catch { /* 用量统计失败不影响对话 */ }
}

export async function getUsage() {
    return (await kvGet(USAGE_KEY, { promptTokens: 0, completionTokens: 0, totalCostUsd: 0, requests: 0 })) || {};
}

export async function clearUsage() {
    return kvSet(USAGE_KEY, { promptTokens: 0, completionTokens: 0, totalCostUsd: 0, requests: 0 });
}

export function buildCompletionRequest(settings, messages, { stream = false, maxTokens } = {}) {
    const provider = settings.provider || 'openai';
    const base = settings.apiBaseUrl || (provider === 'anthropic' ? 'https://api.anthropic.com' : provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai' : 'https://api.openai.com/v1');
    const outTokens = Number(maxTokens) || Number(settings.maxOutputTokens) || 2048;

    if (provider === 'anthropic') {
        const url = base.endsWith('/v1/messages') ? base : `${base.replace(/\/v1$/, '')}/v1/messages`;
        const sysMsg = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
        const userMsgs = messages.filter((m) => m.role !== 'system').map((m) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: String(m.content || ''),
        }));
        const headers = {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            ...settings.headers,
        };
        if (settings.anthropicAuthType === 'x-api-key') headers['x-api-key'] = settings.apiKey;
        else headers.Authorization = `Bearer ${settings.apiKey}`;
        return {
            provider,
            url,
            headers,
            body: {
                ...(settings.extraBody || {}),
                model: settings.model,
                max_tokens: outTokens,
                temperature: settings.temperature,
                system: sysMsg || undefined,
                messages: userMsgs,
                stream,
            },
        };
    }

    const url = /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
    return {
        provider,
        url,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${settings.apiKey}`,
            ...settings.headers,
        },
        body: {
            ...(settings.extraBody || {}),
            model: settings.model,
            max_tokens: outTokens,
            temperature: settings.temperature,
            messages,
            stream,
        },
    };
}

export async function callAiCompletion({ messages, profileId = '', maxTokens } = {}) {
    const profiles = await listProfiles();
    const settings = (profileId ? profiles.find((p) => p.id === profileId) : null) || await getActiveSettings();
    if (!settings.apiKey) {
        return {
            ok: false,
            text: '',
            error: '未配置 API Key，请在左下角头像 →「全局设置」→「AI 助手」中配置模型网关和密钥。',
            model: settings.model,
        };
    }

    const reqSpec = buildCompletionRequest(settings, messages, { stream: false, maxTokens });
    const started = Date.now();
    try {
        const resp = await undiciFetch(reqSpec.url, {
            method: 'POST',
            headers: reqSpec.headers,
            body: JSON.stringify(reqSpec.body),
            dispatcher: aiAgent,
            signal: AbortSignal.timeout(60_000),
        });
        const raw = await resp.text();
        let data;
        try { data = JSON.parse(raw); } catch { data = null; }
        if (!resp.ok) {
            return {
                ok: false,
                status: resp.status,
                error: data?.error?.message || data?.message || `模型接口 HTTP ${resp.status}: ${raw.slice(0, 200)}`,
                model: settings.model,
            };
        }
        const text = reqSpec.provider === 'anthropic'
            ? (Array.isArray(data?.content) ? data.content.map((c) => c.text || '').join('') : '')
            : (data?.choices?.[0]?.message?.content ?? '');

        const usage = data?.usage || {};
        pushLog({
            level: 'INFO',
            category: 'AI',
            durationMs: Date.now() - started,
            message: `completion model=${settings.model} provider=${reqSpec.provider}`,
            detail: { promptTokens: usage.prompt_tokens || usage.input_tokens || 0, completionTokens: usage.completion_tokens || usage.output_tokens || 0 },
        });
        return { ok: true, text, usage, model: settings.model, latencyMs: Date.now() - started };
    } catch (error) {
        return { ok: false, error: error.message || '模型请求失败', model: settings.model };
    }
}

export async function streamAiChat({ messages, profileId = '', onDelta }) {
    const profiles = await listProfiles();
    const settings = (profileId ? profiles.find((p) => p.id === profileId) : null) || await getActiveSettings();
    if (!settings.apiKey) {
        throw new BusinessError('未配置可用的 AI 模型 API Key：请先点击左下角头像 →「全局设置」→「AI 助手」配置模型网关与 Token，或在无模型配置时体验系统内置诊断回复。');
    }

    const reqSpec = buildCompletionRequest(settings, messages, { stream: true });
    const resp = await undiciFetch(reqSpec.url, {
        method: 'POST',
        headers: reqSpec.headers,
        body: JSON.stringify(reqSpec.body),
        dispatcher: aiAgent,
        signal: AbortSignal.timeout(90_000),
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new BusinessError(`模型服务 HTTP ${resp.status}: ${text.slice(0, 240)}`, 502);
    }

    let fullText = '';
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of resp.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
                const json = JSON.parse(payload);
                const delta = reqSpec.provider === 'anthropic'
                    ? (json.delta?.text || '')
                    : (json.choices?.[0]?.delta?.content || '');
                if (delta) {
                    fullText += delta;
                    await onDelta(delta);
                }
            } catch { /* ignore partial SSE keepalive */ }
        }
    }
    return { text: fullText, model: settings.model };
}

export async function listSessions({ ownerId = 'default', archived = false, query = '', limit = 50 } = {}) {
    const rows = await selectTable('ai_chat_sessions', {
        whereSql: `\`owner_id\` = ${sqlVal(ownerId)} AND \`archived\` = ${archived ? 1 : 0}`,
        orderBySql: '`pinned` DESC, `updated_at` DESC',
        limit: Number(limit) || 50,
        memFilter: (r) => r.owner_id === ownerId && Number(r.archived || 0) === (archived ? 1 : 0),
        memSort: (a, b) => (Number(b.pinned || 0) - Number(a.pinned || 0)) || ((b.updated_at || 0) - (a.updated_at || 0)),
    });
    const q = String(query || '').trim().toLowerCase();
    const mapped = rows.map((r) => ({
        id: r.id,
        owner: r.owner_id,
        title: r.title,
        archived: Boolean(r.archived),
        pinned: Boolean(r.pinned),
        summary: r.summary || '',
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        ...(parseJsonCol(r.metadata_json, {}) || {}),
    }));
    return q ? mapped.filter((s) => `${s.title} ${s.summary}`.toLowerCase().includes(q)) : mapped;
}

export async function getSession(sessionId) {
    const rows = await selectTable('ai_chat_sessions', {
        whereSql: `\`id\` = ${sqlVal(sessionId)}`,
        limit: 1,
        memFilter: (r) => r.id === sessionId,
    });
    if (!rows.length) return null;
    const r = rows[0];
    return {
        id: r.id,
        owner: r.owner_id,
        title: r.title,
        archived: Boolean(r.archived),
        pinned: Boolean(r.pinned),
        summary: r.summary || '',
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        metadata: parseJsonCol(r.metadata_json, {}),
    };
}

export async function saveSession({ id, ownerId = 'default', title = '新对话', summary = '', archived = false, pinned = false, metadata = {} }) {
    const sid = String(id || `chat_${crypto.randomUUID().slice(0, 12)}`);
    const existing = await getSession(sid);
    const now = Date.now();
    await upsertRow('ai_chat_sessions', {
        id: sid,
        owner_id: existing?.owner || ownerId,
        title: String(title || existing?.title || '新对话').slice(0, 400),
        archived: archived ? 1 : 0,
        pinned: pinned ? 1 : 0,
        summary: String(summary || existing?.summary || ''),
        metadata_json: JSON.stringify({ ...(existing?.metadata || {}), ...(metadata || {}) }),
        created_at: existing?.createdAt || now,
        updated_at: now,
    }, ['id'], ['title', 'archived', 'pinned', 'summary', 'metadata_json', 'updated_at']);
    return getSession(sid);
}

export async function setSessionArchived(sessionId, archived) {
    const existing = await getSession(sessionId);
    if (!existing) return null;
    await updateRows('ai_chat_sessions', { archived: archived ? 1 : 0, updated_at: Date.now() }, {
        whereSql: `\`id\` = ${sqlVal(sessionId)}`,
        memFilter: (r) => r.id === sessionId,
    });
    return getSession(sessionId);
}

export async function deleteSession(sessionId) {
    const existing = await getSession(sessionId);
    if (!existing) return false;
    await deleteRows('ai_chat_messages', {
        whereSql: `\`session_id\` = ${sqlVal(sessionId)}`,
        memFilter: (r) => r.session_id === sessionId,
    });
    await deleteRows('ai_chat_sessions', {
        whereSql: `\`id\` = ${sqlVal(sessionId)}`,
        memFilter: (r) => r.id === sessionId,
    });
    return true;
}

export async function listMessages(sessionId) {
    const rows = await selectTable('ai_chat_messages', {
        whereSql: `\`session_id\` = ${sqlVal(sessionId)}`,
        orderBySql: '`id` ASC',
        limit: 500,
        memFilter: (r) => r.session_id === sessionId,
        memSort: (a, b) => (a.id || 0) - (b.id || 0),
    });
    return rows.map((r) => ({
        id: r.id,
        session_id: r.session_id,
        role: r.role,
        content: r.content || '',
        created_at: r.created_at,
        ...(parseJsonCol(r.meta_json, {}) || {}),
    }));
}

export async function appendMessage(sessionId, role, content, meta = {}) {
    await insertRow('ai_chat_messages', {
        session_id: String(sessionId),
        role: String(role),
        content: String(content || ''),
        meta_json: JSON.stringify(meta || {}),
        created_at: Date.now(),
    });
}

export async function getConversationList(ownerId) {
    return (await kvGet(`${CONVERSATION_LIST_KEY_PREFIX}${ownerId}`, [])) || [];
}

export async function saveConversationList(ownerId, item) {
    const list = await getConversationList(ownerId);
    const id = String(item?.id || `item_${Date.now()}`);
    const next = [...list.filter((x) => x.id !== id), { ...item, id, updatedAt: Date.now() }];
    await kvSet(`${CONVERSATION_LIST_KEY_PREFIX}${ownerId}`, next);
    return item;
}
