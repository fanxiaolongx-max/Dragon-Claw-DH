// 业务页面（专题分析、值班表、FRT 核算、PR 稽查）：四个页面共用统一记录表 biz_records。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockBaseServer } from './helpers/mock-base.js';

const as = (user) => ({ cookie: `iLearningXUserName=${user}` });

const netcareSnapshot = (month, srTotal) => ({
    schema: 'uivf12-topic-snapshot',
    version: 1,
    platform: 'netcare',
    capturedAt: `2026-${String(month).padStart(2, '0')}-28T08:00:00.000Z`,
    exportedAt: `2026-${String(month).padStart(2, '0')}-28T08:05:00.000Z`,
    settings: { year: 2026, month },
    data: {
        certificate: [{ need_reduce_cnt: 10, reduced_cnt: 4 }],
        eosProduct: [{ customer_name: 'Customer A', product_name: 'P1', incorporation_total_nes: 20, incorporated_nes: 5, to_be_incorporated_nes: 15 }],
        eosVersion: [],
        change: { currentYear: 2026, previousYear: 2025, currentMonth: month, rows: [
            { scope: 'TOTAL', year: 2026, month: 1, task_count: 30, rollback_count: 1, high_core_total_count: 2, operation_success_rate: 0.99 },
            { scope: 'TOTAL', year: 2025, month: 1, task_count: 20 },
        ] },
        interception: { currentYear: 2026, previousYear: 2025, currentMonth: month, rows: [] },
        sr: { currentYear: 2026, currentMonth: month, monthly: [], summary: [
            { scope: 'TOTAL', period: 'currentYtd', sr_total: srTotal, sr_frt: 0.95, unclose_sr_cnt: 3 },
            { scope: 'TOTAL', period: 'previousYtd', sr_total: 100 },
        ] },
    },
});

