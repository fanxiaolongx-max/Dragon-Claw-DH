// 对话查平台数据的边界：页面配置（read_page_config）、按页面权限收窄可查的表、查自己的历史对话。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockBaseServer } from './helpers/mock-base.js';

let mock;
let app;
before(async () => {
    mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        APP_SCHEMA: 'datatools',
        APP_UUID: 'datatools',
        APP_DATASOURCE_ID: '2',
    });
    delete process.env.BUSINESS_DATASOURCE_NAME;
    delete process.env.DH_OPEN_ADMIN;
    delete process.env.DH_ADMIN_USERS;
    const { createServer } = await import('../src/server.js');
    app = await createServer();
});
after(async () => { await app?.close(); await mock?.close(); });

const admin = { username: 'alice', isAdmin: true, identified: true };
const bob = { username: 'bob', isAdmin: false, identified: true };
const carol = { username: 'carol', isAdmin: false, identified: true };

async function tools() {
    const { toolByName } = await import('../src/agent/tools.js');
    return (name, args, identity, extra = {}) => toolByName.get(name).run(args, { identity, secrets: [], ...extra });
}
const parse = (out) => JSON.parse(out.content);

test('页面配置：白名单内可读、密钥字段隐藏、跟着页面权限走、敏感键永不开放', async () => {
    const run = await tools();
    const { kvSet, kvGet } = await import('../src/dao/scoped.js');
    const { sharedKeys } = await import('../src/services/distribution-service.js');
    await kvSet('expedite_notify_directory', { roster: [{ name: '张三', empId: 'a001' }, { name: '李四', empId: 'a002' }], webhook: { url: 'https://x', token: 'tok-1234567890' } });
    await kvSet('dh_admins', ['alice']);
    await kvSet('distribution_shared', [...(await sharedKeys())]);

    const listed = parse(await run('read_page_config', {}, bob));
    assert.ok(listed.configs.some((c) => c.key === 'expedite_notify_directory'), '普通账号能看到开放页面的配置');
    assert.ok(!listed.configs.some((c) => c.key === 'distribution_shared'), '管理员专属的配置不出现在普通账号列表里');

    const read = parse(await run('read_page_config', { key: 'expedite_notify_directory' }, bob));
    assert.equal(read.value.roster.length, 2);
    assert.equal(read.value.webhook.token, '[已隐藏]', '键名像令牌的字段被隐藏');
    const sub = parse(await run('read_page_config', { key: 'expedite_notify_directory', path: 'roster', limit: 1 }, bob));
    assert.deepEqual(sub.value, [{ name: '张三', empId: 'a001' }]);
    assert.equal(sub.nextOffset, 1);
    assert.equal((await run('read_page_config', { key: 'expedite_notify_directory', path: 'nope.x' }, bob)).ok, false);

    for (const key of ['dh_admins', 'dh_identity_verify', 'ai_conversation_list:bob', 'sys_kv_store']) {
        const out = await run('read_page_config', { key }, admin);
        assert.equal(out.ok, false, `${key} 永不开放`);
    }
    assert.equal((await run('read_page_config', { key: 'distribution_shared' }, bob)).ok, false, '普通账号读不了管理员配置');
    assert.equal((await run('read_page_config', { key: 'distribution_shared' }, admin)).ok, true);

    // 一键催办页收回全员开放：普通账号读不到它的配置，管理员不受影响
    const keys = new Set(await kvGet('distribution_shared', []));
    keys.delete('page:expedite');
    await kvSet('distribution_shared', [...keys]);
    const denied = await run('read_page_config', { key: 'expedite_notify_directory' }, bob);
    assert.equal(denied.ok, false);
    assert.match(denied.content, /页面没有对你开放/);
    assert.equal((await run('read_page_config', { key: 'expedite_notify_directory' }, admin)).ok, true);
    keys.add('page:expedite');
    await kvSet('distribution_shared', [...keys]);
});

test('通用查库：表跟着页面权限走，键值表、对话表、管理员表普通账号都查不到', async () => {
    const run = await tools();
    const { kvSet, kvGet } = await import('../src/dao/scoped.js');
    const { allowedTablesFor } = await import('../src/agent/tools.js');

    const bobTables = await allowedTablesFor(bob);
    assert.ok(bobTables.has('report_metric_data'));
    assert.ok(bobTables.has('sla_config_items'), '新开放的数据导入规则表');
    assert.ok(!bobTables.has('platform_metrics_events'), '使用埋点仅管理员');
    assert.ok((await allowedTablesFor(admin)).has('platform_metrics_events'));

    for (const sql of ['SELECT * FROM sys_kv_store', 'SELECT * FROM ai_chat_messages', 'SELECT * FROM ai_settings_profiles', 'SELECT * FROM biz_records', 'SELECT * FROM platform_metrics_events']) {
        const out = await run('query_database', { sql }, bob);
        assert.equal(out.ok, false, `${sql} 应被拒绝`);
    }
    assert.equal((await run('query_database', { sql: 'SELECT * FROM report_metric_data' }, bob)).ok, true);

    // 数据导入页收回：sla_* 表对普通账号关闭，报表表仍可查
    const keys = new Set(await kvGet('distribution_shared', []));
    keys.delete('page:sla');
    await kvSet('distribution_shared', [...keys]);
    assert.equal((await run('query_database', { sql: 'SELECT * FROM sla_targets' }, bob)).ok, false);
    assert.equal((await run('read_database_table', { table: 'sla_targets' }, bob)).ok, false);
    assert.equal((await run('database_schema', { table: 'sla_targets' }, bob)).ok, false);
    assert.equal((await run('query_database', { sql: 'SELECT * FROM sla_targets' }, admin)).ok, true);
    keys.add('page:sla');
    await kvSet('distribution_shared', [...keys]);
});

