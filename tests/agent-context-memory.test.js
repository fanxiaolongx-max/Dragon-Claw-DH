// 智能体上下文管理、主题隔离、历史取证、按需记忆筛选与循环可靠性测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockBaseServer } from './helpers/mock-base.js';

const as = (user) => ({ cookie: `iLearningXUserName=${user}` });
const json = (headers = {}) => ({ 'Content-Type': 'application/json', ...headers });

test('topic-context: 主题切换隔离、切回原主题、约束原话保留与模糊指代消歧', async () => {
    const {
        startsIndependentTopic,
        activeTopicRows,
        topicQuery,
        retainUserConstraints,
        summaryForTurn,
    } = await import('../src/agent/topic-context.js');

    assert.equal(startsIndependentTopic('换个话题，帮我写一封邮件'), true);
    assert.equal(startsIndependentTopic('换个话题，但沿用刚才的表格'), false);

    const u = (content) => ({ role: 'user', content });
    const old = [u('海棠月报只统计关闭工单'), { role: 'assistant', content: '共 12 张。' }];
    const detour = [u('换个话题，草拟催办邮件'), { role: 'assistant', content: '邮件草稿完成。' }];
    assert.deepEqual(activeTopicRows(old, '换个话题，翻译单词'), []);
    assert.deepEqual(activeTopicRows([...old, ...detour], '继续'), detour);
    assert.deepEqual(activeTopicRows([...old, ...detour], '回到刚才的月报'), old);

    const repeated = [u('海棠月报分母12'), ...detour, u('回到海棠月报'), u('更正，分母是11'), u('换个话题，翻译诗歌')];
    assert.deepEqual(activeTopicRows(repeated, '回到海棠月报'), [repeated[0], repeated[3], repeated[4]]);

    const three = [...old, ...detour, u('换个话题，翻译诗歌')];
    assert.deepEqual(activeTopicRows(three, '回到之前那个'), []);
    assert.deepEqual(activeTopicRows(three, '回到一个不存在的主题'), []);

    const contHistory = ['整理展览通知', '继续', '接着来'].map(u);
    assert.equal(topicQuery('请继续', contHistory), '整理展览通知');
    assert.equal(topicQuery('继续翻译这句话', contHistory), '继续翻译这句话');

    const saved = retainUserConstraints('## 邮件\n带伞\n## 月报\n已关闭12张', [{ role: 'user', id: 'm1', content: '青禾组月报仅统计已关闭的工单' }]);
    assert.match(summaryForTurn(saved, '月报'), /用户原话依据：\[m1\] 青禾组月报仅统计已关闭的工单/);
    assert.doesNotMatch(summaryForTurn(saved, '邮件'), /青禾/);

    const twoProjects = '## 海棠项目\n预算12万\n## 紫藤项目\n预算6万';
    assert.equal(summaryForTurn(twoProjects, '刚才那个项目预算多少', [u('先看紫藤项目')]), '## 紫藤项目\n预算6万');
    const ambiguous = summaryForTurn(twoProjects, '刚才那个项目预算多少', []);
    assert.match(ambiguous, /海棠.*紫藤/);
    assert.doesNotMatch(ambiguous, /12万|6万/);
});

