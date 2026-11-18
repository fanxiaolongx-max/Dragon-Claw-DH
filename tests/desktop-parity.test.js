// 从主线版搬过来的能力：友情链接、平台推广。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startMockBaseServer } from './helpers/mock-base.js';

const as = (user) => ({ cookie: `iLearningXUserName=${user}` });

async function boot(schema) {
    const mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        APP_SCHEMA: schema,
        APP_UUID: schema,
        APP_DATASOURCE_ID: '2',
        BUSINESS_DATASOURCE_NAME: 'netcare_ds',
    });
    delete process.env.DH_OPEN_ADMIN;
    delete process.env.DH_ADMIN_USERS;
    const { createServer } = await import('../src/server.js');
    const app = await createServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const call = async (user, method, path, body) => {
        const res = await fetch(`${url}${path}`, {
            method,
            headers: body === undefined ? as(user) : { 'Content-Type': 'application/json', ...as(user) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { data = text; }
        return { status: res.status, data, headers: res.headers };
    };
    return { mock, app, url, call, close: async () => { await app.close(); await mock.close(); } };
}

// 配置模块按进程缓存，整个文件共用一次启动
let ctx;
before(async () => { ctx = await boot('parity'); });
after(async () => { await ctx?.close(); });

test('友情链接与平台推广：管理员维护、全员可见、点击统计', async () => {
    const { call } = ctx;
    {
        assert.equal((await call('alice', 'GET', '/api/auth/me')).data.isAdmin, true);
        assert.equal((await call('bob', 'GET', '/api/auth/me')).data.isAdmin, false);

        // ── 友情链接：默认没有任何链接（主线版预置的公网站点不带过来）──
        const empty = (await call('bob', 'GET', '/api/friend-links')).data;
        assert.deepEqual(empty.links, []);
        assert.equal(empty.desktopAutoInstallAvailable, false);
        assert.equal((await call('bob', 'PUT', '/api/friend-links', { links: [] })).status, 403);
        assert.equal((await call('alice', 'PUT', '/api/friend-links', { links: [{ name: '坏链接', url: 'ftp://x' }] })).status, 400);
        assert.equal((await call('alice', 'PUT', '/api/friend-links', { links: [{ name: '带口令', url: 'https://u:p@example.com' }] })).status, 400);
        const saved = (await call('alice', 'PUT', '/api/friend-links', {
            probeIntervalMinutes: 5,
            links: [{ id: 'wiki', icon: '📚', name: '知识库', nameEn: 'Wiki', url: 'http://127.0.0.1:9/wiki' }, { name: '门户', url: 'https://portal.example.invalid/' }],
        })).data;
        assert.equal(saved.links.length, 2);
        assert.equal(saved.links[0].id, 'wiki');
        assert.match(saved.links[1].id, /^link_[0-9a-f]{12}$/);
        assert.equal(saved.probeIntervalMinutes, 10, '探测间隔下限 10 分钟');
        // 探测：本机地址不探测，记为不可用并说明原因；不存在的链接 404
        const probed = (await call('alice', 'POST', '/api/friend-links/wiki/probe')).data;
        assert.equal(probed.link.id, 'wiki');
        assert.equal(probed.result.status, 'offline');
        assert.match(probed.result.message, /本机/);
        assert.equal((await call('alice', 'POST', '/api/friend-links/nope/probe')).status, 404);
        assert.equal((await call('bob', 'POST', '/api/friend-links/probe')).status, 403);
        const seen = (await call('bob', 'GET', '/api/friend-links')).data;
        assert.equal(seen.links.length, 2);
        assert.equal(seen.statuses.wiki.status, 'offline');

        // ── 平台推广：自带一个内置链接，可隐藏不可删；自定义链接可增删 ──
        const promo = (await call('bob', 'GET', '/api/platform-promotions')).data;
        assert.equal(promo.links.length, 1);
        assert.equal(promo.links[0].builtin, true);
        assert.deepEqual(promo.videos, []);
        assert.equal((await call('bob', 'PUT', '/api/platform-promotions', promo)).status, 403);
        const next = (await call('alice', 'PUT', '/api/platform-promotions', {
            maxLinks: 99,
            rotateSeconds: 1,
            desktopStack: true,
            links: [
                { id: 'netcare', enabled: false, url: 'https://evil.example/', name: '改名' },
                { name: '运营周报', url: 'https://weekly.example.invalid/', color: 'rose', badge: '周报' },
            ],
        })).data;
        assert.equal(next.maxLinks, 10);
        assert.equal(next.rotateSeconds, 10);
        assert.equal(next.desktopStack, false);
        assert.equal(next.links[0].id, 'netcare');
        assert.equal(next.links[0].enabled, false);
        assert.equal(next.links[0].name, 'NetCare', '内置链接的名称和地址不能改');
        assert.equal(next.links[0].url, 'https://netcare.huawei.com/'.replace(/\/$/, ''));
        const custom = next.links[1];
        assert.equal(custom.builtin, false);
        assert.equal(custom.color, 'rose');
        assert.equal((await call('alice', 'PUT', '/api/platform-promotions', { links: [{ name: '', url: 'https://a.example/' }] })).status, 400);

        // 点击统计：普通用户可上报，几秒内重复点击只算一次；汇总仅管理员可看
        assert.equal((await call('bob', 'POST', '/api/platform-promotions/clicks', { id: custom.id, kind: 'link' })).data.counted, true);
        assert.equal((await call('bob', 'POST', '/api/platform-promotions/clicks', { id: custom.id, kind: 'link' })).data.counted, false);
        assert.equal((await call('carol', 'POST', '/api/platform-promotions/clicks', { id: custom.id, kind: 'link' })).data.counted, true);
        assert.equal((await call('bob', 'POST', '/api/platform-promotions/clicks', { id: 'nope', kind: 'link' })).status, 404);
        assert.equal((await call('bob', 'POST', '/api/platform-promotions/clicks', { id: custom.id, kind: 'x' })).status, 400);
        assert.equal((await call('bob', 'GET', '/api/platform-promotions/stats')).status, 403);
        const stats = (await call('alice', 'GET', '/api/platform-promotions/stats?days=7')).data;
        assert.equal(stats.totalClicks, 2);
        assert.equal(stats.totalUsers, 2);
        assert.equal(stats.items[0].id, custom.id);
        assert.equal(stats.items[0].users, 2);
        assert.equal(stats.daily.length, 1);
    }
});

// 用浏览器同款 WebCrypto 生成加密信封（与 static/js/shared/requirements-client.js 的协议一致）
async function envelope(call, user, payload, method, path) {
    const config = (await call(user, 'GET', '/api/requirements/transport-key')).data;
    const b64 = (bytes) => Buffer.from(bytes).toString('base64');
    const rsa = await crypto.subtle.importKey('spki', Buffer.from(config.publicKey, 'base64'), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode(JSON.stringify([config.version, method, path, config.context]));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aes, new TextEncoder().encode(JSON.stringify(payload)));
    const encryptedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, rsa, await crypto.subtle.exportKey('raw', aes));
    return { encryptedPayload: { version: config.version, keyId: config.keyId, iv: b64(iv), encryptedKey: b64(new Uint8Array(encryptedKey)), ciphertext: b64(new Uint8Array(ciphertext)) } };
}

test('需求广场：提交、加密信封、分块上传、流转规则与权限', async () => {
    const { call } = ctx;
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    {
        assert.equal((await call('alice', 'GET', '/api/auth/me')).data.isAdmin, true);
        assert.deepEqual((await call('bob', 'GET', '/api/requirements')).data, []);

        // 普通用户用加密信封提交，带一张图
        const body = { title: '报表导出加一列', description: 'x'.repeat(400), category: '报表看板', urgent: true, images: [{ name: 'a.png', type: 'image/png', data: PNG.toString('base64') }] };
        const created = await call('bob', 'POST', '/api/requirements', await envelope(call, 'bob', body, 'POST', '/api/requirements'));
        assert.equal(created.status, 200, JSON.stringify(created.data));
        assert.equal(created.data.id, 1);
        // 信封绑定了提交人和路径：别人拿去重放、换个路径都解不开
        const stolen = await envelope(call, 'bob', body, 'POST', '/api/requirements');
        assert.equal((await call('carol', 'POST', '/api/requirements', stolen)).status, 400);
        assert.equal((await call('bob', 'PUT', '/api/requirements/1', stolen)).status, 400);
        // 校验：缺标题、图片不是图片
        assert.equal((await call('bob', 'POST', '/api/requirements', { category: 'x' })).status, 400);
        assert.equal((await call('bob', 'POST', '/api/requirements', { title: 't', category: 'c', images: [{ name: 'x.png', type: 'image/png', data: Buffer.from('nope').toString('base64') }] })).data.code, 'REQUIREMENT_IMAGE_INVALID');

        const list = (await call('carol', 'GET', '/api/requirements')).data;
        assert.equal(list.length, 1);
        assert.equal(list[0].description.length, 300);
        assert.equal(list[0].description_truncated, true);
        assert.equal(list[0].urgent, 1);
        assert.equal(list[0].creator, 'bob');
        const detail = (await call('carol', 'GET', '/api/requirements/1')).data;
        assert.equal(detail.description.length, 400);
        assert.equal(detail.canEdit, false);
        assert.equal(detail.canManage, false);
        assert.deepEqual(detail.images, [{ name: 'a.png', href: '/api/requirements/1/images/0' }]);
        assert.equal(detail.logs.length, 1);
        const image = await fetch(`${ctx.url}/api/requirements/1/images/0`, { headers: as('carol') });
        assert.equal(image.headers.get('content-type'), 'image/png');
        assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
        assert.equal((await call('carol', 'GET', '/api/requirements/1/images/5')).status, 404);

        // 权限：别人不能改；本人能改内容但不能改状态；管理员按流程流转，不能跳级、回退
        assert.equal((await call('carol', 'PUT', '/api/requirements/1', { title: 'x' })).status, 403);
        assert.equal((await call('bob', 'PUT', '/api/requirements/1', { status: '需求接受' })).status, 403);
        assert.equal((await call('bob', 'PUT', '/api/requirements/1', { title: '报表导出加两列' })).status, 200);
        assert.equal((await call('alice', 'PUT', '/api/requirements/1', { status: '需求完成' })).data.error, '流程不能跳级');
        assert.equal((await call('alice', 'PUT', '/api/requirements/1', { status: '需求接受', assignee: 'alice', remark: '排进下个版本' })).status, 200);
        assert.equal((await call('alice', 'PUT', '/api/requirements/1', { status: '提交' })).data.error, '流程不能回退');
        const after = (await call('bob', 'GET', '/api/requirements/1')).data;
        assert.equal(after.title, '报表导出加两列');
        assert.equal(after.status, '需求接受');
        assert.equal(after.assignee, 'alice');
        assert.equal(after.canEdit, true);
        assert.deepEqual(after.logs.map((l) => l.remark), ['创建需求', '排进下个版本']);
        assert.equal((await call('alice', 'PUT', '/api/requirements/1', { status: '已拒绝' })).status, 200);
        assert.equal((await call('alice', 'PUT', '/api/requirements/1', { status: '需求实现中' })).data.error, '已拒绝的需求无法再流转');

        // 大请求走分块上传：收齐、校验整包、保存；重复 complete 返回同一结果且不重复创建
        const big = { title: '分块提交', description: 'd', category: '首页', images: Array.from({ length: 2 }, (_, i) => ({ name: `${i}.png`, type: 'image/png', data: PNG.toString('base64') })) };
        const serialized = JSON.stringify(await envelope(call, 'bob', big, 'POST', '/api/requirements'));
        const half = Math.ceil(serialized.length / 2);
        const chunks = [serialized.slice(0, half), serialized.slice(half)];
        const sha256 = crypto.createHash('sha256').update(serialized).digest('hex');
        assert.equal((await call('bob', 'POST', '/api/requirements/uploads/start', { method: 'POST', totalBytes: 0, totalChunks: 2, sha256 })).status, 400);
        const { uploadId } = (await call('bob', 'POST', '/api/requirements/uploads/start', { method: 'POST', totalBytes: Buffer.byteLength(serialized), totalChunks: 2, sha256 })).data;
        assert.match(uploadId, /^[a-f0-9]{32}$/);
        assert.equal((await call('carol', 'POST', `/api/requirements/uploads/${uploadId}/chunk`, { index: 0, data: chunks[0] })).status, 404, '别人碰不到我的上传');
        assert.equal((await call('bob', 'POST', `/api/requirements/uploads/${uploadId}/complete`, {})).status, 409);
        assert.equal((await call('bob', 'POST', `/api/requirements/uploads/${uploadId}/chunk`, { index: 0, data: chunks[0] })).data.receivedChunks, 1);
        assert.equal((await call('bob', 'POST', `/api/requirements/uploads/${uploadId}/chunk`, { index: 0, data: chunks[0] })).data.receivedChunks, 1, '重复分块幂等');
        assert.equal((await call('bob', 'POST', `/api/requirements/uploads/${uploadId}/chunk`, { index: 0, data: 'tampered' })).status, 409);
        assert.equal((await call('bob', 'POST', `/api/requirements/uploads/${uploadId}/chunk`, { index: 1, data: chunks[1] })).data.receivedChunks, 2);
        const done = await call('bob', 'POST', `/api/requirements/uploads/${uploadId}/complete`, {});
        assert.equal(done.status, 200, JSON.stringify(done.data));
        assert.equal(done.data.id, 2);
        assert.equal((await call('bob', 'POST', `/api/requirements/uploads/${uploadId}/complete`, {})).data.id, 2);
        assert.equal((await call('bob', 'GET', '/api/requirements')).data.length, 2);
        assert.equal((await call('bob', 'GET', '/api/requirements/2')).data.images.length, 2);

        // 删除：本人或管理员
        assert.equal((await call('carol', 'DELETE', '/api/requirements/2')).status, 403);
        assert.equal((await call('bob', 'DELETE', '/api/requirements/2')).status, 200);
        assert.equal((await call('bob', 'GET', '/api/requirements/2')).status, 404);
        assert.equal((await call('bob', 'GET', '/api/requirements/2/images/0')).status, 404);
        // 页面可直接打开
        const page = await fetch(`${ctx.url}/requirements`, { headers: as('bob') });
        assert.equal(page.status, 200);
        assert.match(await page.text(), /js\/requirements\.js/);
    }
});

test('内置工具与问卷调研：未全员开放前仅超管可用，开放后全员可用并支持模板提交导出', async () => {
    const { call } = ctx;
    // 未开放前：bob 看不到内置工具、点不开页面也调不到 /api/surveys；alice 超级管理员始终可用
    assert.equal((await call('bob', 'GET', '/api/custom-tools')).data.some((t) => t.slug === 'tool-mqp55fna'), false);
    assert.equal((await call('bob', 'GET', '/api/custom-tools/tool-mqp55fna/meta')).status, 404);
    assert.equal((await fetch(`${ctx.url}/builtin-tools/tool-mqp55fna/index.html`, { headers: as('bob') })).status, 403);
    assert.equal((await call('bob', 'GET', '/api/surveys/templates')).status, 403);
    assert.ok((await call('alice', 'GET', '/api/custom-tools')).data.some((t) => t.slug === 'tool-mqp55fna'));
    // 超级管理员设为全员开放后，bob 才能查看列表、访问外壳与接口
    assert.equal((await call('alice', 'PATCH', '/api/custom-tools/tool-mqp55fna/distribution', { sharedAccess: true })).status, 200);
    const tools = (await call('bob', 'GET', '/api/custom-tools')).data;
    const survey = tools.find((t) => t.slug === 'tool-mqp55fna');
    assert.equal(survey.builtIn, true);
    assert.equal(survey.href, '/custom-tools/tool-mqp55fna/');
    const meta = (await call('bob', 'GET', '/api/custom-tools/tool-mqp55fna/meta')).data;
    assert.equal(meta.entry, 'builtin-tools/tool-mqp55fna/index.html');
    const page = await fetch(`${ctx.url}/${meta.entry}`, { headers: as('bob') });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /\.\.\/\.\.\/js\/shared\/dh-runtime\.js/);
    const shell = await fetch(`${ctx.url}/tools/tool-mqp55fna`, { headers: as('bob'), redirect: 'manual' });
    assert.equal(shell.status, 302);
    assert.match(shell.headers.get('location'), /custom-tool\.html\?slug=tool-mqp55fna$/);
    assert.equal((await call('alice', 'DELETE', '/api/custom-tools/tool-mqp55fna')).status, 400);
    assert.equal((await call('alice', 'GET', '/api/custom-tools/tool-mqp55fna/export')).status, 404);

    // 问卷：首次读取放入六个默认模板，按创建顺序排列
    const templates = (await call('bob', 'GET', '/api/surveys/templates')).data;
    assert.deepEqual(templates.map((t) => t.id), ['maintenance', 'communication', 'recovery', 'supervision', 'drill', 'declaration']);
    assert.ok(templates[0].fields.find((f) => f.key === 'managerRoles').orgChart.length > 0);
    // 提交：必填、链接域名校验；普通用户能提交但看不到别人的提交记录
    const answers = { activityDesc: '月度维护例会', activityDate: '2026-11-10', managerRoles: ['AD (Account Director)', 'BU长 (BU Director)'], materialArchive: '无', networkSafety: '是', jamLink: '无' };
    assert.match((await call('bob', 'POST', '/api/surveys/submissions', { templateId: 'maintenance', answers: { ...answers, activityDesc: '' } })).data.error, /请填写/);
    assert.match((await call('bob', 'POST', '/api/surveys/submissions', { templateId: 'maintenance', answers: { ...answers, jamLink: 'https://evil.example/x' } })).data.error, /指定域名/);
    assert.equal((await call('bob', 'POST', '/api/surveys/submissions', { templateId: 'nope', answers })).status, 404);
    const sub = (await call('bob', 'POST', '/api/surveys/submissions', { templateId: 'maintenance', answers })).data.submission;
    assert.match(sub.id, /^submission_/);
    await call('carol', 'POST', '/api/surveys/submissions', { templateId: 'drill', answers });
    assert.equal((await call('bob', 'GET', '/api/surveys/submissions')).status, 403);
    assert.equal((await call('alice', 'GET', '/api/surveys/submissions')).data.length, 2);
    const mine = (await call('alice', 'GET', '/api/surveys/submissions?templateId=maintenance')).data;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].submittedBy, 'bob');
    // 管理员改提交记录、维护模板；普通用户不行
    assert.equal((await call('bob', 'PUT', `/api/surveys/submissions/${sub.id}`, { answers })).status, 403);
    const edited = (await call('alice', 'PUT', `/api/surveys/submissions/${sub.id}`, { answers: { ...answers, networkSafety: '否' } })).data.submission;
    assert.equal(edited.answers.networkSafety, '否');
    assert.equal(edited.createdAt, mine[0].createdAt);
    assert.equal((await call('bob', 'POST', '/api/surveys/templates', { name: 'x', fields: [{ label: 'a' }] })).status, 403);
    assert.equal((await call('alice', 'POST', '/api/surveys/templates', { name: 'x', fields: [] })).status, 400);
    const created = (await call('alice', 'POST', '/api/surveys/templates', { name: '客户回访', fields: [{ label: '满意度', type: 'radio', options: ['高', '低'] }, { label: '满意度' }] })).data;
    assert.deepEqual(created.fields.map((f) => f.key), ['field_1', 'field_2']);
    assert.equal((await call('alice', 'GET', '/api/surveys/templates')).data.at(-1).id, created.id, '新模板排在最后');
    // 台账导出：是一个真的 xlsx，表头里有主管统计列
    const xlsx = await fetch(`${ctx.url}/api/surveys/export.xlsx`, { headers: as('alice') });
    assert.equal(xlsx.status, 200);
    const ExcelJS = (await import('exceljs')).default;
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(await xlsx.arrayBuffer()));
    const sheet = book.worksheets[0];
    const header = sheet.getRow(1).values.filter(Boolean);
    assert.ok(header.includes('系统部AD Account Director'));
    assert.equal(sheet.rowCount, 3);
    const adCol = header.indexOf('系统部AD Account Director') + 1;
    assert.deepEqual([sheet.getRow(2).getCell(adCol).value, sheet.getRow(3).getCell(adCol).value], [1, 1]);
    assert.equal((await call('bob', 'GET', '/api/surveys/export.xlsx')).status, 403);
    assert.equal((await call('alice', 'DELETE', `/api/surveys/submissions/${sub.id}`)).status, 200);
    assert.equal((await call('alice', 'DELETE', `/api/surveys/submissions/${sub.id}`)).status, 404);
    assert.equal((await call('alice', 'DELETE', `/api/surveys/templates/${created.id}`)).status, 200);
});