test('专题分析、值班表、FRT 核算、PR 稽查：统一记录表上的读写、权限与计算', async () => {
    const mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        APP_SCHEMA: 'business-test',
        APP_UUID: 'business-test',
        APP_DATASOURCE_ID: '2',
    });
    delete process.env.DH_OPEN_ADMIN;
    delete process.env.DH_ADMIN_USERS;
    const { createServer } = await import('../src/server.js');
    const app = await createServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const call = async (user, method, path, body) => {
        const res = await fetch(`${url}${path}`, { method, headers: body === undefined ? as(user) : { 'Content-Type': 'application/json', ...as(user) }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { data = text; }
        return { status: res.status, data };
    };

    try {
        assert.equal((await call('alice', 'GET', '/api/auth/me')).data.isAdmin, true);
        assert.equal((await call('bob', 'GET', '/api/auth/me')).data.isAdmin, false);
        for (const page of ['/topic-analysis', '/duty-roster', '/frt', '/praudit']) {
            const res = await fetch(`${url}${page}`, { headers: as('bob') });
            assert.equal(res.status, 200, page);
            assert.match(await res.text(), /dh-runtime\.js/);
        }

        // ── FRT 核算：保存、列出（新的在前）、删除；写操作仅管理员 ──
        assert.deepEqual((await call('bob', 'GET', '/api/frt/snapshots')).data, []);
        assert.equal((await call('bob', 'POST', '/api/frt/snapshots', { month: '2026-10' })).status, 403);
        assert.equal((await call('alice', 'POST', '/api/frt/snapshots', { rows: [] })).status, 400);
        const frt1 = (await call('alice', 'POST', '/api/frt/snapshots', { month: '2026-09', rows: [{ sr: 'A', frt: 12 }] })).data.item;
        await new Promise((r) => setTimeout(r, 5));
        const frt2 = (await call('alice', 'POST', '/api/frt/snapshots', { month: '2026-10', rows: [{ sr: 'B', frt: 8 }] })).data.item;
        const frtList = (await call('bob', 'GET', '/api/frt/snapshots')).data;
        assert.deepEqual(frtList.map((x) => x.month), ['2026-10', '2026-09']);
        assert.deepEqual(frtList[0].rows, [{ sr: 'B', frt: 8 }]);
        assert.equal((await call('alice', 'DELETE', `/api/frt/snapshots/${frt1.id}`)).status, 200);
        assert.deepEqual((await call('bob', 'GET', '/api/frt/snapshots')).data.map((x) => x.id), [frt2.id]);

        // ── PR 稽查：首次自动放入内置模板；新增、修改（位置不变）、删除 ──
        const configs = (await call('bob', 'GET', '/api/praudit/configs')).data;
        assert.equal(configs.length, 1);
        assert.equal(configs[0].id, 'rc_audit_default');
        assert.equal(configs[0].checkpoints.length, 7);
        assert.equal((await call('bob', 'POST', '/api/praudit/configs', { name: 'x', fields: [], checkpoints: [] })).status, 403);
        assert.equal((await call('alice', 'POST', '/api/praudit/configs', { name: 'x' })).status, 400);
        const created = (await call('alice', 'POST', '/api/praudit/configs', { name: '变更单审计', fields: ['单号', '状态'], checkpoints: [{ key: 'c1', name: '审批' }], reportFields: ['单号'] })).data;
        assert.match(created.id, /^audit_[0-9a-f]{16}$/);
        assert.deepEqual(created.allFields, ['单号', '状态']);
        const edited = (await call('alice', 'POST', '/api/praudit/configs', { ...configs[0], name: 'RC 整改单审计（已调整）', groupField: '处理人' })).data;
        assert.equal(edited.groupField, '处理人');
        const after = (await call('bob', 'GET', '/api/praudit/configs')).data;
        assert.deepEqual(after.map((c) => c.name), ['RC 整改单审计（已调整）', '变更单审计'], '按创建先后排列，修改不改变位置');
        assert.equal((await call('alice', 'DELETE', `/api/praudit/configs/${created.id}`)).status, 200);
        assert.equal((await call('bob', 'GET', '/api/praudit/configs')).data.length, 1);

        // ── 值班表：周日开始的周划分；普通用户也能保存；常用人员从已保存的表里统计 ──
        const weeks = (await call('bob', 'GET', '/api/duty-roster/weeks?month=2026-11')).data;
        assert.equal(weeks.weeks.length, 5);
        assert.equal(weeks.weeks[0].start, '2026-11-01');
        assert.equal(weeks.weeks[0].days[5].isWeekend, true);
        assert.equal(weeks.weeks[4].days[6].inTargetMonth, false);
        assert.equal((await call('bob', 'GET', '/api/duty-roster/weeks?month=2026-13')).status, 400);
        const empty = (await call('bob', 'GET', '/api/duty-roster?month=2026-11')).data;
        assert.equal(empty.isSaved, false);
        assert.equal(empty.rows.length, 7);
        assert.deepEqual((await call('bob', 'GET', '/api/duty-roster/people')).data.names, []);
        const saved = await call('bob', 'POST', '/api/duty-roster', { month: '2026-11', cells: { '2026-11-01': 'Engineer A', '2026-11-02': 'Engineer B', '2026-11-03': 'Engineer A', '2026-12-01': 'Engineer C' }, totalCount: 360 });
        assert.equal(saved.status, 200);
        assert.equal(saved.data.data.monthlyCount, 3, '只统计落在当月的格子');
        const loaded = (await call('alice', 'GET', '/api/duty-roster')).data;
        assert.equal(loaded.month, '2026-11', '没指定月份时取最近编辑的月份');
        assert.equal(loaded.isSaved, true);
        assert.equal(loaded.rows[0][loaded.weeks[0].key], 'Engineer A');
        assert.equal(loaded.totalCount, 360);
        assert.equal((await call('bob', 'GET', '/api/duty-roster/recent')).data.list[0].monthlyCount, 3);
        assert.deepEqual((await call('bob', 'GET', '/api/duty-roster/people')).data.names, ['Engineer A', 'Engineer B', 'Engineer C']);
        const sample = (await call('bob', 'GET', '/api/duty-roster/sample?month=2026-08')).data;
        assert.match(sample.rows[0][sample.weeks[0].key], /^Engineer \d\d$/, '示例用占位姓名');
        assert.equal((await call('bob', 'POST', '/api/duty-roster', { cells: {} })).status, 400);

        // ── 专题分析：保存快照、内容相同只留一份、趋势、最新、月报、映射配置、删除 ──
        assert.equal((await call('bob', 'POST', '/api/topic-snapshots', { snapshot: netcareSnapshot(9, 110) })).status, 403);
        const bad = await call('alice', 'POST', '/api/topic-snapshots', { snapshot: { schema: 'other' } });
        assert.equal(bad.status, 400);
        assert.equal(bad.data.code, 'INVALID_TOPIC_SNAPSHOT');
        const sep = await call('alice', 'POST', '/api/topic-snapshots', { name: '九月', snapshot: netcareSnapshot(9, 110) });
        assert.equal(sep.status, 201);
        assert.equal(sep.data.item.period, '2026-09');
        assert.equal(sep.data.item.summary.topics.sr.total, 110);
        assert.equal(sep.data.item.summary.topics.sr.yoyRate, 10);
        assert.equal(sep.data.item.summary.topics.change.yoyRate, 50);
        assert.equal(sep.data.item.summary.topics.certificate.completionRate, 40);
        await new Promise((r) => setTimeout(r, 5));
        const again = await call('alice', 'POST', '/api/topic-snapshots', { snapshot: netcareSnapshot(9, 110) });
        assert.equal(again.status, 200, '内容完全相同：不新增');
        assert.equal(again.data.item.id, sep.data.item.id);
        assert.equal(again.data.item.name, '九月', '没给新名字时保留原名');
        await new Promise((r) => setTimeout(r, 5));
        const oct = await call('alice', 'POST', '/api/topic-snapshots', { snapshot: netcareSnapshot(10, 130) });
        assert.equal(oct.status, 201);
        const list = (await call('bob', 'GET', '/api/topic-snapshots?platform=netcare&limit=10')).data;
        assert.equal(list.total, 2);
        assert.deepEqual(list.items.map((x) => x.period), ['2026-10', '2026-09'], '按导入时间倒序');
        assert.equal(list.items[0].snapshot, undefined, '列表不带正文');
        assert.equal((await call('bob', 'GET', '/api/topic-snapshots?platform=other')).status, 400);
        assert.deepEqual((await call('bob', 'GET', '/api/topic-snapshots/series?platform=netcare')).data.items.map((x) => x.period), ['2026-09', '2026-10']);
        const latest = (await call('bob', 'GET', '/api/topic-snapshots/latest?platform=netcare')).data.item;
        assert.equal(latest.id, oct.data.item.id);
        assert.equal(latest.snapshot.data.sr.summary[0].sr_total, 130);
        assert.equal((await call('bob', 'GET', '/api/topic-snapshots/latest?platform=datafab')).status, 404);
        assert.equal((await call('bob', 'GET', `/api/topic-snapshots/${sep.data.item.id}`)).data.item.snapshot.settings.month, 9);
        const srReport = (await call('bob', 'GET', '/api/topic-snapshots/monthly-report?topic=sr')).data;
        assert.deepEqual(srReport.months, ['2026-10', '2026-09']);
        assert.equal(srReport.report.snapshot.id, oct.data.item.id);
        assert.equal((await call('bob', 'GET', '/api/topic-snapshots/monthly-report?topic=sr&month=2026-09')).data.report.snapshot.id, sep.data.item.id);
        assert.equal((await call('bob', 'GET', '/api/topic-snapshots/monthly-report?topic=sr&month=2026-01')).data.report, null);
        assert.equal((await call('bob', 'GET', '/api/topic-snapshots/monthly-report?topic=nope')).status, 400);
        const eos = (await call('bob', 'GET', '/api/topic-snapshots/eos-monthly-report')).data;
        assert.deepEqual(eos.months, ['2026-10', '2026-09']);
        assert.ok(eos.report && eos.report.product);
        assert.equal((await call('bob', 'GET', '/api/topic-snapshots/mapping-config')).data.config, null);
        assert.equal((await call('bob', 'PUT', '/api/topic-snapshots/mapping-config', { a: 1 })).status, 403);
        assert.equal((await call('alice', 'PUT', '/api/topic-snapshots/mapping-config', { customers: { X: 'Y' } })).status, 200);
        assert.deepEqual((await call('bob', 'GET', '/api/topic-snapshots/mapping-config')).data.config, { customers: { X: 'Y' } });
        assert.equal((await call('alice', 'DELETE', `/api/topic-snapshots/${sep.data.item.id}`)).status, 200);
        assert.equal((await call('alice', 'DELETE', `/api/topic-snapshots/${sep.data.item.id}`)).status, 404);
        assert.equal((await call('bob', 'GET', '/api/topic-snapshots')).data.total, 1);

        // 四类记录互不串：各自的列表只有自己的数据
        assert.equal((await call('bob', 'GET', '/api/frt/snapshots')).data.length, 1);
        assert.equal((await call('bob', 'GET', '/api/duty-roster/list')).data.length, 1);

        // ── 月报中译英：没配模型时给出明确提示 ──
        assert.equal((await call('bob', 'POST', '/api/ai/translate', {})).status, 400);
        assert.equal((await call('bob', 'POST', '/api/ai/translate', { text: '<strong>合计</strong>' })).status, 503);
    } finally {
        await app.close();
        await mock.close();
    }
});