test('context-stats & memory-service & history-evidence & agent-loop 集成验证', async () => {
    const mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        APP_SCHEMA: 'ctx-mem-test',
        APP_UUID: 'ctx-mem-test',
        APP_DATASOURCE_ID: '2',
    });
    delete process.env.DH_OPEN_ADMIN;
    delete process.env.DH_ADMIN_USERS;

    const { windowFor, compactThreshold, fitMessages, estimateTokens } = await import('../src/agent/context-stats.js');
    assert.equal(windowFor('gemini-2.5-pro', 64000), 1_000_000);
    assert.equal(windowFor('claude-sonnet-4-6', 0), 200_000);
    assert.equal(windowFor('custom-model', 32000), 32000);
    assert.ok(compactThreshold(128000, 4096) < 128000);

    assert.equal(estimateTokens('字'.repeat(100)), 150);
    const longResult = 'A'.repeat(18000);
    const msgs = [
        { role: 'user', content: '第一轮问题' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'query_database', args: {} }] },
        { role: 'tool', toolCallId: 'c1', name: 'query_database', content: longResult },
        { role: 'assistant', content: '第一轮结论' },
        { role: 'user', content: '第二轮问题' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'read_file', args: {} }] },
        { role: 'tool', toolCallId: 'c2', name: 'read_file', content: longResult },
    ];
    const fitted = fitMessages({ model: 'gpt-4', contextWindow: 8192, systemPrompt: 'system', messages: msgs, tools: [], maxOutputTokens: 1024 });
    // 成对约束：保留的每条 tool 消息前一定存在对应 toolCallId 的 assistant
    for (let i = 0; i < fitted.messages.length; i += 1) {
        const m = fitted.messages[i];
        if (m.role === 'tool') {
            const hasPair = fitted.messages.slice(0, i).some((prev) => prev.role === 'assistant' && prev.toolCalls?.some((c) => c.id === m.toolCallId));
            assert.equal(hasPair, true, '不能拆分 assistant(toolCalls) 与 tool 结果配对');
        }
    }
    assert.equal(fitted.messages.at(-1)?.role, 'tool');
    const parallel = [{ role: 'user', content: '核对两个结果' },
        {role:'assistant', toolCalls:[{id:'a'},{id:'b'}]},
        ...['a','b'].map(id=>({role:'tool',toolCallId:id,content:longResult}))];
    assert.deepEqual(fitMessages({model:'gpt-4',contextWindow:8192,messages:parallel}).messages.map(m=>m.role),
        ['user','assistant','tool','tool']);

    const { changeMemory, listMemories, selectMemoriesForPrompt } = await import('../src/services/memory-service.js');
    const { saveSession, appendMessage, getSession, listMessages } = await import('../src/services/ai-service.js');
    const { lookup } = await import('../src/agent/history-evidence.js');
    const { prepareContext, compactLoopMessages } = await import('../src/services/conversation-service.js');
    const { createServer } = await import('../src/server.js');
    const app = await createServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${app.server.address().port}`;

    const chat = async (user, body) => {
        const res = await fetch(`${url}/api/ai/chat`, {
            method: 'POST',
            headers: json(as(user)),
            body: JSON.stringify({ stream: true, ...body }),
        });
        assert.equal(res.status, 200);
        return (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    };
    const streamReqs = () => mock.aiRequests.filter((r) => r.stream);

    try {
        await fetch(`${url}/api/auth/me`, { headers: as('alice') });
        await fetch(`${url}/api/ai-settings/profiles`, {
            method: 'POST',
            headers: json(as('alice')),
            body: JSON.stringify({ name: 'MockLLM', baseUrl: `${mock.baseUrl}/v1`, apiKey: 'sk-ctx-secret-999', model: 'test-model', activate: true }),
        });

        // 1. memory-service：topic 写入、去重、脱敏过滤与按主题召回
        const m1 = await changeMemory('alice', { action: 'add', content: '海棠月报固定按自然月统计', topic: '海棠月报' });
        const m2 = await changeMemory('alice', { action: 'add', content: '银杏快递固定按周四统计', topic: '银杏快递' });
        const m3 = await changeMemory('alice', { action: 'add', content: '默认使用中文回复' });
        const m4 = await changeMemory('alice', { action: 'add', content: '始终附带来源编号', topic: '*' });
        assert.ok(m1.item.id && m2.item.id && m3.item.id && m4.item.id);
        const dup = await changeMemory('alice', { action: 'add', content: '海棠月报固定按自然月统计', topic: '海棠月报' });
        assert.equal(dup.deduplicated, true);
        assert.equal((await listMemories('alice')).length, 4);

        const unrelatedPrompt = await selectMemoriesForPrompt('alice', '你好');
        assert.equal(unrelatedPrompt.some((m) => m.topic === '海棠月报'), false, '无关问题不注入专题记忆');
        assert.equal(unrelatedPrompt.some((m) => m.content === '默认使用中文回复'), true);
        assert.equal(unrelatedPrompt.some((m) => m.topic === '*'), true);

        const haitangPrompt = await selectMemoriesForPrompt('alice', '请看海棠月报的数据');
        assert.equal(haitangPrompt[0].topic, '海棠月报', '中文主题精确匹配应优先排在最前');
        assert.equal(haitangPrompt.some((m) => m.topic === '银杏快递'), false);

        await changeMemory('alice', {action:'add', topic:'松墨样刊', content:'标题以 SM-47 开头'});
        for (const [question, expected] of [['给松墨样刊拟标题', true], ['给食堂菜单拟标题', false]]) {
            await chat('alice', { messages: [{role:'user',content:question}] });
            const request = streamReqs().at(-1);
            assert.equal(request.messages.find(m => m.role === 'system').content.includes('SM-47'), expected);
        }
        // 同一账号的两个独立写入，包括首次初始化，均须保留。
        const writes = await Promise.all(['并行第一条', '并行第二条'].map(content =>
            changeMemory('parallel-user', { action: 'add', topic: '并发验收', content })));
        assert.notEqual(writes[0].item.id, writes[1].item.id);
        assert.deepEqual((await listMemories('parallel-user')).map(row => row.content).sort(), ['并行第一条', '并行第二条'].sort());

        const turnWithMemory = async (text, args) => {
            mock.aiScript.push({toolCalls: [{name:'memory', args}]}, {text:'完成。'});
            return chat('alice', {messages:[{role:'user', content:text}]});
        };
        const created = await turnWithMemory('请记住研修刊使用 XZ-1。', {action:'add',topic:'研修刊',content:'使用 XZ-1'});
        const origin = created.find(e => e.type === 'done').sessionId;
        const {id} = (await listMemories('alice')).find(row => row.topic === '研修刊');
        await turnWithMemory('这期不用前缀', {action:'update',id,content:'不加前缀'});
        assert.equal((await listMemories('alice')).find(row => row.id === id).content, '使用 XZ-1');
        await turnWithMemory('以后研修刊改为 XZ-2。', {action:'update',id,content:'使用 XZ-2'});
        const inspect = async (user='alice', ctx={}) => (await changeMemory(user,{action:'source', id}, ctx)).source;
        const sourceEvents = await turnWithMemory('白桦以外，请核对研修刊长期偏好的真实出处。', {action:'source', id});
        assert.ok(sourceEvents.some(e => e.type === 'tool_result' && e.tool === 'memory' && e.ok));
        const toolReport = JSON.parse(streamReqs().at(-1).messages.findLast(m => m.role === 'tool').content);
        assert.equal(toolReport.recordedChanges, 1);
        assert.equal(toolReport.versions[1].source.quote, '以后研修刊改为 XZ-2。');
        const report = await inspect();
        assert.equal(report.recordedChanges, 1);
        const versions = report.versions;
        assert.deepEqual(versions.map(entry=>[entry.version,entry.current,entry.source.quote]),[
            [1,false,'请记住研修刊使用 XZ-1。'],[2,true,'以后研修刊改为 XZ-2。']]);
        assert.match(await inspect('alice',{isShared:true}), /个人对话/);
        await assert.rejects(inspect('unrelated-user'), /没有编号/);
        await (await import('../src/services/ai-service.js')).deleteSession(origin);
        assert.match((await inspect()).versions[0].source, /来源已删除/);
        await turnWithMemory('忘掉研修刊这条测试偏好。', {action:'delete', id});
        assert.ok(!(await selectMemoriesForPrompt('alice','研修刊')).some(row=>row.id===id));
        await assert.rejects(inspect(), /没有编号/);

        // 2. history-evidence：最初值、最近更正、项目隔离、边界与脱敏
        const sid = 'sess-evidence-1';
        await saveSession({ id: sid, ownerId: 'alice', title: '核对' });
        await appendMessage(sid, 'user', '青禾项目预算为35万元');
        for (let i = 0; i < 50; i += 1) {
            await appendMessage(sid, 'user', `青禾项目预算更正为${20 + i}万元`);
        }
        await appendMessage(sid, 'user', '云杉项目预算更正为88万元，秘钥 sk-ctx-secret-999');
        await appendMessage(sid, 'model', '已读取', {
            events: [{ type: 'tool_result', ok: true, callId: 'c-read', tool: 'read_file', output: '海棠项目专用回执 HT-6031 已确认' }],
        });

        const evRes = await lookup({ sessionId: sid, question: '青禾项目最初和现在的预算是多少？', secrets: ['sk-ctx-secret-999'] });
        assert.match(evRes, /35万元/);
        assert.match(evRes, /69万元/);
        assert.doesNotMatch(evRes, /88万元/);
        assert.doesNotMatch(evRes, /sk-ctx-secret-999/);

        const receiptRes = await lookup({ sessionId: sid, question: '海棠项目的回执是什么？' });
        assert.match(receiptRes, /HT-6031/);
        assert.equal(await lookup({ sessionId: sid, question: '写一首诗' }), '');

        // 通过真正的 read_file 调用入库，再从另一次请求使用这次读过的范围。
        const {saveChatUpload} = await import('../src/services/chat-upload-service.js');
        const file = await saveChatUpload({filename:'演练.txt',mimeType:'text/plain',ownerId:'alice',
            buffer:Buffer.from('日常流水。\n'.repeat(90) + '海棠项目回执 HT-8422\n' + '继续流水。\n'.repeat(90) + '远山项目回执 YS-1234')});
        mock.aiScript.push({toolCalls:[{name:'read_file',args:{path:file.path,limit:1000}}]}, {text:'读完。'});
        const events = await chat('alice',{messages:[{role:'user',content:'请阅读演练附件'}]});
        const fileSession = events.find(e=>e.type==='done').sessionId;
        assert.ok(events.some(e=>e.type==='tool_result' && e.tool==='read_file' && e.ok));
        const askFile = (viewer,project)=>lookup({sessionId:fileSession,viewer,question:project+'项目的回执是什么？'});
        assert.match(await askFile('alice','海棠'), /HT-8422/);
        assert.doesNotMatch(await askFile('alice','远山'), /YS-1234/);
        assert.doesNotMatch(await askFile('bob','海棠'), /HT-8422/);

        // 3. prepareContext + retainUserConstraints + compactLoopMessages
        const longSid = 'sess-compact-1';
        await saveSession({ id: longSid, ownerId: 'alice', title: '长会话', pinned: true });
        const longHistory = [];
        for (let i = 0; i < 28; i += 1) {
            const msg = { role: i % 2 ? 'assistant' : 'user', content: i === 0 ? '海棠项目仅统计关闭工单。' : `第 ${i} 条${'记录 '.repeat(80)}` };
            await appendMessage(longSid, msg.role === 'assistant' ? 'model' : 'user', msg.content);
            longHistory.push(msg);
        }
        mock.aiRequests.length = 0;
        mock.options.completionText = '## 海棠项目\n已确认规则';
        const prep = await prepareContext({
            sessionId: longSid,
            history: [...longHistory.slice(-3), { role: 'user', content: '海棠项目怎么算' }],
            settings: { baseUrl: `${mock.baseUrl}/v1`, apiKey: 'sk-ctx-secret-999', model: 'test-model' },
            emit: () => {},
            secrets: ['sk-ctx-secret-999'],
        });
        assert.match(prep.summary, /仅统计关闭工单/, '同主题回归时摘要应保留用户约束原话');
        const afterCompaction = await getSession(longSid);
        assert.equal(afterCompaction.title, '长会话');
        assert.equal(afterCompaction.pinned, true);
        assert.match(afterCompaction.summary, /## 海棠项目/);
        const switchedPrep = await prepareContext({
            sessionId: longSid,
            history: [...longHistory.slice(-3), { role: 'user', content: '换个话题，把 blue 翻译成中文' }],
            settings: { baseUrl: `${mock.baseUrl}/v1`, apiKey: 'sk-ctx-secret-999', model: 'test-model' },
            emit: () => {},
        });
        assert.equal(switchedPrep.summary, '', '显式切换新话题时不带出旧主题摘要');

        mock.options.completionText = '## 工具摘要\n已完成检索';
        const loopCompacted = await compactLoopMessages({
            settings: { baseUrl: `${mock.baseUrl}/v1`, apiKey: 'sk-ctx-secret-999', model: 'test-model' },
            messages: [
                { role: 'user', content: '核对数据' },
                { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'calculate', args: {} }] },
                { role: 'tool', toolCallId: 't1', name: 'calculate', content: 'Z'.repeat(4000) },
                { role: 'assistant', content: '拿到第一步结果' },
                { role: 'user', content: '继续' },
                { role: 'assistant', content: '', toolCalls: [{ id: 't2', name: 'calculate', args: {} }] },
                { role: 'tool', toolCallId: 't2', name: 'calculate', content: 'W'.repeat(6000) },
            ],
            task: '核对数据',
            windowTokens: 2000,
        });
        delete mock.options.completionText;
        assert.ok(loopCompacted && loopCompacted.messages.some((m) => /自动压缩/.test(m.content)));
        assert.equal((await listMessages(longSid)).length, 28);

        // 前端只给最近几条（无数据库 ID）。跨过 500 条仍要取到真实换题边界。
        const pageSid = 'paged-context';
        await saveSession({id:pageSid, ownerId:'alice', title:'翻页验证'});
        const {insertRow} = await import('../src/dao/scoped.js');
        for (let i = 0; i < 503; i++) {
            const content = i === 0 ? '项目回执 OLD-111' : i === 500 ? '换个话题，开始第二批' :
                i === 501 ? '此次回执 NEW-522' : i === 502 ? '回执是多少？' : '继续核验';
            await insertRow('ai_chat_messages', {session_id:pageSid, role:'user', content});
        }
        const full = await listMessages(pageSid);
        assert.equal(full.length,503);
        await saveSession({id:pageSid, metadata:{summarizedCount:500}});
        const prepared = await prepareContext({sessionId:pageSid, history:full.slice(-3).map(({role,content})=>({role,content})),
            settings:{model:'test-model'},emit:()=>{}});
        assert.equal(prepared.sinceSeq,500);
        const scoped = await lookup({sessionId:pageSid,question:'回执是多少？',sinceSeq:prepared.sinceSeq});
        assert.match(scoped,/NEW-522/);
        assert.doesNotMatch(scoped,/OLD-111/);
        assert.match(await lookup({sessionId:pageSid,question:'银杏项目的回执是多少？'}),/没有找到可核对/);

        // 4. loop.js: emptyNudges 空回复重试 + update_plan 自动收尾为 completed
        mock.aiRequests.length = 0;
        mock.aiScript.push(
            { toolCalls: [
                { name: 'update_plan', args: { items: [{ content: '算比例', status: 'in_progress' }, { content: '给结论', status: 'pending' }] } },
                { name: 'calculate', args: { expression: '100/4' } },
            ] },
            { text: '   ' }, // 首次空回复触发一次 nudge
            { text: '计算结果是 25。' },
        );
        const loopEvents = await chat('alice', { messages: [{ role: 'user', content: '算一下 100 除以 4' }] });
        const planEvents = loopEvents.filter((e) => e.type === 'plan');
        assert.ok(planEvents.length >= 2, '应在结束前自动补发 completed 的任务清单');
        assert.equal(planEvents.at(-1).items.every((i) => i.status === 'completed'), true);
        assert.match(loopEvents.find((e) => e.type === 'done').reply, /25/);
        assert.equal(streamReqs().length, 3);
    } finally {
        await app.close();
        await mock.close();
    }
});