test('会议考勤与操作激励快照：未开放拦截，开放后支持保存、筛选、改名、考勤核验、名单提取', async () => {
    const { call } = ctx;
    assert.equal((await call('bob', 'GET', '/api/meeting-snapshots')).status, 403);
    assert.equal((await call('bob', 'GET', '/api/operation-incentive-snapshots')).status, 403);
    await call('alice', 'PATCH', '/api/custom-tools/tool-msf5b7nn/distribution', { sharedAccess: true });
    await call('alice', 'PATCH', '/api/custom-tools/tool-ms4xb66s/distribution', { sharedAccess: true });
    // ── 会议考勤：开放后普通用户即可维护 ──
    assert.deepEqual((await call('bob', 'GET', '/api/meeting-snapshots')).data.items, []);
    assert.equal((await call('bob', 'POST', '/api/meeting-snapshots', { title: 'x' })).status, 400);
    const attendees = [
        { account: 'z00123456', name: '张三', attendance: '迟到', bu: '无线' },
        { account: 'l00654321', name: '李四', attendance: '准时', bu: '核心网' },
    ];
    const oct = (await call('bob', 'POST', '/api/meeting-snapshots', { title: '十月例会', meetingDate: '2026-10-15', summary: { total: 2 }, payload: { attendees } })).data.item;
    assert.match(oct.id, /^meet_20261015_/);
    assert.equal(oct.meeting_date, '2026-10-15');
    assert.deepEqual(oct.summary, { total: 2 });
    const nov = (await call('carol', 'POST', '/api/meeting-snapshots', { meetingDate: '2026-11-05', payload: { attendees: [attendees[1]] } })).data.item;
    assert.equal(nov.title, '2026-11-05 会议考勤快照');
    const list = (await call('bob', 'GET', '/api/meeting-snapshots')).data;
    assert.deepEqual(list.items.map((i) => i.meetingDate), ['2026-11-05', '2026-10-15'], '按会议日期倒序');
    assert.equal(list.items[0].payload, undefined, '列表默认不带完整数据');
    assert.equal((await call('bob', 'GET', '/api/meeting-snapshots?full=1')).data.items[1].payload.attendees.length, 2);
    assert.equal((await call('bob', 'GET', '/api/meeting-snapshots?search=十月')).data.count, 1);
    assert.equal((await call('bob', 'GET', '/api/meeting-snapshots?startDate=2026-11-01')).data.count, 1);
    assert.equal((await call('bob', 'PUT', `/api/meeting-snapshots/${oct.id}`, { title: '十月安全例会' })).data.item.title, '十月安全例会');
    assert.equal((await call('bob', 'PUT', '/api/meeting-snapshots/nope', { title: 'x' })).status, 404);
    assert.equal((await call('bob', 'GET', '/api/meeting-snapshots/nope')).data.code, 'SNAPSHOT_NOT_FOUND');
    // 考勤核验：工号前缀字母可有可无；按姓名也能查
    const check = (await call('bob', 'GET', '/api/meeting-snapshots/attendance-check?staffId=00123456')).data;
    assert.equal(check.found, true);
    assert.equal(check.records.length, 1);
    assert.equal(check.records[0].snapshotId ?? check.records[0].id ?? oct.id, oct.id);
    const lisi = (await call('bob', 'GET', `/api/meeting-snapshots/attendance-check?name=${encodeURIComponent('李四')}`)).data;
    assert.equal(lisi.records.length, 2);
    assert.equal((await call('bob', 'GET', '/api/meeting-snapshots/attendance-check')).data.found, false);
    const batch = (await call('bob', 'POST', '/api/meeting-snapshots/batch-attendance-check', { persons: [{ staffId: 'z00123456', name: '张三' }, { staffId: 'x00999999', name: '无此人' }] })).data;
    assert.equal(batch.success, true);
    const roster = (await call('bob', 'GET', '/api/meeting-snapshots/extract-roster')).data.roster;
    assert.deepEqual(roster.map((p) => p.name).sort(), ['张三', '李四'].sort());
    // 名单设置
    assert.deepEqual((await call('bob', 'GET', '/api/meeting-snapshots/settings/rosters')).data.data.mandatoryAttendees, []);
    const settings = (await call('bob', 'PUT', '/api/meeting-snapshots/settings/rosters', { mandatoryAttendees: [{ name: '王五' }] })).data.data;
    assert.equal(settings.mandatoryAttendees.length, 1);
    assert.deepEqual(settings.exemptions, []);
    assert.equal((await call('bob', 'DELETE', `/api/meeting-snapshots/${nov.id}`)).status, 200);
    assert.equal((await call('bob', 'DELETE', `/api/meeting-snapshots/${nov.id}`)).status, 404);

    // ── 操作激励：同样的快照接口，另有别名路径 ──
    const inc = (await call('bob', 'POST', '/api/operation-incentive-snapshots', { period: '2026-10', sourceFile: '夜间操作.xlsx', summary: { people: 1 }, payload: { personnelSummary: [{ staffId: 'z00123456', name: '张三', total: 300 }] } })).data.item;
    assert.match(inc.id, /^inc_202610_/);
    assert.equal(inc.title, '2026-10 操作激励核算快照');
    assert.equal(inc.source_file, '夜间操作.xlsx');
    assert.equal((await call('bob', 'GET', '/api/incentive-snapshots?period=2026-10')).data.count, 1);
    assert.equal((await call('bob', 'GET', '/api/incentive-snapshots?period=2025')).data.count, 0);
    assert.equal((await call('bob', 'GET', `/api/operation-incentive-snapshots/${inc.id}`)).data.item.payload.personnelSummary[0].total, 300);
    const again = (await call('bob', 'POST', '/api/operation-incentive-snapshots', { id: inc.id, period: '2026-10', title: '改过的', payload: { personnelSummary: [] } })).data.item;
    assert.equal(again.createdAt, inc.createdAt, '同一标识是覆盖，创建时间不变');
    assert.equal((await call('bob', 'GET', '/api/operation-incentive-snapshots')).data.count, 1);
    assert.equal((await call('bob', 'GET', '/api/operation-incentive-snapshots/extract-roster')).data.success, true);
    assert.equal((await call('bob', 'DELETE', `/api/operation-incentive-snapshots/${inc.id}`)).status, 200);
});

