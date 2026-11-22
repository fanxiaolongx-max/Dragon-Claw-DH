import { randomUUID } from 'node:crypto';
import { resolveRequestIdentity } from '../core/identity.js';
import {
    getPublicSettings,
    listProfiles,
    saveProfile,
    activateProfile,
    deleteProfile,
    getUsage,
    addUsage,
    clearUsage,
    callAiCompletion,
    streamAiChat,
    listSessions,
    getSession,
    saveSession,
    setSessionArchived,
    deleteSession,
    listMessages,
    appendMessage,
    getConversationList,
    reorderConversationList,
    saveConversationList,
} from '../services/ai-service.js';
import { runAgent } from '../agent/loop.js';
import { redactText } from '../agent/redact.js';
import { lookup as lookupHistoryEvidence } from '../agent/history-evidence.js';
import {
    handleChatUpload,
    handleChatUploadStart,
    handleChatUploadChunk,
    handleChatUploadComplete,
    handleChatUploadCancel,
} from './agent-extras.js';
import { listSkills } from '../services/skill-service.js';
import { filterSkillsForUser } from '../services/distribution-service.js';
import { getAutoSwitch, hasUsableCredentials } from '../services/ai-service.js';
import { formatTestFailure } from '../services/ai-test-diagnostics.js';
import { prepareContext, compactSession, generateTitle, isTrivialProbe } from '../services/conversation-service.js';
import { listSchedules, createSchedule, cancelSchedule } from '../services/schedule-service.js';
import { config } from '../config.js';
import {
    sessionAccess,
    decorateMessages,
    claimTurn,
    releaseTurn,
    sharedHistory,
    sessionCapabilities,
    leave as leaveShare,
    startLiveStream,
    pushLiveDelta,
    pushLiveEvent,
    endLiveStream,
} from '../services/share-service.js';
import { TRANSLATE_SYSTEM_PROMPT } from '../services/business/translate-prompt.js';

