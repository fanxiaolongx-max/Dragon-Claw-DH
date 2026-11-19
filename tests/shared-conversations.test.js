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
        const { claimTurn } = await import('../src/services/share-service.js');
        const { getSession } = await import('../src/services/ai-service.js');
        await claimTurn(await getSession(sessionId), 'a00000001', '张三');
        const busy = await chat('b00000002', sessionId, '同时提问');
        assert.equal(busy.status, 409);
        assert.match(busy.data.error, /张三 正在这段共享对话里提问/);
        const { releaseTurn } = await import('../src/services/share-service.js');
        await releaseTurn(sessionId, 'a00000001');

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

        // 发起者停止共享：链接失效
        assert.deepEqual((await call('a00000001', 'POST', `/api/shared-conversations/session/${sessionId}/leave`, {})).data, { closed: true });
        assert.equal((await call('c00000003', 'POST', `/api/shared-conversations/link/${token}`)).status, 409);
    } finally {
        await app.close();
        await mock.close?.();
    }
});