test('奖励申报与评优：未开放拦截，开放后支持规则、草稿、发布、审批流、公示异议、归档、证据附件', async () => {
    const { call } = ctx;
    assert.equal((await call('bob', 'GET', '/api/reward-program')).status, 403);
    await call('alice', 'PATCH', '/api/custom-tools/reward-program/distribution', { sharedAccess: true });
    const home = (await call('bob', 'GET', '/api/reward-program')).data;
    assert.equal(home.isAdmin, false);
    assert.equal(home.username, 'bob');
    assert.ok(home.rules.find((r) => r.id === 'ex-golden'));
    assert.deepEqual(home.applications, []);

    // 规则：仅管理员维护；自带规则「删除」后不再出现
    assert.equal((await call('bob', 'PUT', '/api/reward-program/rules/x', { category: 'bounty', name: 'x' })).status, 403);
    assert.equal((await call('alice', 'PUT', '/api/reward-program/rules/night-shift', { category: 'operation', name: '夜间割接激励', unitAmountMinor: 50000, approvalFlow: ['at'] })).status, 400);
    const rule = (await call('alice', 'PUT', '/api/reward-program/rules/night-shift', { category: 'operation', name: '夜间割接激励', unitAmountMinor: 50000, approvalFlow: ['department', 'publicity'] })).data;
    assert.equal(rule.id, 'night-shift');
    assert.equal((await call('alice', 'DELETE', '/api/reward-program/rules/ex-team')).status, 200);
    const ruleIds = (await call('bob', 'GET', '/api/reward-program')).data.rules.map((r) => r.id);
    assert.ok(ruleIds.includes('night-shift') && !ruleIds.includes('ex-team'));

    // 草稿 → 保存（带版本号）→ 提交时才做完整校验
    const form = { category: 'operation', ruleId: 'night-shift', title: '十月夜间割接', summary: '完成 12 次割接', totalAmountMinor: 100000, recipients: [{ name: '张三', staffId: 'z001', mode: 'amount', amountMinor: 50000 }, { name: '李四', staffId: 'l002', mode: 'percent', percentBp: 5000 }] };
    assert.equal((await call('bob', 'POST', '/api/reward-program/applications', { ...form, ruleId: 'nope' })).status, 400);
    const app1 = (await call('bob', 'POST', '/api/reward-program/applications', form)).data;
    assert.equal(app1.status, 'draft');
    assert.equal(app1.revision, 1);
    assert.equal(app1.applicant, 'bob');
    assert.equal((await call('carol', 'POST', `/api/reward-program/applications/${app1.id}/save`, { ...form, revision: 1 })).status, 404, '别人的草稿看不到也改不了');
    assert.equal((await call('bob', 'POST', `/api/reward-program/applications/${app1.id}/save`, { ...form, revision: 9 })).status, 409);
    const saved = (await call('bob', 'POST', `/api/reward-program/applications/${app1.id}/save`, { ...form, title: '十月夜间割接激励', revision: 1 })).data;
    assert.equal(saved.revision, 2);
    assert.equal(saved.title, '十月夜间割接激励');
    assert.match((await call('bob', 'POST', `/api/reward-program/applications/${app1.id}/submit`, { ...form, totalAmountMinor: 90000, revision: 2 })).data.error, /合计与总额不一致/);
    const submitted = (await call('bob', 'POST', `/api/reward-program/applications/${app1.id}/submit`, { ...form, title: '十月夜间割接激励', revision: 2 })).data;
    assert.equal(submitted.status, 'submitted');
    assert.equal(submitted.recipients[1].amountMinor, 50000, '按比例的金额由服务端算出');
    assert.equal(submitted.ruleSnapshot.name, '夜间割接激励');
    assert.equal((await call('carol', 'GET', '/api/reward-program')).data.applications.length, 0, '审批中的申请别人看不到');

    // 审批：部门 → 公示 → 完成；公示期别人能看到（不带金额和工号）并提异议，异议没处理完不能结束公示
    assert.equal((await call('bob', 'POST', `/api/reward-program/applications/${app1.id}/decision`, { action: 'approve', revision: 3 })).status, 403);
    assert.equal((await call('alice', 'POST', `/api/reward-program/applications/${app1.id}/decision`, { action: 'approve', revision: 3 })).data.status, 'department_approved');
    assert.equal((await call('alice', 'POST', `/api/reward-program/applications/${app1.id}/decision`, { action: 'approve', revision: 4 })).data.status, 'publicity');
    const publicView = (await call('carol', 'GET', '/api/reward-program')).data.applications[0];
    assert.equal(publicView.title, '十月夜间割接激励');
    assert.equal(publicView.totalAmountMinor, undefined);
    assert.deepEqual(publicView.recipients[0], { name: '张三', team: '' });
    const objection = (await call('carol', 'POST', `/api/reward-program/applications/${app1.id}/objections`, { note: '李四十月休假' })).data;
    assert.equal(objection.status, 'open');
    assert.equal((await call('bob', 'GET', `/api/reward-program/applications/${app1.id}/objections`)).data.length, 0, '申报人看不到别人提的异议');
    assert.equal((await call('alice', 'GET', `/api/reward-program/applications/${app1.id}/objections`)).data.length, 1);
    assert.match((await call('alice', 'POST', `/api/reward-program/applications/${app1.id}/decision`, { action: 'approve', revision: 5 })).data.error, /1 条公示异议未处理/);
    assert.equal((await call('carol', 'POST', `/api/reward-program/applications/${app1.id}/objections/${objection.id}/resolve`, { resolution: 'x' })).status, 403);
    assert.equal((await call('alice', 'POST', `/api/reward-program/applications/${app1.id}/objections/${objection.id}/resolve`, { resolution: '已核实，休假前完成' })).data.status, 'resolved');
    const completed = (await call('alice', 'POST', `/api/reward-program/applications/${app1.id}/decision`, { action: 'approve', revision: 5 })).data;
    assert.equal(completed.status, 'completed');
    assert.equal((await call('carol', 'POST', `/api/reward-program/applications/${app1.id}/objections`, { note: '晚了' })).status, 409);
    assert.deepEqual((await call('bob', 'GET', `/api/reward-program/applications/${app1.id}/events`)).data.map((e) => e.action), ['create', 'save', 'submit', 'approve', 'approve', 'objection', 'resolve_objection', 'approve']);

    // 直接发布的记录：撤销（要写原因）→ 归档 → 恢复 → 再归档 → 清空归档；证据附件跟着删
    const upload = new FormData();
    upload.append('file', new Blob([Buffer.from('%PDF-1.4 evidence')], { type: 'application/pdf' }), '证明.pdf');
    const evidenceRes = await fetch(`${ctx.url}/api/reward-program/evidence`, { method: 'POST', headers: as('bob'), body: upload });
    assert.equal(evidenceRes.status, 200);
    const evidence = await evidenceRes.json();
    assert.match(evidence.path, /^\/api\/reward-program\/evidence\/[a-f0-9-]{36}\.pdf$/);
    const bad = new FormData();
    bad.append('file', new Blob(['x'], { type: 'application/x-msdownload' }), 'a.exe');
    assert.equal((await fetch(`${ctx.url}/api/reward-program/evidence`, { method: 'POST', headers: as('bob'), body: bad })).status, 400);
    const got = await fetch(`${ctx.url}${evidence.path}`, { headers: as('carol') });
    assert.equal(got.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await got.arrayBuffer()).toString(), '%PDF-1.4 evidence');

    const app2 = (await call('bob', 'POST', '/api/reward-program/applications', { ...form, title: '十一月', attachments: [evidence.path] })).data;
    const published = (await call('bob', 'POST', `/api/reward-program/applications/${app2.id}/publish`, {})).data;
    assert.equal(published.status, 'published');
    assert.equal((await call('bob', 'DELETE', `/api/reward-program/applications/${app2.id}`)).status, 409);
    assert.equal((await call('alice', 'POST', `/api/reward-program/applications/${app2.id}/revoke`, {})).status, 400);
    const revoked = (await call('alice', 'POST', `/api/reward-program/applications/${app2.id}/revoke`, { reason: '重复申报' })).data;
    assert.equal(revoked.status, 'revoked');
    assert.equal(revoked.revokeReason, '重复申报');
    assert.equal(revoked.title, '十一月', '撤销不丢表单内容');
    const archived = (await call('alice', 'POST', `/api/reward-program/applications/${app2.id}/archive`, {})).data;
    assert.equal(archived.status, 'archived');
    assert.equal((await call('alice', 'POST', `/api/reward-program/applications/${app2.id}/archive`, {})).status, 409);
    assert.equal((await call('alice', 'POST', `/api/reward-program/applications/${app2.id}/unarchive`, {})).data.status, 'revoked');
    await call('alice', 'POST', `/api/reward-program/applications/${app2.id}/archive`, {});
    assert.equal((await call('bob', 'DELETE', '/api/reward-program/archived')).status, 403);
    assert.equal((await call('alice', 'DELETE', '/api/reward-program/archived?category=operation')).data.count, 2, '已归档和已完成的一起清掉');
    assert.equal((await fetch(`${ctx.url}${evidence.path}`, { headers: as('carol') })).status, 404);
    assert.equal((await call('alice', 'GET', '/api/reward-program')).data.applications.length, 0);
    assert.equal((await call('alice', 'GET', '/api/reward-program/snapshot/settings')).status, 404);
});