export async function aiRoutes(fastify) {
    const ownerOf = (req) => resolveRequestIdentity(req).username;

    fastify.get('/models', async () => {
        const profiles = await listProfiles();
        return {
            models: profiles.map((p) => ({
                id: p.id,
                profileId: p.id,
                name: p.model || p.name,
                label: p.name || p.model,
                provider: p.provider,
                active: Boolean(p.isActive),
                hasApiKey: hasUsableCredentials(p),
            })),
        };
    });

    fastify.get('/conversation-list', async (req) => ({
        items: await getConversationList(ownerOf(req)),
    }));
    fastify.put('/conversation-list', async (req) => {
        if (req.body?.order !== undefined) {
            return { items: await reorderConversationList(ownerOf(req), req.body || {}) };
        }
        return { item: await saveConversationList(ownerOf(req), req.body || {}) };
    });

    fastify.get('/sessions', async (req) => {
        const items = await listSessions({
            ownerId: ownerOf(req),
            archived: false,
            prefArchived: req.query?.archived,
            query: req.query?.query || '',
            limit: req.query?.limit || 50,
            offset: req.query?.offset || 0,
        });
        return { items };
    });

    fastify.get('/sessions-archive', async (req) => {
        const items = await listSessions({
            ownerId: ownerOf(req),
            archived: true,
            query: req.query?.query || '',
            limit: req.query?.limit || 50,
        });
        return { items, total: items.length };
    });

    // 会话只属于创建者：按 ID 的读写都先核对归属，不属于本人一律按“不存在”处理
    const ownSession = async (req) => {
        const session = await getSession(String(req.params.sessionId || ''));
        return session && session.owner === ownerOf(req) ? session : null;
    };
    // 可读写对话内容的人：创建者，或共享对话里已接受邀请的成员（share-service.js）
    const accessSession = (req) => sessionAccess(String(req.params.sessionId || ''), ownerOf(req));
    const notFound = (reply) => reply.code(404).send({ error: '会话不存在' });

    fastify.post('/sessions/:sessionId/archive', async (req, reply) => {
        if (!await ownSession(req)) return notFound(reply);
        return { session: await setSessionArchived(req.params.sessionId, true) };
    });

    fastify.post('/sessions/:sessionId/unarchive', async (req, reply) => {
        if (!await ownSession(req)) return notFound(reply);
        return { session: await setSessionArchived(req.params.sessionId, false) };
    });

    fastify.delete('/sessions/:sessionId', async (req, reply) => {
        // 共享成员从自己的列表里删掉这段对话 = 退出共享；对话本身属于发起者，不删
        // 发起者删除原对话时同时关闭共享，便于其他打开页签的成员即时收到已停止通知
        const access = await accessSession(req);
        if (access?.role === 'member') { await leaveShare({ user: ownerOf(req), sessionId: req.params.sessionId }); return { deleted: true }; }
        if (!await ownSession(req)) return notFound(reply);
        if (access?.role === 'owner') await leaveShare({ user: ownerOf(req), sessionId: req.params.sessionId }).catch(() => {});
        await deleteSession(req.params.sessionId);
        return { deleted: true };
    });

    fastify.get('/sessions/:sessionId/messages', async (req, reply) => {
        const access = await accessSession(req);
        if (!access) return notFound(reply);
        const items = await decorateMessages(await listMessages(req.params.sessionId), { share: access.share, ownerId: access.session.owner, viewer: ownerOf(req) });
        return { items };
    });

    fastify.get('/sessions/:sessionId/export', async (req, reply) => {
        const access = await accessSession(req);
        if (!access) return notFound(reply);
        return { session: access.session, messages: await listMessages(req.params.sessionId) };
    });

    fastify.post('/chat', async (req, reply) => {
        const body = req.body || {};
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const stream = body.stream === true;
        const ownerId = ownerOf(req);
        const persist = body.persist !== false;

        const lastUserMsg = [...messages].reverse().find((m) => m?.role === 'user');
        const userText = String(lastUserMsg?.content || body.message || '').trim();
        // 标题只取用户的话，不带附件清单
        const questionText = userText.split('📎 附件：')[0];
        const plainTitle = questionText.replace(/\s+/g, ' ').trim().slice(0, 40);
        const probeOnly = isTrivialProbe(questionText);
        let sessionId = body.sessionId ? String(body.sessionId) : '';
        let existingSession = null;
        let sharedTurn = null;
        if (sessionId) {
            existingSession = await getSession(sessionId);
            if (existingSession && existingSession.owner !== ownerId) {
                // 共享对话的成员也能接着提问：按本人身份执行，同一时间只让一个人提问
                const access = await sessionAccess(sessionId, ownerId);
                if (!access) return reply.code(404).send({ error: '会话不存在' });
                sharedTurn = access;
            } else if (existingSession) {
                const access = await sessionAccess(sessionId, ownerId);
                if (access?.share?.status === 'active') sharedTurn = access;
            }
            if (sharedTurn && persist) {
                const me = req.userIdentity || resolveRequestIdentity(req);
                try { await claimTurn(existingSession, ownerId, me.displayName, questionText); }
                catch (busy) { return reply.code(409).send({ code: 'SHARED_TURN_BUSY', error: busy.message }); }
                startLiveStream(sessionId, { by: ownerId, name: me.displayName || ownerId, question: questionText });
            }
        }
        // 新手引导里自动发出的示例提问：只在新对话里生效，按只读演示跑
        const readOnlyDemo = body.tourReportExample === true && !sessionId;

        let createdNow = false;
        if (persist && !sessionId) {
            createdNow = true;
            const created = await saveSession({
                ownerId,
                title: plainTitle || '新对话',
                // 开场只是打招呼：先用原话当标题，记下来，等第一句正经问题再换
                metadata: { pagePath: body.pagePath || '/', ...(probeOnly ? { probeTitle: plainTitle || '新对话' } : {}) },
            });
            sessionId = created.id;
        }
        // 之前的标题来自开场试探、用户也没改过名：这一句是正经问题就重新起标题
        const retitle = Boolean(persist && existingSession && !sharedTurn && !probeOnly && questionText.trim()
            && existingSession.metadata?.probeTitle && existingSession.metadata.probeTitle === existingSession.title);
        const memorySource = persist && sessionId && userText ? { sessionId, messageId: randomUUID() } : null;
        if (memorySource) {
            await appendMessage(sessionId, 'user', userText, { author: ownerId, memoryTurn: memorySource.messageId });
        }

        const sendDone = (payload) => {
            if (sharedTurn && sessionId) endLiveStream(sessionId, {}, ownerId);
            if (stream) {
                reply.raw.write(`${JSON.stringify({ type: 'done', ...payload })}\n`);
                reply.raw.end();
                return reply;
            }
            return reply.send(payload);
        };

        if (stream) {
            reply.raw.writeHead(200, {
                'Content-Type': 'application/x-ndjson; charset=utf-8',
                'Cache-Control': 'no-store, no-transform',
                'X-Accel-Buffering': 'no',
            });
        }

        const profiles = await listProfiles();
        const selected = profiles.find((p) => p.id === body.modelId) || profiles.find((p) => p.isActive) || profiles[0];
        if (!selected || !hasUsableCredentials(selected)) {
            const fallbackReply = [
                '还没有配置可用的大模型，所以暂时不能对话。',
                '',
                '- 管理员：点左下角头像 →「全局设置」→「AI 助手」，填写模型网关地址、模型名和 API Key，点「测试连接」通过后即可使用（支持 OpenAI 兼容、Anthropic、Gemini 兼容网关）。',
                '- 其他同事：请联系管理员完成配置。',
                '',
                '不依赖模型的功能可以照常使用：数据抓取、数据导入、报表看板、一键催办、大屏看板、数据探索。',
            ].join('\n');
            if (stream) {
                reply.raw.write(`${JSON.stringify({ type: 'delta', delta: fallbackReply })}\n`);
            }
            if (sharedTurn && sessionId) {
                pushLiveDelta(sessionId, fallbackReply);
            }
            if (persist && sessionId) {
                await appendMessage(sessionId, 'model', fallbackReply, { author: ownerId });
            }
            if (sharedTurn) await releaseTurn(sessionId, ownerId).catch(() => {});
            return sendDone({
                reply: fallbackReply,
                sessionId,
                tokens: 0,
                usage: { inputTokens: 0, outputTokens: 0 },
                cost: 0,
            });
        }

        // 共享对话：历史从库里取（别人刚发的消息页面上不一定已经接上），别人的提问标注账号
        const history = sharedTurn
            ? await sharedHistory(sessionId, { ownerId: sharedTurn.session.owner, viewer: ownerId })
            : messages
                .map((m) => ({ role: m.role === 'model' || m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }))
                .filter((m) => m.content.trim());
        if (!history.length && userText) history.push({ role: 'user', content: userText });

        // 用户点了停止或断开连接：中止模型请求，不再继续跑工具
        const abort = new AbortController();
        const onClose = () => { if (!reply.raw.writableEnded) abort.abort(); };
        req.raw.on('close', onClose);
        const write = (event) => {
            if (stream && !reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`${JSON.stringify(event)}\n`);
            if (sharedTurn && sessionId) {
                if (event.type === 'delta') pushLiveDelta(sessionId, event.delta);
                else pushLiveEvent(sessionId, event);
            }
        };
        if (stream && sessionId) write({ type: 'start', sessionId });

        try {
            // 新对话：和回答并行地让模型起一个短标题
            const titlePromise = ((createdNow && userText && !probeOnly) || retitle) ? generateTitle({ settings: selected, text: questionText }) : null;
            const secrets = [...profiles.map((p) => p.apiKey), config.secretKey].filter(Boolean);
            const context = persist && sessionId
                ? await prepareContext({ sessionId, history, settings: selected, emit: write, secrets })
                : { history, summary: '', independentTopic: false, scopedToNewTopic: false, returning: false, restoringTopic: false, recallQuery: questionText, sinceSeq: 0 };
            const historyEvidence = persist && sessionId && !context.independentTopic
                ? await lookupHistoryEvidence({
                    sessionId,
                    question: context.recallQuery || questionText,
                    returning: Boolean(context.restoringTopic),
                    sinceSeq: context.sinceSeq,
                    stored: context.stored,
                    viewer: ownerId,
                    secrets,
                }).catch(() => '')
                : '';
            const turnIdentity = req.userIdentity || resolveRequestIdentity(req);
            const sharedCapabilities = (sharedTurn && sessionId)
                ? await sessionCapabilities({ identity: turnIdentity, sessionId }).catch(() => null)
                : null;
            const res = await runAgent({
                settings: selected,
                sessionId: persist ? sessionId : '',
                memorySource,
                isShared: Boolean(sharedTurn),
                sharedCapabilities,
                identity: turnIdentity,
                history: context.history,
                summary: context.summary,
                recallQuery: context.recallQuery || questionText,
                historyEvidence,
                skillIds: Array.isArray(body.skills) ? body.skills : [],
                language: body.uiLanguage || 'zh',
                emit: write,
                signal: abort.signal,
                profiles,
                autoSwitch: await getAutoSwitch(),
                secrets,
                readOnlyDemo,
            });
            const usedModel = res.model || selected;
            const roundMetrics = Array.isArray(res.roundMetrics) ? res.roundMetrics : [];
            if (persist && sessionId && (res.text || res.events.length)) {
                await appendMessage(sessionId, 'model', res.text, {
                    author: ownerId,
                    modelName: usedModel.model,
                    model_name: usedModel.model,
                    input_tokens: res.usage?.inputTokens || 0,
                    output_tokens: res.usage?.outputTokens || 0,
                    inputTokens: res.usage?.inputTokens || 0,
                    outputTokens: res.usage?.outputTokens || 0,
                    rounds: roundMetrics,
                    ...(res.events.length ? { events: res.events } : {}),
                });
            }
            await addUsage(res.usage, usedModel);
            if (titlePromise) {
                const title = (await Promise.race([titlePromise, new Promise((r) => setTimeout(() => r(''), 4000))])) || (retitle ? plainTitle : '');
                if (title) {
                    // 只更新标题和试探消息标记，保留会话状态。
                    await saveSession({ id: sessionId, title, ...(retitle ? { metadata: { probeTitle: '' } } : {}) });
                    write({ type: 'title', title, sessionId });
                }
            }
            return sendDone({
                reply: res.text,
                sessionId,
                model: { id: usedModel.id, name: usedModel.model },
                tokens: res.usage.inputTokens + res.usage.outputTokens,
                usage: res.usage,
                rounds: roundMetrics,
            });
        } catch (err) {
            if (abort.signal.aborted) {
                if (sharedTurn && sessionId) endLiveStream(sessionId, {}, ownerId);
                if (stream && !reply.raw.writableEnded) reply.raw.end();
                return reply;
            }
            const message = err.message || 'AI 对话异常';
            // write() 会同时广播给围观者；非流式请求单独推一次，然后再结束这一轮
            if (stream) write({ type: 'error', error: message });
            else if (sharedTurn && sessionId) pushLiveEvent(sessionId, { type: 'error', error: message });
            if (sharedTurn && sessionId) endLiveStream(sessionId, { error: message }, ownerId);
            if (stream) {
                reply.raw.end();
                return reply;
            }
            return reply.code(err.code >= 400 && err.code < 600 ? err.code : 502).send({ error: message });
        } finally {
            req.raw.off('close', onClose);
            if (sharedTurn) await releaseTurn(sessionId, ownerId).catch(() => {});
        }
    });

    fastify.post('/compact', async (req, reply) => {
        const sessionId = String(req.body?.sessionId || '');
        const session = await getSession(sessionId);
        if (!session || session.owner !== ownerOf(req)) return reply.code(404).send({ error: '会话不存在' });
        const profiles = await listProfiles();
        const settings = profiles.find((p) => p.id === req.body?.modelId) || profiles.find((p) => p.isActive) || profiles[0];
        if (!settings || !hasUsableCredentials(settings)) return reply.code(400).send({ error: '还没有配置模型，无法压缩对话' });
        const secrets = [...profiles.map((p) => p.apiKey), config.secretKey].filter(Boolean);
        return compactSession({ sessionId, settings, secrets });
    });

    // 定时任务：只能查看 / 创建 / 取消自己的
    fastify.get('/schedules', async (req) => listSchedules(ownerOf(req), { since: typeof req.query?.since === 'string' ? req.query.since : '' }));
    fastify.post('/schedules', async (req, reply) => reply.code(201).send({ item: await createSchedule({
        owner: ownerOf(req),
        text: String(req.body?.text || '').slice(0, 4200),
        sessionId: typeof req.body?.sessionId === 'string' ? req.body.sessionId : '',
        timezone: typeof req.body?.timezone === 'string' ? req.body.timezone.slice(0, 64) : '',
        modelId: req.body?.modelId,
    }) }));
    fastify.delete('/schedules/:id', async (req) => ({ item: await cancelSchedule(req.params.id, ownerOf(req)) }));

    // 增强提示词：兼容前端 { text, modelId, uiLanguage } 与旧版 { prompt }，返回 { prompt, enhanced, changed }
    fastify.post('/enhance-prompt', async (req, reply) => {
        const rawText = String(req.body?.text ?? req.body?.prompt ?? '').trim();
        if (!rawText) return reply.code(400).send({ error: '请先输入需要增强的提示词' });
        if (rawText.length > 8000) return reply.code(400).send({ error: '提示词最多支持 8000 个字符' });
        if (/^\s*\/(?:new|session|schedule|btw|compact)\b/i.test(rawText)) {
            return reply.code(400).send({ error: '快捷指令请直接执行，无需增强' });
        }

        const profiles = await listProfiles().catch(() => []);
        const selected = profiles.find((p) => p.id === req.body?.modelId) || profiles.find((p) => p.isActive) || profiles[0];
        if (!selected?.apiKey || !selected?.apiBaseUrl) {
            return reply.code(503).send({ error: '请先配置可用的 AI 模型' });
        }

        const safeInput = redactText(rawText.slice(0, 4000));
        const uiLang = req.body?.uiLanguage === 'en' ? 'English' : 'Chinese';
        const res = await callAiCompletion({
            profileId: selected.id || '',
            model: selected.model || '',
            maxTokens: 800,
            messages: [
                {
                    role: 'system',
                    content: `你是提示词编辑。把用户的提问草稿改写得更清楚、具体、可执行：补全对象、范围、期望的输出形式，保留原意、原有 @skill 引用、URL、路径和专有名词，不要回答问题，不要加客套话，不要超过 250 字。界面语言为 ${uiLang}，改写结果保持用户原稿语言。只输出改写后的提问文本。`,
                },
                { role: 'user', content: safeInput },
            ],
        }).catch(() => null);

        if (!res?.ok) {
            return reply.code(502).send({ error: res?.error || '提示词增强失败，请稍后重试；原文已保留' });
        }

        let text = String(res.text || '').trim();
        const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
        if (fenced) text = fenced[1].trim();
        if (text.startsWith('{') && text.endsWith('}')) {
            try {
                const parsed = JSON.parse(text);
                if (typeof parsed?.prompt === 'string') text = parsed.prompt.trim();
            } catch { /* ignore */ }
        }
        text = redactText(text.replace(/^["“「]|["”」]$/g, '').trim());
        if (!text) {
            return reply.code(502).send({ error: '增强结果为空，原文已保留' });
        }
        return { prompt: text, enhanced: text, changed: text !== rawText };
    });

    // 月报中译英：保留加粗、颜色等行内格式（专题分析的中英对照用）
    fastify.post('/translate', async (req, reply) => {
        const text = typeof req.body?.text === 'string' ? req.body.text : '';
        if (!text.trim()) return reply.code(400).send({ error: '缺少需要翻译的文本 (text)' });
        const res = await callAiCompletion({
            maxTokens: 2048,
            messages: [
                { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
                { role: 'user', content: `Context: ${String(req.body?.context || 'Monthly Operations Report').slice(0, 300)}\nTranslate the following Chinese HTML snippet to English:\n${text.slice(0, 20000)}` },
            ],
        });
        if (!res.ok) return reply.code(503).send({ error: res.error || 'AI 翻译失败' });
        return { translatedText: String(res.text || '').trim().replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/, '').trim() };
    });

    fastify.post('/uploads', handleChatUpload);
    fastify.post('/uploads/start', handleChatUploadStart);
    fastify.post('/uploads/:uploadId/chunk', handleChatUploadChunk);
    fastify.post('/uploads/:uploadId/complete', handleChatUploadComplete);
    fastify.delete('/uploads/:uploadId', handleChatUploadCancel);


    // 首页侧栏/联想的非一期接口：温和返回空列表，确保控制台零 404/500 噪音
    fastify.get('/skills', async (req) => ({ items: await filterSkillsForUser(await listSkills(), resolveRequestIdentity(req)) }));
    fastify.get('/connector-status', async () => ({ connected: false, webPhase: 1, connectors: [] }));
    fastify.get('/suggestions', async () => ({ items: [] }));
    fastify.get('/proactive-alerts', async () => ({ items: [] }));
    fastify.post('/proactive-alert-message', async () => ({ success: true }));
    fastify.get('/knowledge/status', async () => ({ ready: false, count: 0, message: '二期接入' }));
    fastify.get('/knowledge/graph', async () => ({ nodes: [], edges: [] }));
    fastify.get('/tool-local-keys', async () => ({ keys: [] }));
}

