// 账号绑定团队：默认团队 = 现有数据；新团队从空开始、互相隔离（抓取脚本、数据导入、业务记录、键值配置、查库工具）；
// 平台级数据（共享对话、保险箱、管理员名单）不分团队；超级管理员不能移出默认团队；定时任务按创建人的团队执行。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockBaseServer } from './helpers/mock-base.js';

const as = (user) => ({ cookie: `iLearningXUserName=${user}` });
let mock, app, url;
const call = async (user, method, path, body) => {
    const res = await fetch(`${url}${path}`, {
        method,
        headers: body === undefined ? as(user) : { 'Content-Type': 'application/json', ...as(user) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
};

before(async () => {
    mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0', LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`, BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        APP_SCHEMA: 'teams', APP_UUID: 'teams', APP_DATASOURCE_ID: '2',
    });
    delete process.env.DH_OPEN_ADMIN;
    delete process.env.DH_ADMIN_USERS;
    delete process.env.BUSINESS_DATASOURCE_NAME;
    const { createServer } = await import('../src/server.js');
    app = await createServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app?.close(); await mock?.close(); });

test('团队管理：只有超级管理员能建团队、移账号；超级管理员不能移出默认团队', async () => {
    // 第一个被识别的访问者自动成为管理员（超级管理员）
    assert.equal((await call('boss', 'GET', '/api/auth/me')).status, 200);
    await call('boss', 'PUT', '/api/auth/admins', { users: ['boss'] });
    assert.equal((await call('alice', 'GET', '/api/auth/teams')).status, 403);
    assert.equal((await call('alice', 'POST', '/api/auth/teams', { name: '华东' })).status, 403);

    const east = await call('boss', 'POST', '/api/auth/teams', { name: '华东', id: 'east' });
    assert.equal(east.status, 200, JSON.stringify(east.data));
    assert.equal((await call('boss', 'POST', '/api/auth/teams', { name: '华西', id: 'west' })).status, 200);
    assert.equal((await call('boss', 'POST', '/api/auth/teams', { name: '华东' })).status, 409, '重名');

    assert.equal((await call('boss', 'PUT', '/api/auth/teams/members/alice', { teamId: 'east' })).status, 200);
    assert.equal((await call('boss', 'PUT', '/api/auth/teams/members/amy', { teamId: 'east' })).status, 200);
    assert.equal((await call('boss', 'PUT', '/api/auth/teams/members/bob', { teamId: 'west' })).status, 200);
    assert.equal((await call('boss', 'PUT', '/api/auth/teams/members/boss', { teamId: 'east' })).status, 403, '超级管理员始终在默认团队');
    assert.equal((await call('boss', 'PUT', '/api/auth/teams/members/bob', { teamId: 'nope' })).status, 404);

    const me = (await call('Alice', 'GET', '/api/auth/me')).data;
    assert.deepEqual([me.teamId, me.teamName], ['east', '华东'], '工号大小写不影响');
    const list = (await call('boss', 'GET', '/api/auth/teams')).data;
    assert.deepEqual(list.teams.find((t) => t.id === 'east').members.sort(), ['alice', 'amy']);
    assert.equal((await call('boss', 'DELETE', '/api/auth/teams/west')).status, 409, '还有成员不能删');
});

test('工具页面数据按团队隔离：默认团队是原数据，团队之间互不可见，同团队共用', async () => {
    const { runInTeam, kvGet, kvSet, selectTable } = await import('../src/dao/scoped.js');
    const uiv = await import('../src/services/uiv-service.js');
    const records = await import('../src/services/record-store.js');

    await uiv.saveScripts([{ id: 's_default', name: '默认团队脚本', url: 'https://a/x', category: '默认分类' }]);
    await runInTeam('east', () => uiv.saveScripts([{ id: 's_east', name: '华东脚本', url: 'https://a/e', category: '默认分类' }]));
    // 同一个 id 在两个团队各存一份，互不覆盖
    await runInTeam('west', () => uiv.saveScripts([{ id: 's_east', name: '华西同名脚本', url: 'https://a/w', category: '默认分类' }]));

    const names = async (user) => ((await call(user, 'GET', '/api/uiv/scripts')).data?.scripts || []).map((s) => s.name).sort();
    assert.deepEqual(await names('carol'), ['默认团队脚本'], '默认团队只看到原数据');
    assert.deepEqual(await names('alice'), ['华东脚本']);
    assert.deepEqual(await names('amy'), ['华东脚本'], '同团队共用');
    assert.deepEqual(await names('bob'), ['华西同名脚本']);

    // 键值配置（工具页面）按团队分；平台级键不分
    await kvSet('import_settings', { who: 'default' });
    await runInTeam('east', () => kvSet('import_settings', { who: 'east' }));
    assert.deepEqual(await kvGet('import_settings'), { who: 'default' });
    assert.deepEqual(await runInTeam('east', () => kvGet('import_settings')), { who: 'east' });
    assert.deepEqual(await runInTeam('west', () => kvGet('import_settings', null)), null, '新团队从空开始');
    await runInTeam('east', () => kvSet('nav_settings', { shared: true }));
    assert.deepEqual(await kvGet('nav_settings'), { shared: true }, '平台级设置不分团队');

    // 业务记录：工具种类分团队，平台级种类（保险箱、审计…）不分
    await runInTeam('east', () => records.putRecord('duty_roster', { id: '2026-11', name: '华东值班', payload: { a: 1 } }));
    assert.equal(await records.getRecord('duty_roster', '2026-11'), null);
    assert.equal((await runInTeam('east', () => records.getRecord('duty_roster', '2026-11'))).name, '华东值班');
    assert.equal(await runInTeam('west', () => records.getRecord('duty_roster', '2026-11')), null);
    await runInTeam('east', () => records.putRecord('audit_log', { id: 'a1', name: '审计', payload: {} }));
    assert.equal((await records.getRecord('audit_log', 'a1')).name, '审计', '平台级种类不分团队');

    // 改、删只作用于本团队
    await runInTeam('west', () => uiv.deleteScript?.('s_east'));
    assert.deepEqual(await names('alice'), ['华东脚本']);
    const raw = await runInTeam('east', () => selectTable('uiv_scripts', { whereSql: "`id` = 's_east'", memFilter: (r) => r.id === 's_east' }));
    assert.equal(raw.length, 1);
    assert.equal(raw[0].team_id, undefined, '返回给业务层的行不带 team_id');
});

test('对话里的查库工具：非默认团队只查得到本团队的数据', async () => {
    const { runInTeam } = await import('../src/dao/scoped.js');
    const { runSelect } = await import('../src/agent/tools.js');
    const admin = { username: 'boss', isAdmin: true, identified: true };
    const rows = async (team) => JSON.parse((await runInTeam(team, () => runSelect({ sql: 'SELECT name FROM uiv_scripts', identity: admin }))).content).rows.map((r) => r.name).sort();
    assert.deepEqual(await rows(''), ['默认团队脚本']);
    assert.deepEqual(await rows('east'), ['华东脚本']);
    assert.deepEqual(await rows('west'), [], '上一条用例在华西删掉了华西自己那份（华东的不受影响）');
});

test('定时任务按创建人所在的团队执行', async () => {
    const { runAsUserTeam } = await import('../src/services/team-service.js');
    const { currentTeam, kvGet } = await import('../src/dao/scoped.js');
    assert.equal(await runAsUserTeam('alice', () => currentTeam()), 'east');
    assert.equal(await runAsUserTeam('carol', () => currentTeam()), '');
    assert.deepEqual(await runAsUserTeam('alice', () => kvGet('import_settings')), { who: 'east' });
    // 回到默认团队
    assert.equal((await call('boss', 'PUT', '/api/auth/teams/members/alice', { teamId: '' })).status, 200);
    assert.equal(await runAsUserTeam('alice', () => currentTeam()), '');
});

test('团队版表与原表保持同步（新增工具表后要重新生成）', async () => {
    const fs = await import('node:fs');
    const { teamTablesSql } = await import('../scripts/gen-team-tables.mjs');
    const init = fs.readFileSync(new URL('../db/init.sql', import.meta.url), 'utf8');
    const upgrade = fs.readFileSync(new URL('../db/upgrade.sql', import.meta.url), 'utf8');
    const block = teamTablesSql(init);
    assert.ok(init.includes(block), 'init.sql 里的团队版表不是最新：运行 node scripts/gen-team-tables.mjs');
    for (const name of [...block.matchAll(/CREATE TABLE IF NOT EXISTS `(team_\w+)`/g)].map((m) => m[1])) {
        assert.ok(upgrade.includes(`CREATE TABLE IF NOT EXISTS \`${name}\``), `upgrade.sql 缺少 ${name}`);
    }
});