test('负向事件管理：未开放拦截，开放后支持配置、人员、违规记录流转、口令、审计、证据、备份恢复', async () => {
    const { call } = ctx;
    const base = '/api/department-reward-penalty';
    assert.equal((await call('bob', 'POST', `${base}/records`, {})).status, 403);
    await call('alice', 'PATCH', '/api/custom-tools/department-reward-penalty/distribution', { sharedAccess: true });
    const state0 = (await call('bob', 'GET', base)).data;
    assert.equal(state0.canEdit, false);
    assert.equal(state0.username, 'bob');
    assert.ok(state0.rules.find((r) => r.id === 'R01'), '自带默认规则');
    assert.ok(state0.roles.find((r) => r.value === 'TL'));
    assert.deepEqual(state0.personnel, []);

    // 配置与人员：仅管理员
    assert.equal((await call('bob', 'POST', `${base}/config/customerGroups`, { value: 'Orange' })).status, 403);
    const group = (await call('alice', 'POST', `${base}/config/customerGroups`, { value: 'Orange' })).data;
    assert.equal((await call('alice', 'POST', `${base}/config/customerGroups`, { value: 'orange' })).status, 409);
    assert.equal((await call('alice', 'POST', `${base}/personnel`, { id: 'z001', name: '张三', roles: ['TL'] })).status, 400, '在册人员必须有客户群');
    const person = (await call('alice', 'POST', `${base}/personnel`, { id: 'z001', name: '张三', roles: ['TL'], customerGroupIds: [group.id] })).data;
    assert.equal(person.role, 'TL');
    await call('alice', 'POST', `${base}/personnel`, { id: 'w002', name: '王五', roles: ['FME'], customerGroupIds: [group.id] });

    // 违规记录：普通用户提交草稿（角色要与规则匹配），只能改/删自己的；发布要管理员且写理由
    const draft = { date: '2026-11-03', staffId: 'z001', ruleId: 'R01', customerGroupId: group.id, tt: 'TT-1', remark: '十月进度未达标' };
    assert.match((await call('bob', 'POST', `${base}/records`, { ...draft, staffId: 'w002' })).data.error, /角色 FME 不匹配/);
    assert.equal((await call('bob', 'POST', `${base}/records`, { ...draft, date: '2026-13-40' })).data.error, '日期无效');
    const rec = (await call('bob', 'POST', `${base}/records`, draft)).data;
    assert.equal(rec.status, 'draft');
    assert.equal(rec.createdBy, 'bob');
    assert.equal(rec.personSnapshot.customerGroupName, 'Orange');
    assert.equal(rec.ruleSnapshot.deduct, state0.rules.find((r) => r.id === 'R01').deduct);
    assert.equal((await call('carol', 'POST', `${base}/records`, { ...draft, id: rec.id })).status, 403);
    assert.equal((await call('bob', 'POST', `${base}/records`, { ...draft, id: rec.id, action: 'publish', reason: 'x' })).status, 403);
    assert.equal((await call('alice', 'POST', `${base}/records`, { ...draft, id: rec.id, action: 'publish' })).data.error, '发布理由必填');
    const published = (await call('alice', 'POST', `${base}/records`, { ...draft, id: rec.id, action: 'publish', reason: '月度例会确认' })).data;
    assert.equal(published.status, 'published');
    assert.equal(published.createdBy, 'bob');
    assert.equal((await call('bob', 'DELETE', `${base}/records/${rec.id}`)).data.error, '只能删除待发布草稿');
    const temp = (await call('bob', 'POST', `${base}/records`, draft)).data;
    assert.equal((await call('carol', 'DELETE', `${base}/records/${temp.id}`)).status, 403);
    assert.equal((await call('bob', 'DELETE', `${base}/records/${temp.id}`)).status, 200);

    // 强制修改口令：默认 0000；改口令后旧口令失效；连续输错会被暂时锁定
    assert.equal((await call('alice', 'GET', `${base}/security`)).data.hasCustomPin, false);
    assert.equal((await call('alice', 'PUT', `${base}/security/pin`, { currentPin: '0000', newPin: 'abc' })).status, 400);
    assert.equal((await call('alice', 'PUT', `${base}/security/pin`, { currentPin: '1111', newPin: '2468' })).status, 403);
    assert.equal((await call('alice', 'PUT', `${base}/security/pin`, { currentPin: '0000', newPin: '2468' })).status, 200);
    assert.equal((await call('alice', 'GET', `${base}/security`)).data.hasCustomPin, true);
    assert.equal((await call('alice', 'POST', `${base}/records/${rec.id}/force-edit`, { ...draft, reason: '补充单号', pin: '0000' })).status, 403);
    const forced = (await call('alice', 'POST', `${base}/records/${rec.id}/force-edit`, { ...draft, tt: 'TT-2', reason: '补充单号', pin: '2468' })).data;
    assert.equal(forced.tt, 'TT-2');
    assert.equal(forced.forcedEditBy, 'alice');
    assert.equal((await call('alice', 'POST', `${base}/records/${rec.id}/revoke`, { reason: '申诉成立', pin: '2468' })).data.status, 'revoked');
    assert.equal((await call('alice', 'POST', `${base}/records/${rec.id}/archive`, {})).data.status, 'archived');
    assert.equal((await call('alice', 'POST', `${base}/records/${rec.id}/archive`, {})).status, 409);
    assert.equal((await call('alice', 'POST', `${base}/records/${rec.id}/unarchive`, {})).data.status, 'revoked');

    // 改配置名会带着引用一起改；被引用的配置删不掉
    const tl = (await call('alice', 'GET', base)).data.roles.find((r) => r.value === 'TL');
    const renamed = (await call('alice', 'PUT', `${base}/config/roles/${encodeURIComponent(tl.id)}`, { value: 'Team Lead' })).data;
    assert.ok(renamed.updatedReferences >= 2, '人员和规则里的角色一起改名');
    const state1 = (await call('alice', 'GET', base)).data;
    assert.deepEqual(state1.personnel.find((p) => p.id === 'z001').roles, ['Team Lead']);
    assert.ok(state1.rules.find((r) => r.id === 'R01').roles.includes('Team Lead'));
    assert.equal((await call('alice', 'DELETE', `${base}/config/customerGroups/${group.id}`)).status, 409);
    const batch = (await call('alice', 'POST', `${base}/personnel/batch`, { ids: ['z001', 'w002'], roles: { mode: 'add', values: ['SPM'] } })).data;
    assert.equal(batch.updatedCount, 2);

    // 证据附件
    const upload = new FormData();
    upload.append('file', new Blob([Buffer.from('proof')], { type: 'text/plain' }), '说明.txt');
    const evidence = await (await fetch(`${ctx.url}${base}/evidence`, { method: 'POST', headers: as('bob'), body: upload })).json();
    assert.match(evidence.path, /\/evidence\/[a-f0-9-]{36}\.txt$/);
    const file = await fetch(`${ctx.url}${evidence.path}`, { headers: as('carol') });
    assert.equal(await file.text(), 'proof');
    assert.match(file.headers.get('content-disposition'), /^inline/);

    // 审计：仅管理员；分页
    assert.equal((await call('bob', 'GET', `${base}/audit`)).status, 403);
    const audit = (await call('alice', 'GET', `${base}/audit?pageSize=5`)).data;
    assert.equal(audit.rows.length, 5);
    assert.ok(audit.total > 10);
    assert.equal(audit.rows[0].action, '上传证据', '最新的在前');
    assert.ok(audit.rows.every((r) => r.created_at && r.actor));

    // 备份 → 检查 → 增量恢复 → 覆盖恢复（要口令，恢复前自动留一份安全备份）
    const zipRes = await fetch(`${ctx.url}${base}/backup/export`, { headers: as('alice') });
    assert.equal(zipRes.status, 200);
    const zipBuffer = Buffer.from(await zipRes.arrayBuffer());
    assert.equal(zipBuffer.subarray(0, 2).toString(), 'PK');
    const form = (mode, pin) => { const f = new FormData(); f.append('file', new Blob([zipBuffer], { type: 'application/zip' }), 'backup.zip'); f.append('mode', mode); if (pin) f.append('pin', pin); return f; };
    const inspect = await (await fetch(`${ctx.url}${base}/backup/inspect`, { method: 'POST', headers: as('alice'), body: form('merge') })).json();
    assert.equal(inspect.valid, true);
    assert.equal(inspect.stats.personnel, 2);
    assert.equal(inspect.stats.evidenceFiles, 1);
    assert.equal(inspect.diff.personnel.update, 2);
    assert.equal((await fetch(`${ctx.url}${base}/backup/restore`, { method: 'POST', headers: as('bob'), body: form('merge') })).status, 403);
    // 备份之后又加了一个人：增量恢复保留他，覆盖恢复去掉他
    await call('alice', 'POST', `${base}/personnel`, { id: 'n003', name: '新人', roles: ['FME'], customerGroupIds: [group.id] });
    const merged = await (await fetch(`${ctx.url}${base}/backup/restore`, { method: 'POST', headers: as('alice'), body: form('merge') })).json();
    assert.equal(merged.counts.personnel, 2);
    assert.equal((await call('alice', 'GET', base)).data.personnel.length, 3);
    assert.equal((await fetch(`${ctx.url}${base}/backup/restore`, { method: 'POST', headers: as('alice'), body: form('replace', '0000') })).status, 403);
    const replaced = await (await fetch(`${ctx.url}${base}/backup/restore`, { method: 'POST', headers: as('alice'), body: form('replace', '2468') })).json();
    assert.equal(replaced.success, true, JSON.stringify(replaced));
    const state2 = (await call('alice', 'GET', base)).data;
    assert.deepEqual(state2.personnel.map((p) => p.id).sort(), ['w002', 'z001']);
    assert.equal(state2.records.find((r) => r.id === rec.id).status, 'revoked');
    assert.equal((await fetch(`${ctx.url}${evidence.path}`, { headers: as('carol') })).status, 200, '备份里的证据还在');
    assert.equal((await call('alice', 'GET', `${base}/snapshot/settings`)).status, 404);
});