export async function aiSettingsRoutes(fastify) {
    fastify.get('/', async () => getPublicSettings());
    fastify.put('/', async (req) => saveProfile(req.body || {}, req.body?.profileId || ''));
    fastify.post('/profiles', async (req, reply) => reply.code(201).send(await saveProfile(req.body || {})));
    fastify.put('/profiles/:profileId', async (req) => saveProfile(req.body || {}, req.params.profileId));
    fastify.post('/profiles/:profileId/activate', async (req) => activateProfile(req.params.profileId));
    fastify.delete('/profiles/:profileId', async (req) => deleteProfile(req.params.profileId));

    fastify.get('/usage', async (req) => getUsage(String(req.query?.dimension || 'day')));
    fastify.delete('/usage', async (req) => ({ success: true, ...(await clearUsage(req.query?.clearAll === 'true' ? '' : String(req.query?.key || ''))) }));
    fastify.post('/usage/clear', async () => ({ success: true, ...(await clearUsage()) }));
    fastify.put('/model-aliases', async (_req, reply) => reply.code(410).send({
        code: 'MODEL_ALIASES_REMOVED',
        error: '已取消模型名称映射，对话直接显示真实模型名称',
    }));

    const EDITABLE_PROFILE_KEYS = ['name', 'provider', 'apiBaseUrl', 'baseUrl', 'apiKey', 'clearApiKey', 'headers', 'extraBody', 'temperature', 'maxOutputTokens', 'contextWindowTokens', 'systemPrompt', 'models', 'authMode', 'customAuthHeader', 'verifySsl'];
    const handleProfileTest = async (req, reply) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const paramId = String(req.params?.profileId || body.profileId || '').trim();
        const profiles = await listProfiles();
        const existing = paramId ? profiles.find((p) => p.id === paramId) : null;
        const hasEdits = EDITABLE_PROFILE_KEYS.some((k) => body[k] !== undefined);
        if (paramId && !existing && !hasEdits) {
            return reply.code(404).send({ success: false, error: 'AI 配置方案不存在' });
        }
        let targetProfileId = paramId;
        if (hasEdits) {
            // 测试渠道列表里的非主模型时，保留已有主模型，避免误覆盖 ★ 默认主模型
            const keepPrimary = existing && Array.isArray(body.models) && body.model && body.model !== existing.model && body.models.includes(existing.model);
            const saveInput = keepPrimary ? { ...body, model: existing.model } : body;
            const settings = await saveProfile(saveInput, paramId);
            targetProfileId = paramId || settings.activeProfileId;
        } else if (typeof body.autoSwitchEnabled === 'boolean') {
            await saveProfile({ autoSwitchEnabled: body.autoSwitchEnabled, profileId: paramId }, paramId);
        }
        const res = await callAiCompletion({
            profileId: targetProfileId,
            model: String(body.model || '').trim(),
            messages: [{ role: 'user', content: 'Hi, please reply OK.' }],
            maxTokens: 16,
        });
        if (!res.ok) {
            // 失败详情：请求地址、HTTP 状态、上游原文与排查建议（全部脱敏）
            const profilesNow = await listProfiles();
            const target = profilesNow.find((p) => p.id === targetProfileId) || profilesNow.find((p) => p.isActive) || {};
            const secrets = [...profilesNow.map((p) => p.apiKey), config.secretKey].filter(Boolean);
            return reply.code(400).send(formatTestFailure(res, target, { secrets, request: { model: res.model, maxTokens: 16, stream: false, authMode: target.authMode || 'bearer' } }));
        }
        return { success: true, model: res.model, latencyMs: res.latencyMs, reply: res.text };
    };

    fastify.post('/test', handleProfileTest);
    fastify.post('/profiles/:profileId/test', handleProfileTest);
}
