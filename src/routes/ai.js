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
    saveConversationList,
} from '../services/ai-service.js';
import { runAgent } from '../agent/loop.js';
import { handleChatUpload } from './agent-extras.js';
import { listSkills } from '../services/skill-service.js';
import { getAutoSwitch } from '../services/ai-service.js';
import { prepareContext, compactSession, generateTitle } from '../services/conversation-service.js';
import { listSchedules, createSchedule, cancelSchedule } from '../services/schedule-service.js';
import { config } from '../config.js';

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
                hasApiKey: Boolean(p.apiKey),
            })),
        };
    });

    fastify.get('/conversation-list', async (req) => ({
        items: await getConversationList(ownerOf(req)),
    }));
    fastify.put('/conversation-list', async (req) => ({
        item: await saveConversationList(ownerOf(req), req.body || {}),
    }));

    fastify.get('/sessions', async (req) => {
        const items = await listSessions({
            ownerId: ownerOf(req),
            archived: false,
            query: req.query?.query || '',
            limit: req.query?.limit || 50,
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
        if (!await ownSession(req)) return notFound(reply);
        await deleteSession(req.params.sessionId);
        return { deleted: true };
    });

    fastify.get('/sessions/:sessionId/messages', async (req, reply) => {
        if (!await ownSession(req)) return notFound(reply);
        return { items: await listMessages(req.params.sessionId) };
    });

    fastify.get('/sessions/:sessionId/export', async (req, reply) => {
        const session = await ownSession(req);
        if (!session) return notFound(reply);
        return { session, messages: await listMessages(req.params.sessionId) };
    });

    fastify.post('/chat', async (req, reply) => {
        const body = req.body || {};
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const stream = body.stream === true;
        const ownerId = ownerOf(req);
        const persist = body.persist !== false;

        const lastUserMsg = [...messages].reverse().find((m) => m?.role === 'user');
        const userText = String(lastUserMsg?.content || body.message || '').trim();
        let sessionId = body.sessionId ? String(body.sessionId) : '';
        if (sessionId) {
            const existing = await getSession(sessionId);
            if (existing && existing.owner !== ownerId) return reply.code(404).send({ error: '会话不存在' });
        }

        let createdNow = false;
        if (persist && !sessionId) {
            createdNow = true;
            const created = await saveSession({
                ownerId,
                // 标题只取用户的话，不带附件清单
                title: userText.split('📎 附件：')[0].replace(/\s+/g, ' ').trim().slice(0, 40) || '新对话',
                metadata: { pagePath: body.pagePath || '/' },
            });
            sessionId = created.id;
        }
        if (persist && sessionId && userText) {
            await appendMessage(sessionId, 'user', userText);
        }

        const sendDone = (payload) => {
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
        if (!selected?.apiKey) {
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
            if (persist && sessionId) {
                await appendMessage(sessionId, 'model', fallbackReply);
            }
            return sendDone({
                reply: fallbackReply,
                sessionId,
                tokens: 0,
                usage: { inputTokens: 0, outputTokens: 0 },
                cost: 0,
            });
        }

        const history = messages
            .map((m) => ({ role: m.role === 'model' || m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }))
            .filter((m) => m.content.trim());
        if (!history.length && userText) history.push({ role: 'user', content: userText });

        // 用户点了停止或断开连接：中止模型请求，不再继续跑工具
        const abort = new AbortController();
        const onClose = () => { if (!reply.raw.writableEnded) abort.abort(); };
        req.raw.on('close', onClose);
        const write = (event) => {
            if (stream && !reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`${JSON.stringify(event)}\n`);
        };
        if (stream && sessionId) write({ type: 'start', sessionId });

        try {
            // 新对话：和回答并行地让模型起一个短标题
            const titlePromise = createdNow && userText ? generateTitle({ settings: selected, text: userText.split('📎 附件：')[0] }) : null;
            const context = persist && sessionId
                ? await prepareContext({ sessionId, history, settings: selected, emit: write })
                : { history, summary: '' };
            const res = await runAgent({
                settings: selected,
                identity: req.userIdentity || resolveRequestIdentity(req),
                history: context.history,
                summary: context.summary,
                skillIds: Array.isArray(body.skills) ? body.skills : [],
                language: body.uiLanguage || 'zh',
                emit: write,
                signal: abort.signal,
                profiles,
                autoSwitch: await getAutoSwitch(),
                secrets: [...profiles.map((p) => p.apiKey), config.secretKey].filter(Boolean),
            });
            const usedModel = res.model || selected;
            if (persist && sessionId && (res.text || res.events.length)) {
                await appendMessage(sessionId, 'model', res.text, { modelName: usedModel.model, ...(res.events.length ? { events: res.events } : {}) });
            }
            addUsage(res.usage, usedModel);
            if (titlePromise) {
                const title = await Promise.race([titlePromise, new Promise((r) => setTimeout(() => r(''), 4000))]);
                if (title) {
                    await saveSession({ id: sessionId, title });
                    write({ type: 'title', title, sessionId });
                }
            }
            return sendDone({
                reply: res.text,
                sessionId,
                model: { id: usedModel.id, name: usedModel.model },
                tokens: res.usage.inputTokens + res.usage.outputTokens,
                usage: res.usage,
            });
        } catch (err) {
            if (abort.signal.aborted) {
                if (stream && !reply.raw.writableEnded) reply.raw.end();
                return reply;
            }
            const message = err.message || 'AI 对话异常';
            if (stream) {
                write({ type: 'error', error: message });
                reply.raw.end();
                return reply;
            }
            return reply.code(err.code >= 400 && err.code < 600 ? err.code : 502).send({ error: message });
        } finally {
            req.raw.off('close', onClose);
        }
    });

    fastify.post('/compact', async (req, reply) => {
        const sessionId = String(req.body?.sessionId || '');
        const session = await getSession(sessionId);
        if (!session || session.owner !== ownerOf(req)) return reply.code(404).send({ error: '会话不存在' });
        const profiles = await listProfiles();
        const settings = profiles.find((p) => p.id === req.body?.modelId) || profiles.find((p) => p.isActive) || profiles[0];
        if (!settings?.apiKey) return reply.code(400).send({ error: '还没有配置模型，无法压缩对话' });
        return compactSession({ sessionId, settings });
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

    // 增强提示词：把一句口语化的问题改写成清楚、可执行的提问；没配模型或失败时原样返回
    fastify.post('/enhance-prompt', async (req) => {
        const prompt = String(req.body?.prompt || '').trim();
        if (!prompt) return { enhanced: '' };
        const res = await callAiCompletion({
            maxTokens: 600,
            messages: [
                { role: 'system', content: '你是提示词编辑。把用户的提问改写得更清楚、具体、可执行：补全对象、范围、期望的输出形式，保留原意和原有的专有名词，不要回答问题，不要加客套话，不要超过 200 字。只输出改写后的提问。' },
                { role: 'user', content: prompt.slice(0, 4000) },
            ],
        }).catch(() => null);
        const text = String(res?.ok ? res.text : '').trim().replace(/^["“「]|["”」]$/g, '');
        return { enhanced: text || prompt, changed: Boolean(text && text !== prompt) };
    });

    fastify.post('/uploads', handleChatUpload);


    // 首页侧栏/联想的非一期接口：温和返回空列表，确保控制台零 404/500 噪音
    fastify.get('/skills', async () => ({ items: await listSkills() }));
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

    fastify.post('/test', async (req, reply) => {
        const settings = await saveProfile(req.body || {}, req.body?.profileId || '');
        const res = await callAiCompletion({
            profileId: settings.activeProfileId,
            messages: [{ role: 'user', content: 'Hi, please reply OK.' }],
            maxTokens: 16,
        });
        if (!res.ok) return reply.code(400).send({ success: false, error: res.error });
        return { success: true, model: res.model, latencyMs: res.latencyMs, reply: res.text };
    });
}