test('NetCare 数据探查工具：表目录（实时 + 种子 + 标注）、字段画像、结构化查询、只读 SQL', async () => {
    const { toolByName } = await import('../src/agent/tools.js');
    const catalog = await import('../src/services/netcare/table-catalog.js');
    const run = (name, args) => toolByName.get(name).run(args, { identity: { username: 'alice', isAdmin: true } });
    const seen = [];
    // 假的业务库：两张表，其中一张不在盘点种子里（新表）
    ctx.mock.options.businessQuery = (sql) => {
        seen.push(sql);
        if (/information_schema\.TABLES/i.test(sql)) return [
            { name: 'risk_rectify_task_dwd', comment: '整改任务明细', est_rows: 1200, table_type: 'BASE TABLE' },
            { name: 'brand_new_table_0', comment: '', est_rows: 5, table_type: 'BASE TABLE' },
            { name: 'brand_new_table_1', comment: '', est_rows: 0, table_type: 'BASE TABLE' },
        ];
        if (/information_schema\.COLUMNS/i.test(sql) && /GROUP BY/i.test(sql)) return [{ name: 'risk_rectify_task_dwd', column_count: 3 }, { name: 'brand_new_table_0', column_count: 1 }];
        if (/information_schema\.COLUMNS/i.test(sql)) {
            if (!/'risk_rectify_task_dwd'/.test(sql)) return [];
            return [
                { name: 'task_id', data_type: 'varchar', column_type: 'varchar(64)', comment: '任务号', nullable: 'NO', column_key: 'PRI' },
                { name: 'region_code', data_type: 'varchar', column_type: 'varchar(32)', comment: '地区部', nullable: 'YES', column_key: '' },
                { name: 'create_time', data_type: 'bigint', column_type: 'bigint', comment: '创建时间', nullable: 'YES', column_key: '' },
            ];
        }
        if (/COUNT\(\*\)/i.test(sql)) return [{ region_code: 'R1', total: 7 }, { region_code: 'R2', total: 3 }];
        return [{ task_id: 'T1', region_code: 'R1', create_time: 1760000000000 }, { task_id: 'T2', region_code: 'SNULL', create_time: 1760000100000 }];
    };
    try {
        catalog.invalidate();
        // 找表：实时目录叠加种子；有数据的排前面，空表默认不出现；新表标出分区族
        const tables = await run('netcare_tables', { keyword: '整改 brand' });
        assert.equal(tables.ok, true, tables.content);
        assert.match(tables.content, /实时目录（netcare）/);
        assert.match(tables.content, /risk_rectify_task_dwd \| 整改任务明细/);
        assert.match(tables.content, /brand_new_table_0 .*分区族 brand_new_table/);
        assert.doesNotMatch(tables.content, /brand_new_table_1/);
        const listing = await catalog.listTables({ scope: 'business' });
        assert.equal(listing.live, true);
        assert.equal(listing.tables.find((t) => t.name === 'brand_new_table_0').isNew, true);
        assert.ok(listing.stats.missing > 400, '种子里有、库里没有的表标为缺失');

        // 管理员标注后，目录和字段说明里都能看到
        await catalog.saveNote('business', 'risk_rectify_task_dwd', { nameCn: '整改任务', description: '一行一个整改任务', timeField: 'create_time', verified: true }, 'alice');
        assert.match((await run('netcare_tables', { keyword: 'rectify' })).content, /risk_rectify_task_dwd \| 整改任务 \|.*\| 是 \| 一行一个整改任务/);
        const described = await run('netcare_describe', { table: 'risk_rectify_task_dwd' });
        assert.equal(described.ok, true, described.content);
        assert.match(described.content, /表 netcare\.risk_rectify_task_dwd（整改任务），3 个字段/);
        assert.match(described.content, /标注字段：时间=create_time.*已核对/);
        assert.match(described.content, /毫秒时间戳字段：create_time/);
        assert.match(described.content, /占位值：region_code=SNULL/);
        assert.equal((await run('netcare_describe', { table: 'no_such_table' })).ok, false);
        assert.equal((await run('netcare_describe', { table: 'a; drop table x' })).ok, false);

        // 结构化查询：字段必须真实存在，值统一转义，聚合在库里做
        const grouped = await run('netcare_query', { table: 'risk_rectify_task_dwd', filters: [{ column: 'region_code', op: 'in', value: ['R1', "R'2"] }], groupBy: ['region_code'], metrics: [{ agg: 'count', as: 'total' }] });
        assert.equal(grouped.ok, true, grouped.content);
        assert.equal(grouped.output, "SELECT `region_code`, COUNT(*) AS `total` FROM `netcare`.`risk_rectify_task_dwd` WHERE `region_code` IN ('R1', 'R''2') GROUP BY `region_code` ORDER BY `total` DESC LIMIT 100");
        assert.match(grouped.content, /共 2 行/);
        assert.match((await run('netcare_query', { table: 'risk_rectify_task_dwd', columns: ['password'] })).content, /表中没有字段 password/);

        // SQL：只读、单条
        assert.equal((await run('netcare_sql', { sql: 'SELECT task_id FROM netcare.risk_rectify_task_dwd' })).ok, true);
        assert.match(seen.at(-1), /LIMIT 200 OFFSET 0$/, '没有 LIMIT 时自动分页');
        for (const bad of ['DELETE FROM netcare.t', 'SELECT 1; SELECT 2', 'SELECT * FROM t INTO OUTFILE \'/tmp/x\'', 'UPDATE t SET a = 1', 'SELECT SLEEP(10)']) {
            assert.equal((await run('netcare_sql', { sql: bad })).ok, false, bad);
        }
        // 工具清单里有单独一组，管理员可以整组停用
        const groups = (await ctx.call('alice', 'GET', '/api/agent-mcp/catalog')).data.groups;
        assert.deepEqual(groups.find((g) => g.id === 'netcare').tools.map((t) => t.name), ['netcare_tables', 'netcare_describe', 'netcare_query', 'netcare_sql']);
    } finally {
        delete ctx.mock.options.businessQuery;
        catalog.invalidate();
    }
});

