import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockBaseServer } from './helpers/mock-base.js';

const as = (user) => ({ cookie: `iLearningXUserName=${user}` });

test('conversationTitle 规则精简与 cleanGeneratedTitle 清洗', async () => {
    const { conversationTitle, cleanGeneratedTitle, isTitleAlreadyShort } = await import('../src/services/conversation-title.js');

    assert.equal(conversationTitle('你好'), '新对话');
    assert.match(conversationTitle('请问帮我看一下 CNBG 数字证书按运营商维度的整改完成率吗？谢谢'), /^CNBG 数字证书/);
    assert.ok([...conversationTitle('请问帮我看一下 CNBG 数字证书按运营商维度的整改完成率吗？谢谢')].length <= 22);
    assert.equal(
        conversationTitle('帮我查一下 NetCare 整改相关的表有哪些\n📎 附件：a.xlsx'),
        'NetCare 整改相关表查询',
    );
    const sqlTitle = conversationTitle('cs_nc_comm_customer_d_list 97 列里有没有直接放 028262 这类编码的列，以及第 2 条 SQL 报服务器内部错误的精确写法');
    assert.ok([...sqlTitle].length <= 32, `规则标题不应原样截到 40 字，实际：${sqlTitle}`);
    assert.doesNotMatch(sqlTitle, /放 0$/, '不应像旧版 slice(0,40) 那样把数字 028262 截断成 0');

    assert.equal(cleanGeneratedTitle('{"title":"CNBG 运营商整改完成率"}'), 'CNBG 运营商整改完成率');
    assert.equal(cleanGeneratedTitle('```json\n{"title": "《客户维表编码排查》！"}\n```'), '客户维表编码排查');
    assert.equal(cleanGeneratedTitle('标题：运营商编码映射排查。'), '运营商编码映射排查');
    assert.equal(cleanGeneratedTitle('这是一段模型答非所问的非常非常长的完整正文回复，根本不是精简的短标题内容'), '');
    assert.equal(isTitleAlreadyShort('运营商整改完成率'), true);
    assert.equal(isTitleAlreadyShort('cs_nc_comm_customer_d_list 97 列里有没有直接放 0'), false);
});

test('基座版 generateTitle 兼容思考模型（maxTokens>=512 与 reasoningTokensOnly 自动重试）并实时推流更新标题', async () => {
    const mockBase = await startMockBaseServer();
    const titleRequests = [];
    let titleCallCount = 0;
    const mockAi = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const isTitleReq = Array.isArray(body.messages) && body.messages.some((m) => String(m.content || '').includes('You name a chat conversation'));
        if (isTitleReq) {
            titleCallCount += 1;
            titleRequests.push({ max_tokens: body.max_tokens, temperature: body.temperature });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            // 第 1 次模拟 glm-52 在 512 token 下仅输出思考内容（reasoningTokensOnly），第 2 次 1536 token 才输出 JSON 标题
            if (titleCallCount === 1) {
                res.end(JSON.stringify({
                    choices: [{
                        message: { role: 'assistant', content: '', reasoning_content: '正在分析用户意图，先总结标题……' },
                        finish_reason: 'length',
                    }],
                    usage: { prompt_tokens: 40, completion_tokens: 512 },
                }));
                return;
            }
            res.end(JSON.stringify({
                choices: [{
                    message: { role: 'assistant', content: '{"title":"客户维表编码与报错排查"}', reasoning_content: '概括为 11 字标题' },
                    finish_reason: 'stop',
                }],
                usage: { prompt_tokens: 40, completion_tokens: 80 },
            }));
            return;
        }
        // 主对话流式回复：稍晚 120ms 结束，验证标题在回答流式期间就能提前发出
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '查好了。' }, finish_reason: null }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 120));
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    });
    await new Promise((resolve) => mockAi.listen(0, '127.0.0.1', resolve));
    const aiUrl = `http://127.0.0.1:${mockAi.address().port}/v1`;

    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mockBase.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mockBase.baseUrl}/execute`,
        APP_SCHEMA: 'conv-title-test',
        APP_UUID: 'conv-title-test',
        APP_DATASOURCE_ID: '2',
    });

    const { createServer } = await import('../src/server.js');
    const { saveProfile, getSession, saveSession, appendMessage } = await import('../src/services/ai-service.js');
    const app = await createServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

    try {
        await saveProfile({
            name: 'GLM-52 Mock',
            provider: 'openai',
            apiBaseUrl: aiUrl,
            apiKey: 'sk-mock-title-key-123456',
            model: 'glm-52',
            activate: true,
        });

        const resp = await fetch(`${baseUrl}/api/ai/chat`, {
            method: 'POST',
            headers: { ...as('alice'), 'content-type': 'application/json' },
            body: JSON.stringify({
                stream: true,
                messages: [{ role: 'user', content: 'cs_nc_comm_customer_d_list 97 列里有没有直接放 028262 这类编码的列，以及第 2 条 SQL 报服务器内部错误的精确写法' }],
            }),
        });
        assert.equal(resp.status, 200);
        const raw = await resp.text();
        const events = raw.trim().split('\n').map((l) => JSON.parse(l));
        const titleEv = events.find((e) => e.type === 'title');
        const doneEv = events.find((e) => e.type === 'done');

        assert.ok(titleRequests.length >= 2, '思考截断时应自动加大预算重试');
        assert.equal(titleRequests[0].max_tokens, 512, '首次起标题预算应 >= 512，不能再是 40');
        assert.equal(titleRequests[1].max_tokens, 1536, '思考截断后应自动重试 1536');
        assert.equal(titleRequests[0].temperature, 0.2);
        assert.ok(titleEv, '流式事件应推送 title 事件');
        assert.equal(titleEv.title, '客户维表编码与报错排查');
        assert.ok(doneEv && doneEv.sessionId);

        const saved = await getSession(doneEv.sessionId);
        assert.equal(saved.title, '客户维表编码与报错排查');
        assert.equal(saved.metadata?.titleSource, 'ai');

        // 旧的长标题会话在拉取 /api/ai/sessions 时会在后台自动补齐且不改变原 updatedAt
        const legacy = await saveSession({
            id: 'chat_legacy_long_1',
            ownerId: 'alice',
            title: 'cs_nc_comm_customer_d_list 97 列里有没有直接放 0',
            metadata: { pagePath: '/' },
        });
        await appendMessage(legacy.id, 'user', 'cs_nc_comm_customer_d_list 97 列里有没有直接放 028262 这类编码的列');
        const beforeUpdated = (await getSession(legacy.id)).updatedAt;
        const listResp = await fetch(`${baseUrl}/api/ai/sessions`, { headers: as('alice') });
        assert.equal(listResp.status, 200);
        // 等待后台补齐落库
        for (let i = 0; i < 20; i += 1) {
            const cur = await getSession(legacy.id);
            if (cur?.metadata?.titleSource === 'ai') break;
            await new Promise((r) => setTimeout(r, 40));
        }
        const upgraded = await getSession(legacy.id);
        assert.equal(upgraded.title, '客户维表编码与报错排查');
        assert.equal(upgraded.metadata?.titleSource, 'ai');
        assert.equal(upgraded.updatedAt, beforeUpdated, '后台补齐旧标题不应改变原会话排序时间');
    } finally {
        await app.close();
        await mockBase.close();
        await new Promise((resolve) => mockAi.close(resolve));
    }
});