test('我的历史对话：只搜本人和已加入的共享对话，别人的读不到', async () => {
    const run = await tools();
    const { saveSession, appendMessage } = await import('../src/services/ai-service.js');
    const share = await import('../src/services/share-service.js');
    const mk = async (id, owner, title, pairs) => {
        await saveSession({ id, ownerId: owner, title });
        for (const [role, content] of pairs) await appendMessage(id, role, content, { author: owner });
    };
    await mk('chat_bob_1', 'bob', '催办配置', [['user', '一键催办的接收人怎么配置'], ['model', '在催办通讯录里配置 roster']]);
    await mk('chat_bob_2', 'bob', '算数', [['user', '3 加 5 等于几'], ['model', '等于 8，api_key=sk-abcdefghijklmnopqrstuvwxyz']]);
    await mk('chat_carol_1', 'carol', '私密', [['user', 'carol 的私密问题 一键催办'], ['model', 'carol 的回答']]);
    await mk('chat_carol_shared', 'carol', '共享评审', [['user', '共享里的催办讨论'], ['model', '共享回答']]);

    const all = parse(await run('search_my_conversations', {}, bob));
    assert.deepEqual(all.sessions.map((s) => s.sessionId).sort(), ['chat_bob_1', 'chat_bob_2']);

    const found = parse(await run('search_my_conversations', { query: '一键催办 接收人' }, bob));
    assert.deepEqual(found.sessions.map((s) => s.sessionId), ['chat_bob_1'], '每个关键词都要命中，且只搜本人');
    assert.match(found.sessions[0].matches[0].text, /一键催办/);
    assert.equal(parse(await run('search_my_conversations', { query: '私密问题' }, bob)).sessions.length, 0);

    const read = parse(await run('read_my_conversation', { sessionId: 'chat_bob_2' }, bob, { sessionId: 'chat_bob_2' }));
    assert.deepEqual(read.messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(read.isCurrentConversation, true);
    assert.doesNotMatch(JSON.stringify(read), /sk-abcdefghijklmnopqrstuvwxyz/, '密钥被隐藏');

    const denied = await run('read_my_conversation', { sessionId: 'chat_carol_1' }, bob);
    assert.equal(denied.ok, false);
    assert.doesNotMatch(denied.content, /私密/);

    // carol 把一个对话共享给 bob，bob 接受后能搜到、能读；没登录的身份不能查
    await share.invite({ user: 'carol', sessionId: 'chat_carol_shared', title: '共享评审', usernames: ['bob'] });
    const invite = (await share.inbox('bob'))[0];
    await share.respond({ user: 'bob', shareId: invite.shareId, action: 'accept' });
    const withShared = parse(await run('search_my_conversations', { query: '催办' }, bob));
    assert.deepEqual(withShared.sessions.map((s) => s.sessionId).sort(), ['chat_bob_1', 'chat_carol_shared']);
    assert.equal(withShared.sessions.find((s) => s.sessionId === 'chat_carol_shared').shared, true);
    assert.equal((await run('read_my_conversation', { sessionId: 'chat_carol_shared' }, bob)).ok, true);
    assert.equal((await run('read_my_conversation', { sessionId: 'chat_carol_1' }, bob)).ok, false, '没共享的仍然读不到');
    assert.equal((await run('search_my_conversations', {}, { username: 'default', identified: false })).ok, false);
    assert.equal(parse(await run('search_my_conversations', {}, carol)).sessions.length, 2);

    // 回归：redactText 绝不能把 search_my_conversations 返回的 sessionId 脱敏成 [已隐藏]
    const { redactText } = await import('../src/agent/redact.js');
    const redactedSearch = redactText(JSON.stringify(found));
    assert.match(redactedSearch, /"sessionId":"chat_bob_1"/, 'sessionId 必须保持原样，避免 read_my_conversation 误报无权访问');
    assert.doesNotMatch(redactText('api_key=sk-1234567890abcdef password=mySecret99'), /mySecret99|sk-1234567890abcdef/, '真实密钥与密码仍被脱敏');

    // 回归：带关键词搜索历史对话时默认排除当前会话，避免把用户刚发的问题误当成历史命中
    const skipSelf = parse(await run('search_my_conversations', { query: '一键催办 接收人' }, bob, { sessionId: 'chat_bob_1' }));
    assert.equal(skipSelf.sessions.length, 0, '按关键词搜历史时应排除当前会话本身');
    const listWithCurrent = parse(await run('search_my_conversations', {}, bob, { sessionId: 'chat_bob_1' }));
    assert.equal(listWithCurrent.sessions.find((s) => s.sessionId === 'chat_bob_1')?.isCurrentConversation, true);
});