test('内置技能里有 NetCare 数据（未开放前普通用户 403，开放后可用）', async () => {
    assert.equal((await ctx.call('bob', 'GET', '/api/agent-skills/netcare-data')).status, 403);
    assert.equal((await ctx.call('alice', 'GET', '/api/agent-skills/netcare-data')).status, 200);
    await ctx.call('alice', 'PATCH', '/api/distribution', { kind: 'skill', id: 'netcare-data', sharedAccess: true });
    const skill = (await ctx.call('bob', 'GET', '/api/agent-skills/netcare-data')).data.skill;
    assert.equal(skill.name, 'NetCare 数据');
    assert.match(skill.body, /netcare_tables/);
    assert.match(skill.body, /op_ioc_rectify_check_d_dws/, '专题速查保留');
    assert.doesNotMatch(skill.body, /scope=app|全局设置 › 频道对接/, '没有主线版的应用库写入和配置步骤');
});

test('跟进任务：创建、去重、只看本人、更新、暂停恢复、到期提醒进消息中心、关闭', async () => {
    const { toolByName } = await import('../src/agent/tools.js');
    const { remindDueFollowups, getFollowup } = await import('../src/services/followup-service.js');
    const run = (user, name, args) => toolByName.get(name).run(args, { identity: { username: user, identified: true } });
    const parse = (out) => JSON.parse(out.content);

    const created = await run('bob', 'followup_create', { title: '催 Orange 割接方案', urgency: 'high', inMinutes: 30, assignees: [{ name: '王五', account: 'carol' }], nextRemindNote: '问方案是否评审' });
    assert.equal(created.ok, true, created.content);
    const id = parse(created).task.id;
    assert.match(id, /^fu_[0-9a-f]{16}$/);
    assert.equal(parse(created).task.urgency, '高');
    assert.equal((await run('bob', 'followup_create', { title: '催 Orange 割接方案' })).summary, '已存在：催 Orange 割接方案');
    assert.equal(parse(await run('bob', 'followup_list', {})).count, 1);
    assert.equal(parse(await run('carol', 'followup_list', {})).count, 0, '别人的任务看不到');
    assert.equal((await run('carol', 'followup_close', { id })).ok, false, '也关不了');
    assert.equal((await run('bob', 'followup_create', { title: ' ' })).ok, false);

    // 记进度、改频率、暂停再恢复
    const progressed = parse(await run('bob', 'followup_update', { id, progress: '方案已提交评审' })).task;
    assert.equal(progressed.progress, '方案已提交评审');
    assert.equal(parse(await run('bob', 'followup_update', { id, pause: true })).task.status, '已暂停');
    assert.equal(parse(await run('bob', 'followup_update', { id, pause: false, inMinutes: 1 })).task.status, '跟进中');

    // 到期：提醒发给创建人和填了工号的相关人；推算下一次；没到期的不提醒
    assert.equal(await remindDueFollowups(new Date()), 0);
    const later = new Date(Date.now() + 2 * 60_000);
    assert.equal(await remindDueFollowups(later), 1);
    for (const user of ['bob', 'carol']) {
        const events = (await ctx.call(user, 'GET', '/api/alert-center/events')).data.events;
        const reminder = events.find((e) => e.title === '跟进提醒：催 Orange 割接方案');
        assert.ok(reminder, `${user} 收到提醒`);
        assert.match(reminder.message, /第 1 次提醒.*\n本次要跟进：问方案是否评审\n上次进展：方案已提交评审/);
    }
    const after = await getFollowup(id);
    assert.equal(after.remindCount, 1);
    assert.ok(Date.parse(after.nextRemindAt) > later.getTime(), '推算了下一次');
    assert.equal(await remindDueFollowups(later), 0, '同一时刻不会重复提醒');

    const closed = parse(await run('bob', 'followup_close', { id, note: '评审通过' })).task;
    assert.equal(closed.status, '已完成');
    assert.equal(closed.nextRemindAt, null);
    assert.equal(parse(await run('bob', 'followup_list', {})).count, 0);
    assert.equal(parse(await run('bob', 'followup_list', { includeClosed: true })).count, 1);
    assert.equal(await remindDueFollowups(new Date(Date.now() + 86_400_000 * 30)), 0, '关闭后不再提醒');
});

test('工具使用说明：平台页面、内置工具都能查到；没有的工具给出提示', async () => {
    const { toolByName } = await import('../src/agent/tools.js');
    const run = (args) => toolByName.get('read_tool_guide').run(args, { identity: { username: 'bob', identified: true } });
    const sla = await run({ tool: '数据导入' });
    assert.equal(sla.ok, true);
    assert.match(sla.content, /^# 数据导入\n入口：\/sla\n\n摘要：/);
    const reward = await run({ tool: 'reward-program' });
    assert.match(reward.content, /入口：\/custom-tools\/reward-program\/[\s\S]*## 怎么用/);
    const explorer = await run({ tool: '/db-explorer' });
    assert.match(explorer.content, /MySQL/);
    assert.doesNotMatch(explorer.content, /SQLite|超级管理员/, '用的是基座 Web 版自己的说明');
    assert.equal((await run({ tool: '光影大厅' })).ok, false);
    const found = await toolByName.get('find_platform_tools').run({ query: '需求' }, { identity: { username: 'bob' } });
    assert.match(found.content, /需求广场/);
    // 若管理员关闭了某个内置工具的开放，普通用户对话里 read_tool_guide / find_platform_tools 也找不到
    await ctx.call('alice', 'PATCH', '/api/custom-tools/reward-program/distribution', { sharedAccess: false });
    assert.equal((await run({ tool: 'reward-program' })).ok, false);
    assert.equal((await toolByName.get('read_tool_guide').run({ tool: 'reward-program' }, { identity: { username: 'alice', isSuper: true } })).ok, true);
    await ctx.call('alice', 'PATCH', '/api/custom-tools/reward-program/distribution', { sharedAccess: true });
});

test('消息中心 AI 摘要：警告级消息后台生成一句话摘要，所有收件人的那份一起写回；普通消息和模型失败不写', async () => {
    const { pushAlert } = await import('../src/services/alert-service.js');
    const { drainAlertAnalysis } = await import('../src/services/alert-ai-service.js');
    const { call, mock } = ctx;
    // 没配模型：不写摘要，界面显示原文
    await pushAlert(['dave', 'erin'], { severity: 'warn', title: '定时任务执行失败：周报汇总', message: '执行超时（5 分钟）' });
    await drainAlertAnalysis();
    assert.equal((await call('dave', 'GET', '/api/alert-center/events')).data.events[0].ai_summary, undefined);

    assert.equal((await call('alice', 'POST', '/api/ai-settings/profiles', { name: 'MockLLM', baseUrl: `${mock.baseUrl}/v1`, apiKey: 'test-key-000', model: 'test-model', activate: true })).status, 201);
    mock.options.completionText = '周报汇总定时任务超时未完成，需要管理员检查模型网关或缩小汇总范围。';
    const before = mock.aiRequests.length;
    await pushAlert(['dave', 'erin'], { severity: 'error', title: '模型故障：主模型连续失败', message: 'HTTP 502，token=sk-abcdefghijklmnop1234 已切换备用方案', detail: { profile: 'main' } });
    await pushAlert(['dave'], { severity: 'info', title: '定时任务已完成：日报', message: '已生成' });
    await drainAlertAnalysis();
    const prompts = mock.aiRequests.slice(before).filter((r) => !r.stream);
    assert.equal(prompts.length, 1, '只分析警告及以上的消息');
    assert.doesNotMatch(JSON.stringify(prompts[0].messages), /sk-abcdefghijklmnop1234/, '口令先脱敏再交给模型');
    for (const user of ['dave', 'erin']) {
        const events = (await call(user, 'GET', '/api/alert-center/events')).data.events;
        const failed = events.find((e) => e.title === '模型故障：主模型连续失败');
        assert.equal(failed.ai_summary, mock.options.completionText, `${user} 的那份也写回了`);
        assert.equal(failed.ai_status, 'done');
    }
    assert.equal((await call('dave', 'GET', '/api/alert-center/events')).data.events.find((e) => e.title === '定时任务已完成：日报').ai_summary, undefined);

    // 补做：把本人还没有摘要的警告重新排队
    const backfill = (await call('dave', 'POST', '/api/alert-center/ai/backfill', {})).data;
    assert.equal(backfill.queued, 1);
    await drainAlertAnalysis();
    const timeout = (await call('dave', 'GET', '/api/alert-center/events')).data.events.find((e) => e.title === '定时任务执行失败：周报汇总');
    assert.equal(timeout.ai_summary, mock.options.completionText);
    assert.equal((await call('erin', 'GET', '/api/alert-center/events')).data.events.find((e) => e.title === '定时任务执行失败：周报汇总').ai_summary, undefined, '补做只作用于本人');
    delete mock.options.completionText;
});

test('平台效能统计：按本应用库的业务量折算，返回结构与主线版一致', async () => {
    const { call } = ctx;
    assert.equal((await call('bob', 'POST', '/api/platform-metrics/open', { toolKey: 'custom:reward-program' })).data.tracked, true);
    await call('bob', 'POST', '/api/platform-metrics/open', { toolKey: 'Custom:Reward-Program' });
    const summary = (await call('bob', 'GET', '/api/platform-metrics/summary')).data;
    for (const key of ['metricChecks', 'serviceCount', 'manualEquivalentHours', 'savedHours', 'efficiencyRate', 'onlineTools', 'scripts', 'history', 'trackedOpens']) {
        assert.equal(typeof summary.totals[key], 'number', key);
    }
    assert.ok(summary.totals.trackedOpens >= 2);
    assert.equal(summary.customToolStats['reward-program'].primary, 2, '工具标识统一成小写后累计');
    assert.ok(summary.totals.onlineTools >= 13 + 5, '平台页面 + 内置工具');
    // 前面的用例留下：需求 1 条（创建、接受、拒绝 3 次流转），消息 AI 摘要 2 条
    assert.deepEqual([summary.toolStats.requirements.primary, summary.toolStats.requirements.secondary], [1, 3]);
    assert.equal(summary.ai.analyzedAlerts, 2);
    assert.equal(summary.ai.savedHours, Math.round((summary.ai.answers * 8 + 2 * 3) / 60));
    assert.match(summary.methodology.note, /保守/);
});

test('英文语言切换：所有首页静态工具卡片、内置工具与内置技能均有完整英文名称与说明', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const vm = await import('node:vm');
    const rootDir = path.resolve(import.meta.dirname, '..');

    // 1. manifest & /api/custom-tools built-ins
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'static/builtin-tools/manifest.json'), 'utf8'));
    assert.ok(manifest.tools.length >= 5);
    for (const tool of manifest.tools) {
        assert.ok(tool.nameEn && !/[\u4e00-\u9fa5]/.test(tool.nameEn), `${tool.slug} missing English nameEn: ${tool.nameEn}`);
        assert.ok(tool.descriptionEn && !/[\u4e00-\u9fa5]/.test(tool.descriptionEn), `${tool.slug} missing English descriptionEn`);
        assert.ok(Array.isArray(tool.tagsEn) && tool.tagsEn.length > 0, `${tool.slug} missing English tagsEn`);
    }
    const { call } = ctx;
    const customTools = (await call('alice', 'GET', '/api/custom-tools')).data;
    for (const slug of manifest.tools.map((t) => t.slug)) {
        const found = customTools.find((t) => t.slug === slug);
        assert.ok(found && found.nameEn && found.descriptionEn, `/api/custom-tools should expose nameEn & descriptionEn for ${slug}`);
    }

    // 2. Every static card href in index.html maps to HOME_CARDS via homeCardKey under root & subpath URLs
    const indexHtml = fs.readFileSync(path.join(rootDir, 'static/index.html'), 'utf8');
    const homeToolsJs = fs.readFileSync(path.join(rootDir, 'static/js/home/home-tools.js'), 'utf8');
    const cardsBlock = homeToolsJs.match(/const HOME_CARDS = \{[\s\S]*?\n        \};\n\s*if \(window\.ToolsI18n\)/)?.[0]?.replace(/\n\s*if \(window\.ToolsI18n\)[\s\S]*$/, '');
    const keyFnBlock = homeToolsJs.match(/function homeCardKey\(href\)[\s\S]*?\n        \}/)?.[0];
    assert.ok(cardsBlock && keyFnBlock, 'HOME_CARDS and homeCardKey exist in home-tools.js');
    const { HOME_CARDS, homeCardKey } = vm.runInNewContext(
        `${cardsBlock}\n${keyFnBlock}\n({ HOME_CARDS, homeCardKey })`,
        { URL, window: { location: { origin: 'https://example.test' }, dhStripPrefix: (p) => p.replace(/^\/digital-human\/dh\/[0-9a-f-]+/i, '') } },
    );

    const gridMatch = indexHtml.match(/<div class="tools-grid" id="toolsGrid">([\s\S]*?)<\/div>\s*\n\s*<!-- 插件与脚本/);
    assert.ok(gridMatch, 'toolsGrid block exists in index.html');
    const hrefs = [...gridMatch[1].matchAll(/<a href="([^"]+)" class="tool-card/g)].map((m) => m[1]);
    assert.ok(hrefs.length >= 13);
    for (const href of hrefs) {
        for (const variant of [href, `/${href}`, `/digital-human/dh/aaaaaaaa-0000-4000-8000-000000000000/${href}.html`]) {
            const key = homeCardKey(variant);
            const card = HOME_CARDS[key];
            assert.ok(card, `missing HOME_CARDS entry for ${variant} -> ${key}`);
            assert.ok(card.title['en-US'] && !/[\u4e00-\u9fa5]/.test(card.title['en-US']), `${key} en-US title has Chinese`);
            assert.ok(card.desc['en-US'] && !/[\u4e00-\u9fa5]/.test(card.desc['en-US']), `${key} en-US desc has Chinese`);
            assert.ok(Array.isArray(card.tags['en-US']) && card.tags['en-US'].length > 0, `${key} missing en-US tags`);
        }
    }

    // 3. Built-in skills frontmatter has bilingual name_en & description_en
    const skillsDir = path.join(rootDir, 'src/agent/builtin-skills');
    const skillFiles = fs.readdirSync(skillsDir).filter((f) => f.endsWith('.md'));
    assert.ok(skillFiles.length >= 8);
    for (const file of skillFiles) {
        const md = fs.readFileSync(path.join(skillsDir, file), 'utf8');
        const nameEn = /^name_en:\s*(.+)$/m.exec(md)?.[1]?.trim() || '';
        const descEn = /^description_en:\s*(.+)$/m.exec(md)?.[1]?.trim() || '';
        assert.ok(nameEn && !/[\u4e00-\u9fa5]/.test(nameEn), `${file} missing English name_en`);
        assert.ok(descEn && !/[\u4e00-\u9fa5]/.test(descEn), `${file} missing English description_en`);
    }
});

