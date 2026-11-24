import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startMockBaseServer } from './helpers/mock-base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const as = (user, name = '') => ({
    cookie: `iLearningXUserName=${user}`,
    ...(name ? { 'x-dh-displayname': name } : {}),
});

test('基座版 /api/auth/admins 返回账号统计并保留其他用户最近登录时间', async () => {
    const mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        APP_SCHEMA: 'acc-stats-test',
        APP_UUID: 'acc-stats-test',
        APP_DATASOURCE_ID: '2',
    });
    delete process.env.DH_OPEN_ADMIN;
    delete process.env.DH_ADMIN_USERS;

    const { resetAuditDedupe } = await import('../src/services/audit-service.js');
    const { createServer } = await import('../src/server.js');
    resetAuditDedupe();
    const app = await createServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${app.server.address().port}`;

    try {
        // 首位用户 alice 成为超级管理员；随后 bob、carol 登录
        await fetch(`${url}/api/auth/me`, { headers: as('alice', 'Alice Zhang') });
        await fetch(`${url}/api/auth/me`, { headers: as('bob', 'Bob Li') });
        await fetch(`${url}/api/auth/me`, { headers: as('carol', 'Carol Wang') });

        const res = await fetch(`${url}/api/auth/admins`, { headers: as('alice') });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.users.length, 3);
        const bob = data.users.find((u) => u.username === 'bob');
        assert.ok(bob && bob.seenAt > 0, '其他用户应保留真实 seenAt 最近登录时间');
        assert.ok(data.stats, '应返回 stats 统计对象');
        assert.equal(data.stats.totalUsers, 3);
        assert.equal(data.stats.superAdmins, 1);
        assert.equal(data.stats.todayActiveUsers, 3);
        assert.equal(data.stats.weekActiveUsers, 3);
        assert.ok(data.stats.todayLogins >= 3, `今日登录次数应 >= 3，实际 ${data.stats.todayLogins}`);
    } finally {
        await app.close();
        await mock.close();
    }
});

test('基座版 platform-settings.js 账号列表分页、团队筛选与统计小字正常渲染', async () => {
    const src = fs.readFileSync(path.join(rootDir, 'static/js/shared/platform-settings.js'), 'utf8');
    const makeNode = (id = '') => {
        const listeners = {};
        return {
            id,
            innerHTML: '',
            textContent: '',
            value: '',
            dataset: {},
            addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
            emit(type, ev) { (listeners[type] || []).forEach((fn) => fn(ev)); },
            querySelector(sel) {
                if (sel === '[data-acc-page-jump]') return this._jumpInput || null;
                return null;
            },
        };
    };
    const nodes = {
        '#dhAdminUserRows': makeNode('dhAdminUserRows'),
        '#dhAdminUserPagination': makeNode('dhAdminUserPagination'),
        '#dhAccountStats': makeNode('dhAccountStats'),
        '#dhAdminSaveStatus': makeNode('dhAdminSaveStatus'),
        '#dhAdminSearch': makeNode('dhAdminSearch'),
        '#dhAdminTeamFilter': makeNode('dhAdminTeamFilter'),
        '#dhAdminPreUser': makeNode('dhAdminPreUser'),
        '#dhAdminPreRole': makeNode('dhAdminPreRole'),
        '#dhAdminPreSaveBtn': makeNode('dhAdminPreSaveBtn'),
        '#dhTeamChips': makeNode('dhTeamChips'),
        '#dhTeamSummary': makeNode('dhTeamSummary'),
    };
    const content = {
        innerHTML: '',
        querySelector: (sel) => nodes[sel] || null,
    };
    const users = Array.from({ length: 35 }, (_, i) => ({
        username: `u${String(i + 1).padStart(3, '0')}`,
        displayName: `User ${i + 1}`,
        seenAt: Date.now() - i * 1000,
        isSuper: i === 0,
        isEnvAdmin: false,
        isStoredAdmin: i === 0,
        isSelf: i === 0,
        teamId: i >= 25 ? 'north' : '',
    }));
    const teams = [{ id: '', name: '默认团队', memberCount: 25 }, { id: 'north', name: '北部非洲', memberCount: 10 }];
    const win = { dispatchEvent() {}, addEventListener() {}, reloadAuditLogTable() {} };
    const ctx = {
        window: win,
        document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
        localStorage: { getItem: (k) => (k === 'tools_user' ? 'u001' : k === 'tools_role' ? 'admin' : null), setItem() {}, removeItem() {} },
        API: { get: async (u) => (u === '/api/auth/teams' ? { teams } : {}) },
        navState: { lang: 'zh-CN' },
        navEscape: (s) => String(s ?? ''),
        navT: (k) => k,
        navLocaleText: (zh, en) => zh || en,
        isNavSuperAdmin: () => true,
        renderAuditLogSection: () => '',
        console,
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    for (const k of Object.keys(win)) if (!(k in ctx)) ctx[k] = win[k];

    await ctx.renderBaseAdminsAccountSettings(content, {
        env: [],
        stored: ['u001'],
        users,
        stats: { totalUsers: 35, superAdmins: 1, todayActiveUsers: 12, todayLogins: 27, weekActiveUsers: 30, totalLogins: 188 },
    });

    // 1. 工具栏小字统计与团队摘要
    assert.match(nodes['#dhAccountStats'].innerHTML, /注册总数 <strong>35<\/strong>/);
    assert.match(nodes['#dhAccountStats'].innerHTML, /今日活跃 <strong>12<\/strong>/);
    assert.match(nodes['#dhAccountStats'].innerHTML, /今日登录 <strong>27<\/strong> 次/);
    assert.match(nodes['#dhAccountStats'].innerHTML, /7日活跃 <strong>30<\/strong>/);

    // 2. 第 1 页默认渲染 20 条
    const page1Rows = (nodes['#dhAdminUserRows'].innerHTML.match(/<tr>/g) || []).length;
    assert.equal(page1Rows, 20);
    assert.match(nodes['#dhAdminUserRows'].innerHTML, /u001/);
    assert.doesNotMatch(nodes['#dhAdminUserRows'].innerHTML, /u021/);
    assert.match(nodes['#dhAdminUserPagination'].innerHTML, /共 35 条 · 第 1 \/ 2 页/);

    // 3. 翻到第 2 页渲染剩余 15 条
    nodes['#dhAdminUserPagination'].emit('click', {
        target: { closest: (sel) => (sel === '[data-acc-page]' ? { disabled: false, dataset: { accPage: '2' } } : null) },
    });
    const page2Rows = (nodes['#dhAdminUserRows'].innerHTML.match(/<tr>/g) || []).length;
    assert.equal(page2Rows, 15);
    assert.match(nodes['#dhAdminUserRows'].innerHTML, /u021/);
    assert.match(nodes['#dhAdminUserRows'].innerHTML, /u035/);
    assert.match(nodes['#dhAdminUserPagination'].innerHTML, /共 35 条 · 第 2 \/ 2 页/);

    // 4. 切换每页 10 条 -> 自动回到第 1 页并变为 4 页
    nodes['#dhAdminUserPagination'].emit('change', {
        target: { closest: (sel) => (sel === '[data-acc-page-size]' ? { value: '10' } : null) },
    });
    assert.equal((nodes['#dhAdminUserRows'].innerHTML.match(/<tr>/g) || []).length, 10);
    assert.match(nodes['#dhAdminUserPagination'].innerHTML, /共 35 条 · 第 1 \/ 4 页/);

    // 5. 按团队筛选「北部非洲」-> 仅 10 条
    nodes['#dhAdminTeamFilter'].value = 'north';
    nodes['#dhAdminTeamFilter'].emit('change', { target: nodes['#dhAdminTeamFilter'] });
    assert.equal((nodes['#dhAdminUserRows'].innerHTML.match(/<tr>/g) || []).length, 10);
    assert.match(nodes['#dhAdminUserPagination'].innerHTML, /筛选 10 \/ 共 35 条 · 第 1 \/ 1 页/);
    assert.match(nodes['#dhAdminUserRows'].innerHTML, /u026/);
    assert.doesNotMatch(nodes['#dhAdminUserRows'].innerHTML, /u001/);
});
