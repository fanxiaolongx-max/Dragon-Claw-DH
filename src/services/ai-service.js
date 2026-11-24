import crypto from 'node:crypto';
import { stripReasoningText, reasoningDelta } from '../agent/reasoning.js';
import { config } from '../config.js';
import { BusinessError } from '../core/errors.js';
import { Agent, fetch as undiciFetch } from 'undici';
import { encryptSecret, decryptSecret } from '../core/secrets.js';
import { kvGet, kvSet, selectTable, insertRow, upsertRow, updateRows, deleteRows, sqlVal, parseJsonCol } from '../dao/scoped.js';
import { pushLog } from '../core/log-ring.js';

// 模型方案的「校验 HTTPS 证书」开关：默认不校验（兼容内网自签证书网关），勾选后严格校验
const aiAgent = new Agent({ connect: { rejectUnauthorized: false, timeout: 20_000 }, keepAliveTimeout: 10_000 });
const aiStrictAgent = new Agent({ connect: { rejectUnauthorized: true, timeout: 20_000 }, keepAliveTimeout: 10_000 });
export const aiDispatcherFor = (settings) => (settings?.verifySsl === true ? aiStrictAgent : aiAgent);

const CONVERSATION_LIST_KEY_PREFIX = 'ai_conversation_list:';
const DEFAULT_PROFILE_ID = 'default-profile';
export const IMAGE_TEST_MODEL_RE = /(?:^|[/:_-])(imagen|dall-e|gpt-image|qwen-image|flux|sdxl|stable-diffusion|midjourney|kling|cogview|kolors)(?:[/:_-]|$)|image-generation/i;

export function resolveProfileCategory(raw = {}) {
    const explicit = String(raw.category || '').trim().toLowerCase();
    if (explicit === 'image' || explicit === 'chat') return explicit;
    if (IMAGE_TEST_MODEL_RE.test(String(raw.model || ''))) return 'image';
    return 'chat';
}