test('基座版输入框加号菜单、UI.Vision 本地批脚本/浮窗脚本禁用提示与日志 Token 统计脱敏修复', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { pushLog } = await import('../src/core/log-ring.js');
    const rootDir = path.resolve(import.meta.dirname, '..');

    // 1. 日志脱敏保留数值型 Token 计数（promptTokens / completionTokens / inputTokens / outputTokens），同时继续脱敏密钥
    const entry = pushLog({
        level: 'INFO',
        category: 'AI',
        message: 'completion test',
        detail: {
            promptTokens: 320,
            completionTokens: 128,
            inputTokens: 450,
            outputTokens: 210,
            apiKey: 'sk-secret-value',
            token: 'bearer-secret-token',
        },
    });
    assert.equal(entry.detail.promptTokens, 320);
    assert.equal(entry.detail.completionTokens, 128);
    assert.equal(entry.detail.inputTokens, 450);
    assert.equal(entry.detail.outputTokens, 210);
    assert.equal(entry.detail.apiKey, '[REDACTED]');
    assert.equal(entry.detail.token, '[REDACTED]');

    // 2. agent-discussion.js 与 composer-controls.js：首屏未同步 tools_role 时点击 #dcAttach 不抛错，且支持 tools:authchange 动态刷新
    const agentDiscJs = fs.readFileSync(path.join(rootDir, 'static/js/home/agent-discussion.js'), 'utf8');
    const composerControlsJs = fs.readFileSync(path.join(rootDir, 'static/js/home/composer-controls.js'), 'utf8');
    assert.match(agentDiscJs, /const popover = root\?\.querySelector\('\.dc-connector-popover'\);/);
    assert.match(agentDiscJs, /window\.addEventListener\('tools:authchange'/);
    assert.match(composerControlsJs, /try \{ window\.HomeAgentDiscussion\?\.closePicker\?\.\(\); \} catch \{\}/);

    // 3. 基座版（dh-web）禁用数据抓取页 UI.Vision 一键批脚本与插件下载，但保留浮窗脚本（手动 F12 复制）可用
    const trimCss = fs.readFileSync(path.join(rootDir, 'static/css/dh-web-trim.css'), 'utf8');
    const dhRuntimeJs = fs.readFileSync(path.join(rootDir, 'static/js/shared/dh-runtime.js'), 'utf8');
    const uivCopyJs = fs.readFileSync(path.join(rootDir, 'static/js/uivf12/copy.js'), 'utf8');
    const uivExtGuideJs = fs.readFileSync(path.join(rootDir, 'static/js/uivf12/extension-guide.js'), 'utf8');
    const openxUrl = 'https://openx.huawei.com/Egypt_CNBG_CS_Tools_Platform/overview';

    assert.ok(trimCss.includes('html.dh-web .btn-batch-uiv-run'));
    assert.ok(!trimCss.includes('.btn-batch-site-console') && !trimCss.includes('[data-cap-group="float"]'), 'floating script entry must stay enabled in dh-web');
    assert.ok(dhRuntimeJs.includes(openxUrl), 'dh-runtime.js includes OpenX desktop download URL');
    assert.ok(dhRuntimeJs.includes('dhOpenxDesktopTooltip') && dhRuntimeJs.includes('dhApplyUivDisabledState'));
    assert.ok(!dhRuntimeJs.includes('.btn-batch-site-console') && !dhRuntimeJs.includes('[data-cap-group="float"]'));
    assert.match(uivCopyJs, /function isDhWebUivDisabled\(/);
    assert.match(uivCopyJs, /async function runAllUivScriptsDirect[\s\S]{0,160}isDhWebUivDisabled/);
    assert.match(uivCopyJs, /async function runTestUivScriptsDirect[\s\S]{0,160}isDhWebUivDisabled/);
    assert.doesNotMatch(uivCopyJs, /async function openSiteConsoleScriptPicker[\s\S]{0,160}isDhWebUivDisabled/);
    assert.match(uivExtGuideJs, /document\.documentElement\?\.classList\?\.contains\('dh-web'\)/);
});

test('对话附件上传：普通用户支持 JSON base64 与分块上传（绕过基座网关 multipart/403 限制）', async () => {
    const { call } = ctx;
    const sample = JSON.stringify({ hello: 'world', sql: 'SELECT * FROM test', html: '<script>1</script>' });
    const b64 = Buffer.from(sample, 'utf8').toString('base64');

    // 1. 小文件直传 JSON base64（非管理员用户 bob）
    const direct = await call('bob', 'POST', '/api/ai/uploads', {
        files: [{ name: 'dragon-claw-log.json', mimeType: 'application/json', dataBase64: b64 }],
    });
    assert.equal(direct.status, 200, JSON.stringify(direct.data));
    assert.equal(direct.data.files.length, 1);
    assert.equal(direct.data.files[0].name, 'dragon-claw-log.json');
    assert.equal(direct.data.files[0].readable, true);

    // 2. 分块上传（start -> chunk -> complete），并校验跨用户隔离
    const mid = Math.ceil(b64.length / 2);
    const start = await call('bob', 'POST', '/api/ai/uploads/start', {
        name: 'chunked-log.json',
        mimeType: 'application/json',
        totalBytes: b64.length,
        totalChunks: 2,
    });
    assert.equal(start.status, 200);
    assert.ok(start.data.uploadId);
    assert.equal((await call('carol', 'POST', `/api/ai/uploads/${start.data.uploadId}/chunk`, { index: 0, data: b64.slice(0, mid) })).status, 404);
    assert.equal((await call('bob', 'POST', `/api/ai/uploads/${start.data.uploadId}/chunk`, { index: 0, data: b64.slice(0, mid) })).data.receivedChunks, 1);
    assert.equal((await call('bob', 'POST', `/api/ai/uploads/${start.data.uploadId}/chunk`, { index: 1, data: b64.slice(mid) })).data.receivedChunks, 2);
    const done = await call('bob', 'POST', `/api/ai/uploads/${start.data.uploadId}/complete`, {});
    assert.equal(done.status, 200);
    assert.equal(done.data.files[0].name, 'chunked-log.json');
    assert.equal(done.data.files[0].size, Buffer.byteLength(sample));
});

test('脱敏保留用户名：复合账号密码与 URL 中的 admin 不误脱敏', async () => {
    const { redactText } = await import('../src/agent/redact.js');
    const urlMasked = redactText('请求地址 https://admin:SuperSecret99@example.com/api');
    assert.ok(urlMasked.includes('https://admin:[已隐藏]@example.com/api'), urlMasked);
    assert.ok(!urlMasked.includes('SuperSecret99'), urlMasked);

    const compoundMasked = redactText('账号密码: admin / SuperSecret99，请登录后导出');
    assert.ok(compoundMasked.includes('admin'), compoundMasked);
    assert.ok(compoundMasked.includes('[已隐藏]'), compoundMasked);
    assert.ok(!compoundMasked.includes('SuperSecret99'), compoundMasked);
});

test('基座催办通知下发：预览可滚动、历史检索、工号分组与无首字母工号解析', async () => {
    const { call } = ctx;
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

    // 1. 前端预览区滚动与历史/分组/去首字母 UI 控件校验
    const expediteHtml = fs.readFileSync(path.join(rootDir, 'static/expedite.html'), 'utf8');
    assert.match(expediteHtml, /#base-notify-preview\s*\{[^}]*overflow-y:\s*auto/i);
    assert.match(expediteHtml, /id="base-notify-history-search"/);
    assert.match(expediteHtml, /id="base-notify-groups-bar"/);
    assert.match(expediteHtml, /function saveCurrentNotifyGroup\(/);
    assert.match(expediteHtml, /function isLetterlessNotifyId\(/);

    // 2. 写入已知员工数据并验证 /api/expedite/notify-recipients 检索池
    const ownerRes = await call('alice', 'POST', '/api/db/bigscreen_owners', {
        items: [{ cat_name: '整体', metric_label: 'demo_kpi', emp_id: 'd00548379', owner_name: '张三' }],
    });
    assert.equal(ownerRes.status, 200);

    const dir1 = await call('alice', 'GET', '/api/expedite/notify-recipients');
    assert.equal(dir1.status, 200);
    assert.ok(Array.isArray(dir1.data.knownEmployees));
    assert.ok(dir1.data.knownEmployees.some(e => e.id === 'd00548379' && e.name === '张三'));

    // 3. 创建与删除工号自定义分组
    const groupRes = await call('alice', 'POST', '/api/expedite/notify-groups', {
        name: '核心值班组',
        members: [
            { id: 'd00548379', name: '张三' },
            { id: 'l00123456', name: '李四' },
        ],
    });
    assert.equal(groupRes.status, 200);
    assert.equal(groupRes.data.success, true);
    assert.equal(groupRes.data.groups.length, 1);
    const savedGroupId = groupRes.data.group.id;

    // 4. 下发通知：无首字母已知工号 00548379 自动匹配 d00548379；未知无首字母 00998877 自动扩展 a..z 前缀
    const notifyRes = await call('alice', 'POST', '/api/expedite/notify', {
        recipients: ['00548379', '00998877', 'l00123456'],
        recipientNames: { l00123456: '李四' },
        title: '催办测试',
        content: '测试内容',
    });
    assert.equal(notifyRes.status, 200, JSON.stringify(notifyRes.data));
    assert.equal(notifyRes.data.success, true);
    assert.ok(notifyRes.data.resolvedRecipients.includes('d00548379'), JSON.stringify(notifyRes.data.resolvedRecipients));
    assert.ok(notifyRes.data.resolvedRecipients.includes('l00123456'));
    assert.ok(notifyRes.data.payload.receivers.includes('00998877'));
    assert.ok(notifyRes.data.payload.receivers.includes('d00998877'));
    assert.equal(
        notifyRes.data.resolutions.find(r => r.raw === '00548379')?.matchedBy,
        'prefix-lookup'
    );
    assert.equal(
        notifyRes.data.resolutions.find(r => r.raw === '00998877')?.matchedBy,
        'prefix-expand'
    );

    // 5. 下发成功后自动写入历史，并且支持删除自定义分组
    const dir2 = await call('alice', 'GET', '/api/expedite/notify-recipients');
    assert.equal(dir2.status, 200);
    assert.ok(dir2.data.history.some(h => h.id === 'd00548379' && h.useCount >= 1));
    assert.ok(dir2.data.history.some(h => h.id === 'l00123456' && h.name === '李四'));

    const delRes = await call('alice', 'DELETE', `/api/expedite/notify-groups/${encodeURIComponent(savedGroupId)}`);
    assert.equal(delRes.status, 200);
    assert.equal(delRes.data.groups.length, 0);
});

test('基座版导入自定义工具：移除 Python Web 应用托管提示并拦截 Python 包上传', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const homeToolsJs = fs.readFileSync(path.join(rootDir, 'static/js/home/home-tools.js'), 'utf8');

    assert.doesNotMatch(homeToolsJs, /'home\.import\.fileHint':\s*'[^']*Python Web/);
    assert.doesNotMatch(homeToolsJs, /\/api\/hosted-apps\/preview/);
    assert.match(homeToolsJs, /'home\.import\.pyUnsupportedWeb':/);
    assert.match(homeToolsJs, /function rejectPythonInBaseWeb|const rejectPythonInBaseWeb = \(\) =>/);
});

test('催办站内横幅闭环：下发写入被通知人未读消息（含无首字母工号），已读前刷新持续保留', async () => {
    const { call } = ctx;
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

    // 1. 静态检查首页主题一致右上角横幅与消息详情展开样式/逻辑
    const homeShellJs = fs.readFileSync(path.join(rootDir, 'static/js/home/home-shell.js'), 'utf8');
    const homeShellCss = fs.readFileSync(path.join(rootDir, 'static/css/home-shell.css'), 'utf8');
    assert.match(homeShellJs, /async function refreshExpediteBanner\(/);
    assert.match(homeShellJs, /async function markExpediteAlertsRead\(/);
    assert.match(homeShellJs, /object_type === 'expedite_notify'/);
    assert.match(homeShellCss, /\.v2-expedite-banner\s*\{/);
    assert.match(homeShellCss, /\.v2-msg\.is-expanded \.v2-msg-text p/);

    // 2. 下发催办通知给 d00548379(通过 00548379) 及未录入前缀的 00778899
    const notifyRes = await call('alice', 'POST', '/api/expedite/notify', {
        recipients: ['00548379', '00778899'],
        title: '10月指标催办提醒',
        content: '请尽快核查未达标指标并完成整改。',
    });
    assert.equal(notifyRes.status, 200);
    assert.ok(notifyRes.data.inAppAlertSent >= 2);

    // 3. 诊断自检 /api/debug/notify-test 不应写入真实用户的催办横幅队列
    await call('alice', 'POST', '/api/debug/notify-test', {
        recipients: ['bob'],
        title: '调试探测消息',
        content: '不应进入用户催办横幅',
    });
    const bobUnread = await call('bob', 'GET', '/api/alert-center/events?status=unread');
    assert.equal(bobUnread.status, 200);
    assert.equal(bobUnread.data.events.some(e => e.object_type === 'expedite_notify'), false);

    // 4. 用户每次刷新（重复拉取未读列表）均可稳定拿到该未读催办，直到标已读
    const zUnread1 = await call('z00778899', 'GET', '/api/alert-center/events?status=unread');
    assert.equal(zUnread1.status, 200);
    const expAlert = zUnread1.data.events.find(e => e.object_type === 'expedite_notify' && e.title === '10月指标催办提醒');
    assert.ok(expAlert, JSON.stringify(zUnread1.data.events));

    const zUnread2 = await call('z00778899', 'GET', '/api/alert-center/events?status=unread');
    assert.equal(zUnread2.data.events.some(e => e.id === expAlert.id), true);

    // 5. 点击已读或进入消息中心查看后，未读横幅消息清除
    const readRes = await call('z00778899', 'PUT', '/api/alert-center/events/read', { ids: [expAlert.id] });
    assert.equal(readRes.status, 200);
    assert.ok(readRes.data.changed >= 1);
    const zUnread3 = await call('z00778899', 'GET', '/api/alert-center/events?status=unread');
    assert.equal(zUnread3.data.events.some(e => e.id === expAlert.id), false);
});

test('诊断控制台增强：新增最新自检探针与一键收集所有自检详细日志', async () => {
    const { call } = ctx;
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

    const kvRes = await call('alice', 'POST', '/api/debug/test/kv-roundtrip', {});
    assert.equal(kvRes.status, 200);
    assert.equal(kvRes.data.result.intact, true);

    const bizRes = await call('alice', 'POST', '/api/debug/test/query-business', {});
    assert.equal(bizRes.status, 200);
    assert.ok(Array.isArray(bizRes.data.result.rows));

    const alertCheck = await call('alice', 'POST', '/api/debug/test/alert-notify-check', {});
    assert.equal(alertCheck.status, 200);
    assert.equal(alertCheck.data.result.code, 0);
    assert.ok(typeof alertCheck.data.result.expediteHistoryCount === 'number');

    const redactCheck = await call('alice', 'POST', '/api/debug/test/redact-check', {});
    assert.equal(redactCheck.status, 200);
    assert.equal(redactCheck.data.result.passed, true);

    const dbgJs = fs.readFileSync(path.join(rootDir, 'static/js/shared/dh-debug-widget.js'), 'utf8');
    assert.match(dbgJs, /action: 'kv-roundtrip'/);
    assert.match(dbgJs, /action: 'query-business'/);
    assert.match(dbgJs, /action: 'alert-notify-check'/);
    assert.match(dbgJs, /action: 'redact-check'/);
    assert.match(dbgJs, /一键收集所有自检详细日志/);
    assert.match(dbgJs, /runOutboundCheckProbe/);
    assert.match(dbgJs, /runStreamCheckProbe/);
    assert.match(dbgJs, /dh-diagnostic-/);
});

test('自定义菜单栏：前后端菜单项对齐（含 requirements）且支持读写与缺项兼容', async () => {
    const { call } = ctx;
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

    const menuRes = await call('bob', 'GET', '/api/sidebar-menu');
    assert.equal(menuRes.status, 200);
    assert.ok(menuRes.data.more.includes('requirements'), JSON.stringify(menuRes.data));
    const allIds = [...menuRes.data.primary, ...menuRes.data.more];

    const sidebarJs = fs.readFileSync(path.join(rootDir, 'static/js/home/sidebar-menu.js'), 'utf8');
    for (const id of allIds) {
        assert.ok(sidebarJs.includes(`'${id}'`), `sidebar-menu.js missing entry: ${id}`);
    }
    assert.match(sidebarJs, /function normalizeLayout\(/);

    const saved = await call('bob', 'PUT', '/api/sidebar-menu', {
        primary: ['channels', 'skillHub', 'schedule', 'library', 'requirements'],
        more: ['opsDrafts', 'links', 'promotions'],
    });
    assert.equal(saved.status, 200);
    assert.ok(saved.data.primary.includes('requirements'));
    const reloaded = await call('bob', 'GET', '/api/sidebar-menu');
    assert.deepEqual(reloaded.data, saved.data);
});
