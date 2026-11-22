// 共享对话（基座版）：成员直接进入同一段对话；署名、同一时间一人提问、退出与停止共享、邀请经基座通知接口下发。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockBaseServer } from './helpers/mock-base.js';

test('共享对话：邀请、接受、同一段对话、署名、退出与停止共享', async () => {
    const mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        BASE_NOTIFY_URL: `${mock.baseUrl}/notify/send`,
        APP_SCHEMA: 'share-test',
        APP_UUID: 'share-test',
        APP_DATASOURCE_ID: '2',
    });
    delete process.env.DH_OPEN_ADMIN;
    delete process.env.DH_ADMIN_USERS;
    const { createServer } = await import('../src/server.js');
    const app = await createServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const call = async (user, method, path, body, name = '') => {
        const headers = { ...(user ? { 'x-dh-user': user } : {}), ...(name ? { 'x-dh-displayname': encodeURIComponent(name) } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) };
        const res = await fetch(`${url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { data = text; }
        return { status: res.status, data };
    };
    const chat = (user, sessionId, text) => call(user, 'POST', '/api/ai/chat', { sessionId, messages: [{ role: 'user', content: text }] });

    try {
        // 三个人各自进过应用：进入目录（a00000001 是管理员——首位访问者）
        await call('a00000001', 'GET', '/api/auth/me', undefined, '张三');
        await call('b00000002', 'GET', '/api/auth/me', undefined, '李四');
        await call('c00000003', 'GET', '/api/auth/me', undefined, '王五');

        // 只带工号、不带姓名的入口不会把已记下的姓名冲掉
        await call('b00000002', 'GET', '/api/auth/me');
        assert.equal((await call('a00000001', 'GET', '/api/shared-conversations/accounts?q=ls')).data.items[0]?.name, '李四');

        // 张三的一段对话（没配模型：落库提问 + 提示回答）
        const first = await chat('a00000001', '', '北美机房切换的风险点');
        const sessionId = first.data.sessionId;
        assert.ok(sessionId);

        // 账号搜索：不含自己；拼音首字母命中显示名
        const accounts = await call('a00000001', 'GET', '/api/shared-conversations/accounts');
        assert.deepEqual(accounts.data.items.map((u) => u.username).sort(), ['b00000002', 'c00000003']);
        assert.deepEqual((await call('a00000001', 'GET', '/api/shared-conversations/accounts?q=ls')).data.items.map((u) => u.name), ['李四']);

        // 别人不能共享、也读不到张三的对话
        assert.equal((await call('b00000002', 'POST', `/api/shared-conversations/session/${sessionId}/prepare`, {})).status, 404);
        assert.equal((await call('b00000002', 'GET', `/api/ai/sessions/${sessionId}/messages`)).status, 404);

        // 常用群组 + 邀请：工号带不带首字母视为同一人；邀请经基座通知接口下发
        const group = await call('a00000001', 'POST', '/api/shared-conversations/groups', { name: '北美组', members: ['c00000003', 'a00000001'] });
        assert.deepEqual(group.data.item.members, ['c00000003']);
        const invited = await call('a00000001', 'POST', `/api/shared-conversations/session/${sessionId}/invite`, { title: '机房切换', usernames: ['00000002'], groupIds: [group.data.item.id], linkBase: 'https://dh.example.test/digital-human/dh/app' });
        assert.equal(invited.status, 200);
        assert.deepEqual(invited.data.invited.sort(), ['b00000002', 'c00000003']);
        assert.deepEqual(invited.data.notified.sort(), ['b00000002', 'c00000003']);
        assert.match(invited.data.share.link, /^\/\?share=/);
        assert.equal((await call('a00000001', 'GET', '/api/shared-conversations/recent')).data.groups[0].name, '北美组');

        // 李四收到邀请并接受：直接进入同一段对话，能读到张三的消息并带署名
        const inbox = await call('b00000002', 'GET', '/api/shared-conversations/inbox');
        assert.equal(inbox.data.items.length, 1);
        assert.equal(inbox.data.items[0].invitedByName, '张三');
        const accepted = await call('b00000002', 'POST', `/api/shared-conversations/invites/${inbox.data.items[0].shareId}/respond`, { action: 'accept' });
        assert.equal(accepted.data.sessionId, sessionId, '没有副本：就是同一段对话');
        const seenByLisi = await call('b00000002', 'GET', `/api/ai/sessions/${sessionId}/messages`);
        assert.equal(seenByLisi.status, 200);
        assert.equal(seenByLisi.data.items[0].events.find((e) => e.type === 'shared_author').name, '张三');

        // 李四接着提问：消息记在李四名下；张三看到李四的署名、自己的消息不带署名
        assert.equal((await chat('b00000002', sessionId, '李四的补充问题')).status, 200);
        const seenByZhang = await call('a00000001', 'GET', `/api/ai/sessions/${sessionId}/messages`);
        const lisiMsg = seenByZhang.data.items.find((m) => m.content === '李四的补充问题');
        assert.equal(lisiMsg.events.find((e) => e.type === 'shared_author').author, 'b00000002');
        assert.ok(!seenByZhang.data.items[0].events?.some((e) => e.type === 'shared_author'));
        // 张三打开时得到「别人发了几条新消息」
        assert.ok((await call('a00000001', 'POST', `/api/shared-conversations/session/${sessionId}/sync`, {})).data.result.pulled >= 2);
        assert.equal((await call('a00000001', 'POST', `/api/shared-conversations/session/${sessionId}/sync`, {})).data.result.pulled, 0);

        // 侧栏：两人都看到这段共享对话
        assert.equal((await call('b00000002', 'GET', '/api/shared-conversations/mine')).data.items[0].sessionId, sessionId);
        assert.equal((await call('a00000001', 'GET', '/api/shared-conversations/mine')).data.items[0].ownerName, '张三');

        // 同一时间只让一个人提问：别人正在提问时返回 409
        const { getSession } = await import('../src/services/ai-service.js');
        const { claimTurn } = await import('../src/services/share-service.js');
        await claimTurn(await getSession(sessionId), 'a00000001', '张三');
        const busy = await chat('b00000002', sessionId, '同时提问');
        assert.equal(busy.status, 409);
        assert.match(busy.data.error, /张三 正在这段共享对话里提问/);
        const { releaseTurn } = await import('../src/services/share-service.js');
        await releaseTurn(sessionId, 'a00000001');

        // 共享对话里的附件（含仅在工具事件里引用的附件）、私有 HTML 工具与模型上下文
        const { saveChatUpload } = await import('../src/services/chat-upload-service.js');
        const { saveCustomTool } = await import('../src/services/custom-tool-service.js');
        const { appendMessage } = await import('../src/services/ai-service.js');
        const { sharedHistory } = await import('../src/services/share-service.js');
        const { toolByName } = await import('../src/agent/tools.js');
        const upContent = await saveChatUpload({ filename: 'spec.md', mimeType: 'text/markdown', buffer: Buffer.from('# Shared Spec'), ownerId: 'a00000001' });
        const upEventOnly = await saveChatUpload({ filename: 'event-report.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2'), ownerId: 'a00000001' });
        // 用非管理员 c00000003 给共享场景下的私有 HTML 工具权限做对照前，先以 b00000002（普通用户，私有可见）发布工具，确认同聊的 a00000001 可看而未加入的 c00000003 不可看
        const privHtmlTool = await saveCustomTool({ name: '私有月报小工具', html: '<!doctype html><html><body>Private Tool</body></html>' }, { username: 'b00000002', isAdmin: false, identified: true });
        assert.equal(privHtmlTool.visibility, 'private');
        await appendMessage(sessionId, 'user', `请看附件 [spec.md](<${upContent.path}>)`, { author: 'a00000001' });
        await appendMessage(sessionId, 'model', `已基于附件生成并发布 [私有月报小工具](${privHtmlTool.href})\n\n（本轮调用工具 1 次：\`read_file\`）`, {
            author: 'b00000002',
            events: [{ type: 'tool_start', callId: 't1', tool: 'read_file', args: { path: upEventOnly.path } }],
        });
        assert.equal((await call('b00000002', 'GET', `/api/agent-files/raw?path=${encodeURIComponent(upContent.path)}`)).status, 200);
        assert.equal((await call('00000002', 'GET', `/api/agent-files/raw?path=${encodeURIComponent(upEventOnly.path)}`)).status, 200, 'shared attachment in tool event is readable even via employee ID alias');
        assert.equal((await call('a00000001', 'GET', `/custom-tools/${privHtmlTool.slug}/raw`)).status, 200, 'owner/member in active share can view private tool linked in chat');
        assert.equal((await call('c00000003', 'GET', `/api/agent-files/raw?path=${encodeURIComponent(upContent.path)}`)).status, 404, 'non-member cannot read shared upload');
        assert.equal((await call('c00000003', 'GET', `/custom-tools/${privHtmlTool.slug}/raw`)).status, 404, 'non-member cannot view private custom tool');

        const readCustomTool = toolByName.get('read_custom_tool');
        const toolReadRes = await readCustomTool.run({ slug: privHtmlTool.slug }, { identity: { username: 'a00000001', isAdmin: true, identified: true } });
        assert.equal(toolReadRes.ok, true);
        assert.match(toolReadRes.content, /Private Tool/);

        const modelHist = await sharedHistory(sessionId, { ownerId: 'a00000001', viewer: 'b00000002' });
        const zhangUser = modelHist.find((m) => m.role === 'user' && m.content.includes(upContent.path));
        assert.match(zhangUser.content, /张三 \(a00000001\)/);
        const zhangAi = await sharedHistory(sessionId, { ownerId: 'a00000001', viewer: 'a00000001' });
        const lisiModelTurn = zhangAi.find((m) => m.role === 'assistant' && m.content.includes(privHtmlTool.href));
        assert.match(lisiModelTurn.content, /共享对话成员 .*b00000002\) 收到的 AI 回复/);
        assert.doesNotMatch(lisiModelTurn.content, /（本轮调用工具/);
        assert.match(lisiModelTurn.content, new RegExp(upEventOnly.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

        // 王五通过链接加入：先成为待接受邀请
        const token = invited.data.share.link.split('share=')[1];
        await call('c00000003', 'POST', `/api/shared-conversations/invites/${inbox.data.items[0].shareId}/respond`, { action: 'ignore' });
        const joined = await call('c00000003', 'POST', `/api/shared-conversations/link/${token}`);
        assert.equal(joined.data.status, 'pending');
        assert.equal((await call('c00000003', 'POST', '/api/shared-conversations/link/not-a-token')).status, 404);

        // 成员删掉对话 = 退出共享，对话本身还在；之后读不到
        assert.equal((await call('b00000002', 'DELETE', `/api/ai/sessions/${sessionId}`)).status, 200);
        assert.equal((await call('b00000002', 'GET', `/api/ai/sessions/${sessionId}/messages`)).status, 404);
        assert.equal((await call('a00000001', 'GET', `/api/ai/sessions/${sessionId}/messages`)).status, 200);

        assert.equal((await call('c00000003', 'POST', `/api/shared-conversations/invites/${invited.data.share.id}/respond`, { action: 'accept' })).data.status, 'accepted');

        // 实时流多端同步验证：Carol 监听该共享对话的 /live 流
        const liveRes = await fetch(`${url}/api/shared-conversations/session/${sessionId}/live`, {
            headers: { 'x-dh-user': 'c00000003' },
        });
        assert.equal(liveRes.status, 200);
        const reader = liveRes.body.getReader();
        const decoder = new TextDecoder();
        let chunk = await reader.read();
        let firstEv = JSON.parse(decoder.decode(chunk.value).trim().split('\n')[0]);
        assert.equal(firstEv.type, 'idle');

        // 张三发起提问并在该会话中流式输出
        const { startLiveStream, pushLiveDelta, pushLiveEvent, endLiveStream, getLiveStream } = await import('../src/services/share-service.js');
        startLiveStream(sessionId, { by: 'a00000001', name: '张三', question: '请分析机房风险' });
        pushLiveDelta(sessionId, '第一点：双路供电');
        pushLiveEvent(sessionId, { type: 'tool_start', tool: 'netcare_query' });

        // Carol 从 reader 接收到事件
        let streamText = '';
        while (!streamText.includes('netcare_query')) {
            const { value } = await reader.read();
            streamText += decoder.decode(value);
        }
        assert.ok(streamText.includes('stream_start'));
        assert.ok(streamText.includes('双路供电'));
        assert.ok(streamText.includes('netcare_query'));

        // 中途新接入者（如新打开该对话的成员）接收 catchup 事件，带已生成的前置文本
        const catchupRes = await fetch(`${url}/api/shared-conversations/session/${sessionId}/live`, {
            headers: { 'x-dh-user': 'c00000003' },
        });
        const catchupReader = catchupRes.body.getReader();
        const catchupChunk = await catchupReader.read();
        const catchupEv = JSON.parse(decoder.decode(catchupChunk.value).trim().split('\n')[0]);
        assert.equal(catchupEv.type, 'catchup');
        assert.equal(catchupEv.by, 'a00000001');
        assert.equal(catchupEv.question, '请分析机房风险');
        assert.equal(catchupEv.text, '第一点：双路供电');
        await catchupReader.cancel();

        // 别人的请求收尾不能掐掉正在进行的流；进行中别人也不能抢着提问（即使 metadata 里没有记录）
        endLiveStream(sessionId, {}, 'c00000003');
        assert.ok(getLiveStream(sessionId), 'endLiveStream by another user must not end the stream');
        await assert.rejects(claimTurn({ id: sessionId }, 'c00000003', '王五', '插队'), (err) => err.code === 409 || err.status === 409 || /正在这段共享对话里提问/.test(err.message));

        // 追流补发的过程事件有上限，超长字段会截断
        for (let i = 0; i < 250; i++) pushLiveEvent(sessionId, { type: 'tool_result', callId: `c${i}`, result: 'x'.repeat(i === 249 ? 9000 : 10) });
        const capped = getLiveStream(sessionId).events;
        assert.equal(capped.length, 200);
        assert.equal(capped.at(-1).callId, 'c249');
        assert.ok(capped.at(-1).result.length < 5000, 'large live event fields are truncated for catch-up');

        // 结束流：围观者先收到 stream_finish（带完整文本），再收到 turn_ended，且只收到一次
        endLiveStream(sessionId, {}, 'a00000001');
        endLiveStream(sessionId, {}, 'a00000001');
        assert.equal(getLiveStream(sessionId), null);
        let tail = '';
        while (!tail.includes('turn_ended')) {
            const { value } = await reader.read();
            tail += decoder.decode(value);
        }
        await new Promise((r) => setTimeout(r, 50));
        const finishEv = tail.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'stream_finish');
        assert.equal(finishEv.text, '第一点：双路供电');
        assert.equal((tail.match(/turn_ended/g) || []).length, 1, 'turn_ended is emitted once');
        await reader.cancel();

        // 发起者停止共享时，仍连着 /live 的成员会收到 revoked 并被断开
        const kickRes = await fetch(`${url}/api/shared-conversations/session/${sessionId}/live`, { headers: { 'x-dh-user': 'c00000003' } });
        const kickReader = kickRes.body.getReader();
        await kickReader.read();

        // 发起者停止共享：链接失效，且双方侧栏共享列表不再保留已停止条目
        assert.deepEqual((await call('a00000001', 'POST', `/api/shared-conversations/session/${sessionId}/leave`, {})).data, { closed: true });
        let kickText = '';
        for (;;) {
            const { value, done } = await kickReader.read();
            if (value) kickText += decoder.decode(value);
            if (done) break;
        }
        assert.match(kickText, /"revoked"/);
        assert.equal((await call('a00000001', 'GET', '/api/shared-conversations/mine')).data.items.length, 0, 'closed share must be removed from /mine');
        assert.equal((await call('c00000003', 'POST', `/api/shared-conversations/link/${token}`)).status, 409);

        const dialogPath = `/api/shared-conversations/session/${sessionId}`;
        assert.equal((await call('a00000001', 'GET', dialogPath)).data.share, null);
        const fresh = (await call('a00000001', 'POST', dialogPath + '/prepare', {})).data.share;
        assert.notEqual(fresh.id, invited.data.share.id);
        assert.notEqual(fresh.link, invited.data.share.link);
        assert.deepEqual(fresh.members.map(m => m.username), ['a00000001']);
        assert.equal((await call('c00000003', 'POST', `/api/shared-conversations/link/${token}`)).status, 409);
        assert.equal((await call('c00000003', 'GET', '/api/shared-conversations/inbox')).data.items.length, 0);
        assert.equal((await call('c00000003', 'GET', `/api/ai/sessions/${sessionId}/messages`)).status, 404);
        const again = await call('a00000001', 'POST', dialogPath + '/invite', { usernames: ['c00000003'] });
        assert.equal(again.data.share.members.find(m => m.username === 'c00000003').status, 'pending');

        // ── 外部能力感知 + 私有 Skill 审批卡片 + 多渠道通知 + 后续全员开放无冲突 ──
        await call('d00000004', 'GET', '/api/auth/me', undefined, '赵六');
        const { saveSkill } = await import('../src/services/skill-service.js');
        await saveSkill(`---
id: bob-priv-skill
name: 李四私有巡检
name_en: Bob Private Skill
description: Only Bob initially
description_en: Only Bob initially
icon: 🔍
---
1. Check private indicators carefully.`, { createdBy: 'b00000002' });

        // 开启新共享对话（Alice 发起，成员 Bob 和 Carol；Dave 不在共享内）
        const capChat = await chat('a00000001', '', '新建一个排障会话');
        const capSessionId = capChat.data.sessionId;
        await appendMessage(capSessionId, 'user', '请执行 @bob-priv-skill 检查库', { author: 'b00000002' });
        await appendMessage(capSessionId, 'model', '已运行 @bob-priv-skill', {
            author: 'b00000002',
            events: [
                { type: 'skills', skills: ['bob-priv-skill'] },
                { type: 'tool_start', callId: 't_w', tool: 'insert_database_row', args: { table: 'metrics' } },
            ],
        });
        await call('a00000001', 'POST', `/api/shared-conversations/session/${capSessionId}/invite`, {
            title: '私有技能协作', usernames: ['b00000002', 'c00000003'], linkBase: 'https://dh.example.com/app',
        });
        const bobInv2 = await call('b00000002', 'GET', '/api/shared-conversations/inbox');
        await call('b00000002', 'POST', `/api/shared-conversations/invites/${bobInv2.data.items[0].shareId}/respond`, { action: 'accept' });
        const carolInv2 = await call('c00000003', 'GET', '/api/shared-conversations/inbox');
        await call('c00000003', 'POST', `/api/shared-conversations/invites/${carolInv2.data.items[0].shareId}/respond`, { action: 'accept' });

        // Carol 看到缺失的 @bob-priv-skill（可申请）和受限的 insert_database_row 工具
        const carolSessionInfo = await call('c00000003', 'GET', `/api/shared-conversations/session/${capSessionId}`);
        assert.equal(carolSessionInfo.status, 200);
        const missingSkill = carolSessionInfo.data.share.missingCapabilities.skills.find((s) => s.id === 'bob-priv-skill');
        assert.ok(missingSkill && missingSkill.canRequest && missingSkill.owner === 'b00000002');
        assert.ok(carolSessionInfo.data.share.missingCapabilities.tools.some((t) => t.name === 'insert_database_row'));
        assert.ok(!(await call('c00000003', 'GET', '/api/ai/skills')).data.items.some((s) => s.id === 'bob-priv-skill'));

        // Carol 发起申请 -> 触发多渠道通知（站内消息中心 + 基座应用号 jump_url + 基座邮件）
        const beforeNotifyCount = mock.notifications.length;
        const reqSkill = await call('c00000003', 'POST', `/api/shared-conversations/session/${capSessionId}/skill-requests`, {
            skillId: 'bob-priv-skill', linkBase: 'https://dh.example.com/app',
        });
        assert.equal(reqSkill.status, 200);
        assert.equal(reqSkill.data.request.status, 'pending');
        assert.ok(reqSkill.data.notificationSummary.inAppAlert >= 1);

        const newNotifies = mock.notifications.slice(beforeNotifyCount);
        assert.ok(newNotifies.some((n) => n.msg_type === '2' && n.app_msg_params?.to_user_account === 'b00000002' && /share=/.test(n.app_msg_params?.jump_url || '')), 'sends app msg with jump_url');
        assert.ok(newNotifies.some((n) => n.msg_type === '1' && n.email_params?.email_to === 'b00000002'), 'sends email notification to skill owner');

        const bobAlerts = await call('b00000002', 'GET', '/api/alert-center/events');
        assert.ok(bobAlerts.data.events.some((e) => e.object_type === 'shared_skill_request' && e.object_id === reqSkill.data.request.id));

        // 重复申请不产生第二条 pending
        const dupReq = await call('c00000003', 'POST', `/api/shared-conversations/session/${capSessionId}/skill-requests`, { skillId: 'bob-priv-skill' });
        assert.equal(dupReq.data.deduplicated, true);

        // Carol（非归属人/非超管）不能自行批准
        assert.equal((await call('c00000003', 'POST', `/api/shared-conversations/skill-requests/${reqSkill.data.request.id}/respond`, { action: 'approve' })).status, 403);

        // Bob 在收件箱看到待审批卡片并同意
        const bobApprovalInbox = await call('b00000002', 'GET', '/api/shared-conversations/inbox');
        assert.equal(bobApprovalInbox.data.skillRequests.length, 1);
        const approved = await call('b00000002', 'POST', `/api/shared-conversations/skill-requests/${reqSkill.data.request.id}/respond`, { action: 'approve' });
        assert.equal(approved.status, 200);
        assert.equal(approved.data.status, 'approved');
        assert.equal(approved.data.grantedCount, 3);

        // 审批后：Carol 获得该共享对话内的 Skill 访问权，而对话外人员 Dave 仍不可见，且未开启全员开放
        const carolSkillsNow = (await call('c00000003', 'GET', '/api/ai/skills')).data.items.filter((s) => s.id === 'bob-priv-skill');
        assert.equal(carolSkillsNow.length, 1);
        assert.equal(carolSkillsNow[0].sharedAccess, false);
        assert.equal(carolSkillsNow[0].sharedViaConversation, true);
        assert.ok(!(await call('d00000004', 'GET', '/api/ai/skills')).data.items.some((s) => s.id === 'bob-priv-skill'));
        // Carol 收到审批通过消息通知
        const carolAlerts = await call('c00000003', 'GET', '/api/alert-center/events');
        assert.ok(carolAlerts.data.events.some((e) => e.object_id === reqSkill.data.request.id && /通过/.test(e.title)));

        // 后续管理员将 bob-priv-skill 设为全员开放：Carol 仍只有 1 条记录且自然切换为 sharedAccess=true，无重复
        const { setShared } = await import('../src/services/distribution-service.js');
        await setShared('skill', 'bob-priv-skill', true);
        const carolSkillsPublic = (await call('c00000003', 'GET', '/api/ai/skills')).data.items.filter((s) => s.id === 'bob-priv-skill');
        assert.equal(carolSkillsPublic.length, 1);
        assert.equal(carolSkillsPublic[0].sharedAccess, true);
        assert.ok(!carolSkillsPublic[0].sharedViaConversation);
        assert.ok((await call('d00000004', 'GET', '/api/ai/skills')).data.items.some((s) => s.id === 'bob-priv-skill'));

        // 对方拒绝共享对话邀请时，发起共享者可在消息中心收到通知
        const inviteDecline = await call('a00000001', 'POST', `/api/shared-conversations/session/${capSessionId}/invite`, { title: '私有技能协作', usernames: ['d00000004'] });
        assert.equal(inviteDecline.status, 200);
        const declined = await call('d00000004', 'POST', `/api/shared-conversations/invites/${inviteDecline.data.share.id}/respond`, { action: 'decline' });
        assert.equal(declined.status, 200);
        assert.equal(declined.data.status, 'declined');
        const aliceDeclineAlerts = await call('a00000001', 'GET', '/api/alert-center/events');
        assert.ok(aliceDeclineAlerts.data.events.some((e) => e.object_id === inviteDecline.data.share.id && /拒绝了共享对话邀请/.test(e.title)));

        // 非发起者删除共享对话 = 退出共享，不影响发起者；发起者删除原对话 = 关闭共享并从双方列表移除
        const carolDel = await call('c00000003', 'DELETE', `/api/ai/sessions/${capSessionId}`);
        assert.equal(carolDel.status, 200);
        assert.equal((await call('c00000003', 'GET', '/api/shared-conversations/mine')).data.items.some((i) => i.sessionId === capSessionId), false);
        assert.equal((await call('a00000001', 'GET', `/api/ai/sessions/${capSessionId}/messages`)).status, 200);
        const invRe = await call('a00000001', 'POST', `/api/shared-conversations/session/${capSessionId}/invite`, { title: '私有技能协作', usernames: ['c00000003'] });
        assert.equal(invRe.status, 200);
        await call('c00000003', 'POST', `/api/shared-conversations/invites/${invRe.data.share.id}/respond`, { action: 'accept' });
        const ownerDel = await call('a00000001', 'DELETE', `/api/ai/sessions/${capSessionId}`);
        assert.equal(ownerDel.status, 200);
        assert.equal((await call('c00000003', 'GET', '/api/shared-conversations/mine')).data.items.some((i) => i.sessionId === capSessionId), false);
    } finally {
        await app.close();
        await mock.close?.();
    }
});