const DEFAULT_MODEL_SETTINGS = {
    id: DEFAULT_PROFILE_ID,
    name: '默认模型',
    category: 'chat',
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

// 认证方式（与主线版一致）：内网网关常用 api-key、X-API-Key 等请求头，或不需要认证
export const VALID_AUTH_MODES = ['bearer', 'x-api-key', 'api-key', 'x-goog-api-key', 'none', 'custom'];
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;

/** 方案的认证方式：显式选择优先；旧的 Anthropic「API Key」选项按 x-api-key；其余默认 Bearer */
export function resolveAuthMode(settings = {}) {
    const raw = String(settings.authMode || '').trim().toLowerCase();
    if (VALID_AUTH_MODES.includes(raw)) return raw;
    const provider = String(settings.provider || '').toLowerCase();
    if (provider === 'anthropic' && ['ANTHROPIC_API_KEY', 'x-api-key'].includes(String(settings.anthropicAuthType || ''))) return 'x-api-key';
    return 'bearer';
}

/** 按认证方式生成请求头；none 不带密钥，custom 用方案里填的请求头名 */
export function authHeaders(settings = {}) {
    const key = settings.apiKey || '';
    const mode = resolveAuthMode(settings);
    if (mode === 'none' || !key) return {};
    if (mode === 'x-api-key') return { 'x-api-key': key };
    if (mode === 'api-key') return { 'api-key': key };
    if (mode === 'x-goog-api-key') return { 'x-goog-api-key': key };
    if (mode === 'custom' && HEADER_NAME_RE.test(String(settings.customAuthHeader || '').trim())) return { [String(settings.customAuthHeader).trim()]: key };
    return { Authorization: `Bearer ${key}` };
}

/** 能否发请求：选了「不需要认证」时不要求密钥 */
export const hasUsableCredentials = (settings = {}) => Boolean(settings.apiKey) || resolveAuthMode(settings) === 'none';

function maskSecret(val) {
    const s = String(val || '').trim();
    if (!s) return '';
    if (s.length <= 8) return '***';
    return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

export function normalizeProfile(raw = {}) {
    return {
        ...DEFAULT_MODEL_SETTINGS,
        ...raw,
        id: String(raw.id || crypto.randomUUID()),
        name: String(raw.name || raw.model || '模型配置').trim(),
        category: resolveProfileCategory(raw),
        provider: String(raw.provider || 'openai').trim().toLowerCase(),
        apiBaseUrl: String(raw.apiBaseUrl || raw.baseUrl || '').trim().replace(/\/+$/, ''),
        model: String(raw.model || 'gpt-4o-mini').trim(),
        maxOutputTokens: Number(raw.maxOutputTokens) || 2048,
        contextWindowTokens: Number(raw.contextWindowTokens) || 64000,
        temperature: Number.isFinite(Number(raw.temperature)) ? Number(raw.temperature) : 0.7,
        headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : {},
        extraBody: raw.extraBody && typeof raw.extraBody === 'object' ? raw.extraBody : {},
        isActive: Boolean(raw.isActive ?? raw.activate),
        authMode: resolveAuthMode(raw),
        customAuthHeader: HEADER_NAME_RE.test(String(raw.customAuthHeader || '').trim()) ? String(raw.customAuthHeader).trim() : '',
        // 默认不校验 HTTPS 证书（与主线版一致），只有明确勾选才校验
        verifySsl: raw.verifySsl === true || raw.verifySsl === 'true',
    };
}

function publicProfile(profile, sourceHint = '') {
    const p = normalizeProfile(profile);
    const masked = maskSecret(p.apiKey);
    return {
        ...p,
        apiKey: '',
        hasApiKey: Boolean(p.apiKey),
        apiKeyMasked: masked,
        maskedApiKey: masked,
        apiKeySource: p.apiKey ? (p.apiKeySource || sourceHint || 'stored') : 'none',
        hasHeaders: Object.keys(p.headers || {}).length > 0,
        hasExtraBody: Object.keys(p.extraBody || {}).length > 0,
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
        const def = normalizeProfile({
            ...DEFAULT_MODEL_SETTINGS,
            apiKeySource: DEFAULT_MODEL_SETTINGS.apiKey ? 'env' : 'none',
        });
        return [def];
    }
    return rows.map((r) => {
        const decrypted = decryptProfile(parseJsonCol(r.config_json, {}));
        return normalizeProfile({
            ...decrypted,
            id: r.id,
            name: r.name,
            provider: r.provider,
            apiKeySource: decrypted?.apiKey ? (decrypted.apiKeySource || 'stored') : 'none',
            isActive: Boolean(r.is_active),
        });
    });
}

export async function getActiveSettings() {
    const profiles = await listProfiles();
    const active = profiles.find((p) => p.isActive && (p.category || 'chat') !== 'image') || profiles.find((p) => p.isActive) || profiles[0];
    return normalizeProfile(active);
}

export async function getPublicSettings() {
    const profiles = await listProfiles();
    const chatProfiles = profiles.filter((p) => (p.category || 'chat') !== 'image');
    const imageProfiles = profiles.filter((p) => (p.category || 'chat') === 'image');
    const active = chatProfiles.find((p) => p.isActive) || profiles.find((p) => p.isActive) || profiles[0];
    const activeImage = imageProfiles.find((p) => p.isActive) || imageProfiles[0] || null;
    return {
        ...publicProfile(active),
        activeProfileId: active.id,
        activeImageProfileId: activeImage?.id || '',
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
    const sourceProfile = !existing && input.sourceProfileId
        ? existingList.find((p) => p.id === String(input.sourceProfileId).trim())
        : null;
    const baseProfile = existing || sourceProfile || null;
    let keepKey = !input.apiKey && baseProfile ? baseProfile.apiKey : (input.apiKey || '');
    if (input.clearApiKey) keepKey = '';
    const activeInput = input.isActive !== undefined ? input.isActive : input.activate;
    const targetCategory = resolveProfileCategory({ ...(baseProfile || {}), ...input });
    const merged = normalizeProfile({
        ...(baseProfile || {}),
        ...input,
        category: targetCategory,
        id: targetId,
        apiKey: keepKey === '***' && baseProfile ? baseProfile.apiKey : keepKey,
        apiKeySource: keepKey ? 'stored' : 'none',
        isActive: activeInput !== undefined ? Boolean(activeInput) : (existing ? existing.isActive : (sourceProfile ? false : existingList.filter((x) => (x.category || 'chat') === targetCategory).every((x) => !x.isActive || x.id === DEFAULT_PROFILE_ID))),
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
        for (const p of existingList) {
            if (p.id === merged.id || !p.isActive || (p.category || 'chat') !== (merged.category || 'chat')) continue;
            await upsertRow('ai_settings_profiles', {
                id: p.id,
                name: p.name,
                provider: p.provider,
                is_active: 0,
                config_json: JSON.stringify({ ...p, isActive: false, apiKey: encryptSecret(p.apiKey) }),
                created_at: p.createdAt || now,
                updated_at: now,
            }, ['id']);
        }
    }
    return { ...(await getPublicSettings()), createdProfileId: merged.id };
}

export async function activateProfile(profileId) {
    const profiles = await listProfiles();
    const target = profiles.find((p) => p.id === profileId);
    if (!target) return getPublicSettings();
    const targetCategory = target.category || 'chat';
    for (const p of profiles) {
        if ((p.category || 'chat') !== targetCategory) continue;
        const active = p.id === profileId;
        if (Boolean(p.isActive) === active) continue;
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

export { addUsage, getUsage, clearUsage } from './usage-service.js';

export function buildCompletionRequest(settings, messages, { stream = false, maxTokens, temperature } = {}) {
    const provider = settings.provider || 'openai';
    const base = settings.apiBaseUrl || (provider === 'anthropic' ? 'https://api.anthropic.com' : provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai' : 'https://api.openai.com/v1');
    const outTokens = Number(maxTokens) || Number(settings.maxOutputTokens) || 2048;
    const temp = Number.isFinite(Number(temperature)) ? Number(temperature) : settings.temperature;

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
        Object.assign(headers, authHeaders(settings), settings.headers || {});
        return {
            provider,
            url,
            headers,
            body: {
                ...(settings.extraBody || {}),
                model: settings.model,
                max_tokens: outTokens,
                temperature: temp,
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
            ...authHeaders(settings),
            ...settings.headers,
        },
        body: {
            ...(settings.extraBody || {}),
            model: settings.model,
            max_tokens: outTokens,
            temperature: temp,
            messages,
            stream,
        },
    };
}

export async function callAiCompletion({ messages, profileId = '', model = '', maxTokens, temperature, timeoutMs = 90_000, overrideSettings = null } = {}) {
    const profiles = overrideSettings ? [] : await listProfiles();
    const baseSettings = overrideSettings || (profileId ? profiles.find((p) => p.id === profileId) : null) || await getActiveSettings();
    const modelOverride = String(model || '').trim();
    const settings = modelOverride ? { ...baseSettings, model: modelOverride } : baseSettings;
    const provider = settings.provider || 'openai';
    if (!hasUsableCredentials(settings)) {
        return {
            ok: false,
            text: '',
            error: '未配置 API Key，请在左下角头像 →「全局设置」→「AI 助手」中配置模型网关和密钥。',
            model: settings.model,
            provider,
            latencyMs: 0,
        };
    }

    const reqSpec = buildCompletionRequest(settings, messages, { stream: false, maxTokens, temperature });
    const started = Date.now();
    const clampedTimeout = Math.max(1000, Math.min(300_000, Number(timeoutMs) || 90_000));
    try {
        const resp = await undiciFetch(reqSpec.url, {
            method: 'POST',
            headers: reqSpec.headers,
            body: JSON.stringify(reqSpec.body),
            dispatcher: aiDispatcherFor(settings),
            signal: AbortSignal.timeout(clampedTimeout),
        });
        const raw = await resp.text();
        let data;
        try { data = JSON.parse(raw); } catch { data = null; }
        if (/<!doctype|<html/i.test(raw)) {
            const preview = raw.replace(/\s+/g, ' ').slice(0, 220);
            return {
                ok: false,
                status: resp.status,
                error: `模型接口返回了 HTML 页面（HTTP ${resp.status}），并非标准 API。请检查 API URL 与供应商配置。返回片段：${preview}`,
                model: settings.model,
                provider: reqSpec.provider,
                latencyMs: Date.now() - started,
                diagnostics: { endpoint: reqSpec.url, upstreamStatus: resp.status, upstreamStatusText: resp.statusText || '', contentType: resp.headers.get('content-type') || '', rawBody: raw.slice(0, 4000), providerMessage: 'HTML response' },
            };
        }
        if (!resp.ok) {
            const nested = data?.error && typeof data.error === 'object' ? data.error : null;
            const message = String(nested?.message || nested?.msg || data?.message || data?.msg || data?.detail || (typeof data?.error === 'string' ? data.error : '') || `模型接口 HTTP ${resp.status}: ${raw.slice(0, 200)}`).trim();
            const code = String(nested?.code ?? nested?.type ?? data?.code ?? data?.type ?? '').trim();
            return {
                ok: false,
                status: resp.status,
                error: message,
                model: settings.model,
                provider: reqSpec.provider,
                latencyMs: Date.now() - started,
                // 测试连接用的诊断信息（返回前由路由脱敏）
                diagnostics: { endpoint: reqSpec.url, upstreamStatus: resp.status, upstreamStatusText: resp.statusText || '', contentType: resp.headers.get('content-type') || '', rawBody: raw.slice(0, 4000), providerMessage: message, providerCode: code },
            };
        }
        if (data && (data.error || Number(data.code) >= 400 || Number(data.status) >= 400 || (data.base_resp && Number(data.base_resp?.status_code) > 0))) {
            const nested = data?.error && typeof data.error === 'object' ? data.error : null;
            const message = String(nested?.message || nested?.msg || data?.message || data?.msg || data?.base_resp?.status_message || '网关非标准报错').trim();
            return {
                ok: false,
                status: Number(data.code) || Number(data.status) || 502,
                error: `网关返回错误：${message}`,
                model: settings.model,
                provider: reqSpec.provider,
                latencyMs: Date.now() - started,
                diagnostics: { endpoint: reqSpec.url, upstreamStatus: resp.status, upstreamStatusText: resp.statusText || '', contentType: resp.headers.get('content-type') || '', rawBody: raw.slice(0, 4000), providerMessage: message },
            };
        }
        const rawContent = reqSpec.provider === 'anthropic'
            ? data?.content
            : data?.choices?.[0]?.message?.content;
        // 正文里的 think 标签（含只剩收尾标签的情况）不算回答
        const text = stripReasoningText(Array.isArray(rawContent)
            ? rawContent.filter((c) => c?.type !== 'thinking').map((c) => (typeof c === 'string' ? c : c?.text || '')).join('')
            : String(rawContent ?? ''));
        const finishReason = String(
            reqSpec.provider === 'anthropic'
                ? (data?.stop_reason || '')
                : (data?.choices?.[0]?.finish_reason || ''),
        );
        const reasoningTokensOnly = !text.trim()
            && Boolean(reasoningDelta(data?.choices?.[0]?.message) || (Array.isArray(data?.content) && data.content.some((c) => c?.type === 'thinking')));

        const usage = data?.usage || {};
        const latencyMs = Date.now() - started;
        pushLog({
            level: 'INFO',
            category: 'AI',
            durationMs: latencyMs,
            message: `completion model=${settings.model} provider=${reqSpec.provider}`,
            detail: { promptTokens: usage.prompt_tokens || usage.input_tokens || 0, completionTokens: usage.completion_tokens || usage.output_tokens || 0 },
        });
        return {
            ok: true,
            text,
            usage,
            model: settings.model,
            provider: reqSpec.provider,
            finishReason,
            latencyMs,
            ...(reasoningTokensOnly ? { reasoningTokensOnly: true } : {}),
        };
    } catch (error) {
        return {
            ok: false,
            error: error.message || '模型请求失败',
            model: settings.model,
            provider: reqSpec.provider,
            latencyMs: Date.now() - started,
            diagnostics: { endpoint: reqSpec.url, causeCode: String(error.cause?.code || error.code || ''), causeMessage: String(error.cause?.message || ''), isTimeout: error.name === 'TimeoutError' || error.name === 'AbortError' },
        };
    }
}

export async function testAiImageConnection({ profileId = '', model = '', timeoutMs = 90_000, overrideSettings = null } = {}) {
    const profiles = overrideSettings ? [] : await listProfiles();
    const baseSettings = overrideSettings || (profileId ? profiles.find((p) => p.id === profileId) : null) || await getActiveSettings();
    const modelOverride = String(model || '').trim();
    const settings = modelOverride ? { ...baseSettings, model: modelOverride } : baseSettings;
    const provider = settings.provider || 'openai-compatible';
    if (!hasUsableCredentials(settings)) {
        return {
            ok: false,
            text: '',
            error: '未配置 API Key，请在左下角头像 →「全局设置」→「AI 助手」中配置模型网关和密钥。',
            model: settings.model,
            provider,
            latencyMs: 0,
        };
    }
    const base = String(settings.apiBaseUrl || (provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.openai.com/v1'))
        .trim()
        .replace(/\/(?:chat\/completions|images\/generations)$/i, '')
        .replace(/\/+$/, '');
    const isNativeGemini = provider === 'gemini' && !/\/openai$/i.test(base);
    const endpoint = isNativeGemini
        ? `${base}/models/${encodeURIComponent(settings.model)}:generateContent`
        : `${base}/images/generations`;
    const headers = {
        'Content-Type': 'application/json',
        ...authHeaders(isNativeGemini && !settings.authMode ? { ...settings, authMode: 'x-goog-api-key' } : settings),
        ...(settings.headers || {}),
    };
    const body = isNativeGemini
        ? {
            contents: [{ role: 'user', parts: [{ text: 'Draw a minimalist blue geometric circle on white background.' }] }],
            generationConfig: { responseModalities: ['IMAGE'] },
        }
        : {
            ...(settings.extraBody || {}),
            model: settings.model,
            prompt: 'A minimalist blue geometric circle on white background',
            n: 1,
            size: '1024x1024',
        };
    const started = Date.now();
    const clampedTimeout = Math.max(1000, Math.min(300_000, Number(timeoutMs) || 90_000));
    try {
        const resp = await undiciFetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            dispatcher: aiDispatcherFor(settings),
            signal: AbortSignal.timeout(clampedTimeout),
        });
        const raw = await resp.text();
        let data = null;
        try { data = JSON.parse(raw); } catch { data = null; }
        if (/<!doctype|<html/i.test(raw)) {
            const preview = raw.replace(/\s+/g, ' ').slice(0, 220);
            return {
                ok: false,
                status: resp.status,
                error: `生图接口返回了 HTML 页面（HTTP ${resp.status}），并非标准 API。返回片段：${preview}`,
                model: settings.model,
                provider,
                latencyMs: Date.now() - started,
                diagnostics: { endpoint, upstreamStatus: resp.status, upstreamStatusText: resp.statusText || '', contentType: resp.headers.get('content-type') || '', rawBody: raw.slice(0, 4000), providerMessage: 'HTML response' },
            };
        }
        if (!resp.ok) {
            const nested = data?.error && typeof data.error === 'object' ? data.error : null;
            const message = String(nested?.message || nested?.msg || data?.message || data?.msg || data?.detail || (typeof data?.error === 'string' ? data.error : '') || `生图接口 HTTP ${resp.status}: ${raw.slice(0, 200)}`).trim();
            const code = String(nested?.code ?? nested?.type ?? data?.code ?? data?.type ?? '').trim();
            return {
                ok: false,
                status: resp.status,
                error: message,
                model: settings.model,
                provider,
                latencyMs: Date.now() - started,
                diagnostics: { endpoint, upstreamStatus: resp.status, upstreamStatusText: resp.statusText || '', contentType: resp.headers.get('content-type') || '', rawBody: raw.slice(0, 4000), providerMessage: message, providerCode: code },
            };
        }
        const firstImg = Array.isArray(data?.data) ? data.data[0] : null;
        const hasOpenAiImage = Boolean(firstImg?.b64_json || firstImg?.url);
        const hasGeminiImage = Boolean(data?.candidates?.[0]?.content?.parts?.some((p) => p?.inlineData?.data || p?.inline_data?.data));
        if (!hasOpenAiImage && !hasGeminiImage) {
            return {
                ok: false,
                status: 502,
                error: '生图接口未返回有效图片数据',
                model: settings.model,
                provider,
                latencyMs: Date.now() - started,
                diagnostics: { endpoint, upstreamStatus: resp.status, upstreamStatusText: resp.statusText || '', contentType: resp.headers.get('content-type') || '', rawBody: raw.slice(0, 4000), providerMessage: 'Empty image payload' },
            };
        }
        return {
            ok: true,
            text: 'OK (image generated)',
            model: settings.model,
            provider,
            latencyMs: Date.now() - started,
        };
    } catch (error) {
        return {
            ok: false,
            error: error.message || '生图接口请求失败',
            model: settings.model,
            provider,
            latencyMs: Date.now() - started,
            diagnostics: { endpoint, causeCode: String(error.cause?.code || error.code || ''), causeMessage: String(error.cause?.message || ''), isTimeout: error.name === 'TimeoutError' || error.name === 'AbortError' },
        };
    }
}

export async function streamAiChat({ messages, profileId = '', onDelta }) {
    const profiles = await listProfiles();
    const settings = (profileId ? profiles.find((p) => p.id === profileId) : null) || await getActiveSettings();
    if (!hasUsableCredentials(settings)) {
        throw new BusinessError('未配置可用的 AI 模型 API Key：请先点击左下角头像 →「全局设置」→「AI 助手」配置模型网关与 Token，或在无模型配置时体验系统内置诊断回复。');
    }

    const reqSpec = buildCompletionRequest(settings, messages, { stream: true });
    const resp = await undiciFetch(reqSpec.url, {
        method: 'POST',
        headers: reqSpec.headers,
        body: JSON.stringify(reqSpec.body),
        dispatcher: aiDispatcherFor(settings),
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

export async function listSessions({ ownerId = 'default', archived = false, prefArchived, query = '', limit = 50, offset = 0 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const prefs = await getConversationList(ownerId).catch(() => []);
    const minePrefs = new Map();
    for (const p of Array.isArray(prefs) ? prefs : []) {
        if (String(p?.source || 'mine') === 'mine' && p?.id) minePrefs.set(String(p.id), p);
    }
    const rows = await selectTable('ai_chat_sessions', {
        whereSql: `\`owner_id\` = ${sqlVal(ownerId)} AND \`archived\` = ${archived ? 1 : 0}`,
        orderBySql: '`pinned` DESC, `updated_at` DESC',
        limit: Math.max(safeLimit + safeOffset + minePrefs.size, 500),
        memFilter: (r) => r.owner_id === ownerId && Number(r.archived || 0) === (archived ? 1 : 0),
        memSort: (a, b) => (Number(b.pinned || 0) - Number(a.pinned || 0)) || ((b.updated_at || 0) - (a.updated_at || 0)),
    });
    const q = String(query || '').trim().toLowerCase();
    const mapped = rows.map((r) => {
        const pref = minePrefs.get(r.id);
        return {
            id: r.id,
            owner: r.owner_id,
            title: r.title,
            archived: Boolean(r.archived),
            pinned: Boolean(pref ? pref.pinned : r.pinned),
            summary: r.summary || '',
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            ...(parseJsonCol(r.metadata_json, {}) || {}),
        };
    });
    const activePinRank = (s) => {
        const pref = minePrefs.get(s.id);
        const activePin = pref ? (pref.pinned && !pref.archived && !pref.hidden) : s.pinned;
        if (!activePin) return [0, 0, 0];
        const ord = Number.isFinite(Number(pref?.pin_order)) ? Number(pref.pin_order) : (Number.isFinite(Number(pref?.order)) ? Number(pref.order) : Number.MAX_SAFE_INTEGER);
        return [1, -ord, 0];
    };
    const filtered = mapped.filter((s) => {
        const pref = minePrefs.get(s.id);
        if (prefArchived === '1' || prefArchived === true || prefArchived === 'true') {
            if (!pref?.archived || pref?.hidden) return false;
        } else if (prefArchived === '0' || prefArchived === false || prefArchived === 'false') {
            if (pref?.archived || pref?.hidden) return false;
        }
        if (q && !`${s.title} ${pref?.title || ''} ${s.summary}`.toLowerCase().includes(q)) return false;
        return true;
    });
    filtered.sort((a, b) => {
        const ra = activePinRank(a);
        const rb = activePinRank(b);
        if (rb[0] !== ra[0]) return rb[0] - ra[0];
        if (ra[0] === 1 && rb[1] !== ra[1]) return rb[1] - ra[1];
        return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
    });
    return filtered.slice(safeOffset, safeOffset + safeLimit);
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

export async function saveSession({ id, ownerId = 'default', title, summary = '', archived, pinned, metadata = {}, preserveUpdatedAt = false }) {
    const sid = String(id || `chat_${crypto.randomUUID().slice(0, 12)}`);
    const existing = await getSession(sid);
    const now = Date.now();
    await upsertRow('ai_chat_sessions', {
        id: sid,
        owner_id: existing?.owner || ownerId,
        title: String(title || existing?.title || '新对话').slice(0, 400),
        archived: (archived ?? existing?.archived) ? 1 : 0,
        pinned: (pinned ?? existing?.pinned) ? 1 : 0,
        summary: String(summary || existing?.summary || ''),
        metadata_json: JSON.stringify({ ...(existing?.metadata || {}), ...(metadata || {}) }),
        created_at: existing?.createdAt || now,
        updated_at: preserveUpdatedAt && existing?.updatedAt ? existing.updatedAt : now,
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
    const rows = [];
    const pageSize = Math.min(500, Math.max(1, config.maxPageSize));
    let cursor = null;
    for (;;) {
        const page = await selectTable('ai_chat_messages', {
            whereSql: `\`session_id\` = ${sqlVal(sessionId)}${cursor === null ? '' : ` AND \`id\` > ${sqlVal(cursor)}`}`,
            orderBySql: '\`id\` ASC',
            limit: pageSize,
            memFilter: (r) => r.session_id === sessionId && (cursor === null || Number(r.id) > Number(cursor)),
            memSort: (a, b) => a.id - b.id,
        });
        rows.push(...page);
        if (page.length < pageSize) break;
        cursor = page.at(-1).id;
    }
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
    const sid = String(sessionId);
    const now = Date.now();
    await insertRow('ai_chat_messages', {
        session_id: sid,
        role: String(role),
        content: String(content || ''),
        meta_json: JSON.stringify(meta || {}),
        created_at: now,
    });
    // 追加消息（包括在历史对话中继续提问与模型落库）时同步刷新会话 updated_at，避免侧栏刷新后按旧时间掉回原位
    await updateRows('ai_chat_sessions', { updated_at: now }, {
        whereSql: `\`id\` = ${sqlVal(sid)}`,
        memFilter: (r) => r.id === sid,
    });
}

export async function getConversationList(ownerId) {
    return (await kvGet(`${CONVERSATION_LIST_KEY_PREFIX}${ownerId}`, [])) || [];
}

export async function reorderConversationList(ownerId, patch = {}) {
    const source = String(patch?.source || 'mine').slice(0, 60);
    const order = Array.isArray(patch?.order) ? patch.order : [];
    const list = await getConversationList(ownerId);
    const orderMap = new Map(order.map((id, index) => [String(id), index]));
    const updated = list.map((item) => {
        if (String(item.source || 'mine') === source && orderMap.has(String(item.id))) {
            const idx = orderMap.get(String(item.id));
            return { ...item, order: idx, pin_order: idx, pinned: true, updatedAt: Date.now() };
        }
        return item;
    });
    for (const [id, idx] of orderMap) {
        if (!updated.some((x) => String(x.source || 'mine') === source && String(x.id) === id)) {
            updated.push({ source, id, order: idx, pin_order: idx, pinned: true, updatedAt: Date.now() });
        }
    }
    const next = updated
        .sort((x, y) => (Number(Boolean(y.pinned)) - Number(Boolean(x.pinned))) || ((x.pin_order ?? x.order ?? 999999) - (y.pin_order ?? y.order ?? 999999)) || ((y.updatedAt || 0) - (x.updatedAt || 0)))
        .slice(0, 500);
    await kvSet(`${CONVERSATION_LIST_KEY_PREFIX}${ownerId}`, next);
    return next;
}

// 置顶、改名、归档等个人偏好：前端每次只发改动的字段，这里按「来源 + 会话」合并后存回
export async function saveConversationList(ownerId, patch) {
    const source = String(patch?.source || 'mine').slice(0, 60);
    const id = String(patch?.id || '').slice(0, 120);
    if (!id) throw new BusinessError('缺少会话标识');
    const list = await getConversationList(ownerId);
    const same = (x) => String(x.source || 'mine') === source && String(x.id) === id;
    const allowed = {};
    if (typeof patch.pinned === 'boolean') {
        allowed.pinned = patch.pinned;
        if (patch.pinned === true) {
            const existing = list.find(same);
            if (!existing || (!Number.isFinite(existing.order) && !Number.isFinite(existing.pin_order))) {
                const minOrder = list
                    .filter((x) => String(x.source || 'mine') === source && x.pinned && (Number.isFinite(x.pin_order) || Number.isFinite(x.order)))
                    .reduce((min, x) => Math.min(min, x.pin_order ?? x.order), 0);
                allowed.order = minOrder - 1;
                allowed.pin_order = minOrder - 1;
            }
        } else {
            allowed.order = null;
            allowed.pin_order = null;
        }
    }
    if (typeof patch.archived === 'boolean') allowed.archived = patch.archived;
    if (typeof patch.hidden === 'boolean') allowed.hidden = patch.hidden;
    if (typeof patch.title === 'string') allowed.title = patch.title.trim().slice(0, 160);
    if (typeof patch.group === 'string') allowed.group = patch.group.trim().slice(0, 60);
    if (Number.isFinite(Number(patch.order))) {
        allowed.order = Number(patch.order);
        if (!Number.isFinite(Number(patch.pin_order))) allowed.pin_order = Number(patch.order);
    }
    if (Number.isFinite(Number(patch.pin_order))) {
        allowed.pin_order = Number(patch.pin_order);
        if (!Number.isFinite(Number(allowed.order))) allowed.order = Number(patch.pin_order);
    }
    const item = { ...(list.find(same) || {}), ...allowed, source, id, updatedAt: Date.now() };
    // 没有任何偏好的条目不留着占位置；最多保留最近改动的 500 条（置顶项优先保留，避免被普通偏好挤掉）
    const meaningful = item.pinned || item.archived || item.hidden || item.title || item.group || Number.isFinite(item.order) || Number.isFinite(item.pin_order);
    const next = [...list.filter((x) => !same(x)), ...(meaningful ? [item] : [])]
        .sort((x, y) => (Number(Boolean(y.pinned)) - Number(Boolean(x.pinned))) || ((x.pin_order ?? x.order ?? 999999) - (y.pin_order ?? y.order ?? 999999)) || ((y.updatedAt || 0) - (x.updatedAt || 0)))
        .slice(0, 500);
    await kvSet(`${CONVERSATION_LIST_KEY_PREFIX}${ownerId}`, next);
    if (source === 'mine' && typeof patch.pinned === 'boolean') {
        await updateRows('ai_chat_sessions', { pinned: patch.pinned ? 1 : 0 }, {
            whereSql: `\`id\` = ${sqlVal(id)} AND \`owner_id\` = ${sqlVal(ownerId)}`,
            memFilter: (r) => r.id === id && r.owner_id === ownerId,
        }).catch(() => {});
    }
    return item;
}
