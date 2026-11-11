import { resolveRequestIdentity } from '../core/identity.js';
import {
    getPublicSettings,
    listProfiles,
    saveProfile,
    activateProfile,
    deleteProfile,
    getUsage,
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

        if (persist && !sessionId) {
            const created = await saveSession({
                ownerId,
                title: userText.slice(0, 40) || '新对话',
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
                '当前运行在 **Dragon Claw 数字人云端 Web 版（一期）**。',
                '',
                '检测到尚未配置大模型 API Token，无法连接外部 LLM。您可以：',
                '- 点击左下角头像 → **「全局设置」→「AI 助手」** 配置您的 OpenAI / Anthropic / Gemini 兼容网关地址与 API Key；',
                '- 或直接使用左侧导航进入 **数据抓取 / 数据导入 / 报表看板 / 一键催办 / AI 月报 / 大屏看板**；',
                '- 点击右下角 **「🐛 调试模式」** 查看当前数字人身份 Cookie、数据库 MySQL 通道与 Redis 缓存状态。',
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

        const llmMessages = messages.map((m) => ({
            role: m.role === 'model' ? 'assistant' : (m.role || 'user'),
            content: String(m.content || ''),
        }));
        if (selected.systemPrompt) {
            llmMessages.unshift({ role: 'system', content: selected.systemPrompt });
        }

        try {
            if (stream) {
                const res = await streamAiChat({
                    messages: llmMessages,
                    profileId: selected.id,
                    onDelta: (delta) => {
                        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                            reply.raw.write(`${JSON.stringify({ type: 'delta', delta })}\n`);
                        }
                    },
                });
                if (persist && sessionId) {
                    await appendMessage(sessionId, 'model', res.text, { modelName: res.model });
                }
                return sendDone({
                    reply: res.text,
                    sessionId,
                    model: { id: selected.id, name: res.model },
                    tokens: 0,
                    usage: { inputTokens: 0, outputTokens: 0 },
                });
            }

            const res = await callAiCompletion({ messages: llmMessages, profileId: selected.id });
            if (!res.ok) {
                return reply.code(502).send({ error: res.error || 'AI 调用失败' });
            }
            if (persist && sessionId) {
                await appendMessage(sessionId, 'model', res.text, { modelName: res.model });
            }
            return sendDone({
                reply: res.text,
                sessionId,
                model: { id: selected.id, name: res.model },
                tokens: (res.usage?.prompt_tokens || 0) + (res.usage?.completion_tokens || 0),
                usage: {
                    inputTokens: res.usage?.prompt_tokens || 0,
                    outputTokens: res.usage?.completion_tokens || 0,
                },
            });
        } catch (err) {
            if (stream) {
                reply.raw.write(`${JSON.stringify({ type: 'error', error: err.message })}\n`);
                reply.raw.end();
                return reply;
            }
            return reply.code(500).send({ error: err.message || 'AI 对话异常' });
        }
    });

    fastify.post('/compact', async (req) => {
        const msgs = await listMessages(String(req.body?.sessionId || ''));
        return { success: true, summary: `已整理历史对话 ${msgs.length} 条记录` };
    });

    fastify.post('/enhance-prompt', async (req) => ({
        enhanced: String(req.body?.prompt || ''),
    }));

    fastify.post('/uploads', async (_req, reply) => reply.code(501).send({
        code: 'WEB_PHASE2_FEATURE',
        error: '对话附件上传将在二期开放',
    }));

    // 首页侧栏/联想的非一期接口：温和返回空列表，确保控制台零 404/500 噪音
    fastify.get('/skills', async () => ({ items: [] }));
    fastify.get('/connector-status', async () => ({ connected: false, webPhase: 1, connectors: [] }));
    fastify.get('/suggestions', async () => ({ items: [] }));
    fastify.get('/proactive-alerts', async () => ({ items: [] }));
    fastify.post('/proactive-alert-message', async () => ({ success: true }));
    fastify.get('/knowledge/status', async () => ({ ready: false, count: 0, message: '二期接入' }));
    fastify.get('/knowledge/graph', async () => ({ nodes: [], edges: [] }));
    fastify.get('/schedules', async () => ({ items: [] }));
    fastify.get('/tool-local-keys', async () => ({ keys: [] }));
}

export async function aiSettingsRoutes(fastify) {
    fastify.get('/', async () => getPublicSettings());
    fastify.put('/', async (req) => saveProfile(req.body || {}, req.body?.profileId || ''));
    fastify.post('/profiles', async (req, reply) => reply.code(201).send(await saveProfile(req.body || {})));
    fastify.put('/profiles/:profileId', async (req) => saveProfile(req.body || {}, req.params.profileId));
    fastify.post('/profiles/:profileId/activate', async (req) => activateProfile(req.params.profileId));
    fastify.delete('/profiles/:profileId', async (req) => deleteProfile(req.params.profileId));

    fastify.get('/usage', async () => getUsage());
    fastify.delete('/usage', async () => ({ success: true, ...(await clearUsage()) }));
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
