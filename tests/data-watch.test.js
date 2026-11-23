// 数据探索 → 数据治理：行数巡检（突增 / 突降 / 变空 / 从空变有 / 新表 / 表消失，聚合成一条消息发给管理员）、
// 收集每张表前 N 行（空表说明原因）、表字典导入与中英文映射、派生表联动重算。业务库用内存假库模拟。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockBaseServer } from './helpers/mock-base.js';

let mock;
let app;
const S = 'netcare';
const db = new Map();
const table = (name, rows, extra = {}) => db.set(`${S}.${name}`, { rows, cols: rows[0] ? Object.keys(rows[0]) : extra.cols || ['id'], type: 'BASE TABLE', ...extra });
const tickets = (n, offset = 0) => Array.from({ length: n }, (_, i) => ({ id: offset + i + 1, region: (offset + i) % 2 ? '东' : '西', status: 'open' }));

function page(rows, sql) {
    const m = /LIMIT (\d+)(?: OFFSET (\d+))?\s*$/i.exec(sql);
    if (!m) return rows;
    const offset = Number(m[2] || 0);
    return rows.slice(offset, offset + Number(m[1]));
}
const visible = () => [...db.entries()].filter(([, t]) => !t.hidden);

function fakeBusiness(sql) {
    const name = (key) => key.slice(S.length + 1);
    if (/information_schema\.TABLES WHERE TABLE_SCHEMA = DATABASE\(\) ORDER BY/i.test(sql)) {
        return page(visible().map(([key, t]) => ({ name: name(key), type: t.type, est: t.rows.length, ut: null, comment: t.comment || '' })), sql);
    }
    if (/information_schema\.TABLES WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME IN/i.test(sql)) {
        return visible().filter(([key]) => sql.includes(`'${name(key)}'`)).map(([key, t]) => ({ n: name(key), r: t.rows.length, u: null, d: t.rows.length * 100 }));
    }
    let m = /information_schema\.COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = '(\w+)'/i.exec(sql);
    if (m) {
        const t = db.get(`${S}.${m[1]}`);
        return t && !t.hidden ? t.cols.map((c) => ({ c, ct: c === 'id' ? 'int' : 'varchar(50)', cm: '', k: c === 'id' ? 'PRI' : '' })) : [];
    }
    m = /SELECT COUNT\(\*\) AS c FROM `(\w+)`/.exec(sql);
    if (m) {
        const t = db.get(`${S}.${m[1]}`);
        if (!t || t.hidden) throw new Error(`Table '${m[1]}' doesn't exist`);
        if (t.error) throw new Error(t.error);
        return [{ c: t.rows.length }];
    }
    m = /^SELECT \* FROM `(\w+)` LIMIT (\d+)/.exec(sql);
    if (m) {
        const t = db.get(`${S}.${m[1]}`);
        if (t.error) throw new Error(t.error);
        return t.rows.slice(0, Number(m[2]));
    }
    if (/^SELECT id, region FROM tickets/.test(sql)) return page(db.get(`${S}.tickets`).rows.map(({ id, region }) => ({ id, region })), sql);
    if (/^(?:SELECT \* FROM \()?WITH `ticket_base` AS \(SELECT id, region FROM tickets\) SELECT region, COUNT\(\*\) AS n FROM ticket_base GROUP BY region/.test(sql) || /FROM tickets GROUP BY region/i.test(sql)) {
        const groups = {};
        for (const r of db.get(`${S}.tickets`).rows) groups[r.region] = (groups[r.region] || 0) + 1;
        return page(Object.entries(groups).sort().map(([region, n]) => ({ region, n })), sql);
    }
    throw new Error(`fake business db: unexpected SQL ${sql.slice(0, 120)}`);
}

before(async () => {
    mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0', LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`, BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        APP_SCHEMA: 'datawatch', APP_UUID: 'datawatch', APP_DATASOURCE_ID: '2',
        BUSINESS_DATASOURCE_NAME: 'netcare_ro', DH_ADMIN_USERS: 'boss', DH_OPEN_ADMIN: '1',
    });
    mock.options.businessQuery = fakeBusiness;
    table('tickets', tickets(100));
    table('orders_0', [], { cols: ['id', 'amount'] });
    table('orders_1', tickets(5));
    table('logs', tickets(50));
    table('secret', tickets(3), { error: "SELECT command denied to user 'app'@'%' for table 'secret'" });
    table('v_broken', [], { type: 'VIEW', error: "View 'v_broken' references invalid table(s) or column(s) or function(s)" });
    table('empty_tbl', [], { cols: ['a', 'b'] });
    const { createServer } = await import('../src/server.js');
    app = await createServer();
});
after(async () => { await app?.close(); await mock?.close(); });

test('巡检：第一轮只建基线；第二轮的变化聚合成一条消息发给管理员', async () => {
    const watch = await import('../src/services/data-watch-service.js');
    const { listAlerts } = await import('../src/services/alert-service.js');
    await watch.saveSettings({ minAbsChange: 10, changeRatio: 0.3 }, 'boss');

    const first = await watch.runCheck({ trigger: 'manual', actor: 'boss' });
    assert.equal(first.tables, 7);
    assert.equal(first.anomalies, 0, '没有上一轮就没有可比的基准');
    assert.equal(first.errors, 2);
    const latest = await watch.latestRun();
    const byKey = new Map(latest.results.map((r) => [r.key, r]));
    assert.equal(byKey.get('tickets').count, 100);
    assert.match(byKey.get('secret').error, /没有查询权限/);
    assert.match(byKey.get('v_broken').error, /视图无法执行/);
    assert.equal((await listAlerts('boss')).events.filter((a) => /数据巡检/.test(a.title)).length, 0);

    db.get(`${S}.tickets`).rows = tickets(40);          // 突降 60%
    db.get(`${S}.logs`).rows = [];                       // 变空
    db.get(`${S}.empty_tbl`).rows = [{ a: 1, b: 2 }];    // 从空变有
    db.get(`${S}.orders_1`).rows = tickets(30);          // 突增 500%
    db.get(`${S}.v_broken`).hidden = true;               // 表消失
    table('new_tbl', tickets(2));                        // 新表
    const second = await watch.runCheck({ trigger: 'schedule' });
    const types = Object.fromEntries(second.anomaliesList.map((a) => [a.key, a.type]));
    assert.deepEqual(types, {
        'tickets': 'drop', 'logs': 'emptied', 'empty_tbl': 'filled',
        'orders_1': 'spike', 'v_broken': 'removed', 'new_tbl': 'new_table',
    });
    assert.equal(second.anomaliesList[0].severity, 'error', '严重的排前面');
    const alerts = (await listAlerts('boss')).events.filter((a) => /数据巡检/.test(a.title));
    assert.equal(alerts.length, 1, '同一轮多处变化只发一条');
    assert.match(alerts[0].title, /6 张表数据量异常/);
    assert.match(alerts[0].message, /logs：数据被清空：50 → 0/);
    assert.equal(alerts[0].detail.anomalies.length, 6);

    const history = await watch.countHistory('tickets');
    assert.deepEqual(history.map((h) => h.count), [100, 40]);
});

test('收集：每张表前 N 行，空表和报错的表说明原因', async () => {
    const watch = await import('../src/services/data-watch-service.js');
    const out = await watch.runCollect({ rows: 2, actor: 'boss' });
    assert.equal(out.tables, 7);
    const tables = new Map((await watch.collectionTables(out.id)).map((t) => [t.key, t]));
    assert.equal(tables.get('tickets').status, 'ok');
    assert.equal(tables.get('tickets').sampled, 2);
    assert.equal(tables.get('secret').status, 'error');
    assert.equal(tables.get('secret').errorKind, 'permission');
    assert.equal(tables.get('logs').status, 'empty');
    assert.match(tables.get('logs').reason, /确实没有数据/);
    assert.match(tables.get('orders_0').reason, /同族分区 orders_1 有数据/);
    const sample = await watch.getSample('tickets');
    assert.deepEqual(sample.columns.map((c) => c.name), ['id', 'region', 'status']);
    assert.equal(sample.rows.length, 2);
    const empty = await watch.getSample('orders_0');
    assert.deepEqual(empty.columns.map((c) => c.name), ['id', 'amount'], '空表也收字段结构');
});

test('表字典：CSV 导入（表名只写一次的字段级字典），中英文映射与分类进总览', async () => {
    const dict = await import('../src/services/data-dictionary-service.js');
    const csv = [
        '表名,中文名,英文名,分类,子分类,字段名,字段中文名',
        'tickets,工单表,Tickets,服务请求,工单,id,编号',
        ',,,,,region,地区',
        ',,,,,gone_col,已删除的字段',
        ',,,,,old_flag,',
        'orders_0,订单表（备用分区）,Orders,订单,,,',
        '"gauss200_datafab009_02"."datafab009"."rectification_overdue",整改超期,,整改,,,',
    ].join('\n');
    const result = await dict.importDictionary({ filename: 'dict.csv', text: csv }, { actor: 'boss' });
    assert.deepEqual([result.tables, result.created, result.columns], [3, 3, 4]);

    const view = await dict.catalogView();
    const t = view.tables.find((x) => x.key === 'tickets');
    assert.deepEqual([t.nameCn, t.nameEn, t.category, t.subCategory, t.nameCnSource], ['工单表', 'Tickets', '服务请求', '工单', 'dictionary']);
    assert.equal(t.status, 'anomaly');
    assert.equal(view.stats.inDictionary, 3);
    assert.equal(view.stats.tables, 7, '表清单以实际查到的业务库为准，不掺 441 张盘点种子');
    assert.ok(!view.tables.some((x) => x.name === 'clb_major_incidents_sr_dwd'), '种子里有、库里没有的表不列出');
    const ghost = view.tables.find((x) => x.key === 'rectification_overdue');
    assert.deepEqual([ghost.status, ghost.inLive, ghost.nameCn], ['missing', false, '整改超期'], '"库"."模式"."表" 只取表名；字典里有、库里没有标出来');
    assert.ok(view.categories.some((c) => c.name === '服务请求' && c.anomalies === 1));

    const detail = await dict.tableDetail('tickets');
    const cols = Object.fromEntries(detail.columns.map((c) => [c.name, c]));
    assert.equal(cols.region.nameCn, '地区');
    assert.equal(cols.status.inDictionary, false, '字典没写的字段标出来');
    assert.equal(cols.gone_col.missingInDb, true, '字典里有、库里没有的字段提醒过期');
    assert.equal(detail.history.length, 2);

    const csvOut = await dict.exportDictionaryCsv();
    assert.match(csvOut, /\r\ntickets,工单表,Tickets,服务请求/);
});

test('派生表：只读 SQL 计算、识别源表，源表变化后联动重算', async () => {
    const dict = await import('../src/services/data-dictionary-service.js');
    await assert.rejects(dict.saveDerived({ name: 'bad', nameCn: '坏', sql: 'DELETE FROM tickets' }, 'boss'), /只允许查询|不能包含/);
    const preview = await dict.previewDerived({ sql: 'SELECT region, COUNT(*) AS n FROM tickets GROUP BY region' });
    assert.deepEqual(preview.sources, ['tickets']);

    const def = await dict.saveDerived({ name: 'ticket_by_region', nameCn: '工单按地区', category: '服务请求', sql: 'SELECT region, COUNT(*) AS n FROM tickets GROUP BY region' }, 'boss');
    const first = await dict.refreshDerived(def.id);
    assert.equal(first.status, 'ok');
    let data = await dict.derivedData(def.id);
    assert.deepEqual(data.rows, [{ region: '东', n: 20 }, { region: '西', n: 20 }]);

    assert.deepEqual((await dict.linkCheck()).refreshed, [], '源表没变不重算');
    db.get(`${S}.tickets`).rows.push(...tickets(10, 40).map((r) => ({ ...r, region: '东' })));
    const linked = await dict.linkCheck();
    assert.deepEqual(linked.refreshed, [def.id]);
    data = await dict.derivedData(def.id);
    assert.deepEqual(data.rows, [{ region: '东', n: 30 }, { region: '西', n: 20 }]);
    const after = await dict.getDerived(def.id);
    assert.match(after.lastReason, /源表有变化：tickets/);

    const view = await dict.catalogView();
    const tk = view.tables.find((x) => x.key === 'tickets');
    assert.deepEqual(tk.derivedBy.map((d) => d.name), ['ticket_by_region']);
    assert.deepEqual([tk.origin, tk.reprocess], ['datafab', true], '被 SQL 计算引用的源表 = DataFab + 二次加工');
    assert.equal(view.stats.reprocess >= 1, true);
});

test('派生表两层：看板 SQL 引用新表，展开成 CTE 在业务库只读执行；循环引用被拒', async () => {
    const dict = await import('../src/services/data-dictionary-service.js');
    const base = await dict.saveDerived({ name: 'ticket_base', nameCn: '工单新表', sql: 'SELECT id, region FROM tickets' }, 'boss');
    const kpi = await dict.saveDerived({ name: 'ticket_kpi', nameCn: '工单看板指标', sql: 'SELECT region, COUNT(*) AS n FROM ticket_base GROUP BY region' }, 'boss');
    assert.deepEqual(kpi.dependsOn, ['ticket_base']);
    assert.deepEqual(kpi.sources, ['tickets'], '联动看最终依赖的业务表');
    assert.match(kpi.compiledSql, /^WITH `ticket_base` AS \(SELECT id, region FROM tickets\) SELECT region/);
    const out = await dict.refreshDerived(kpi.id);
    assert.equal(out.status, 'ok', out.lastError);
    assert.deepEqual((await dict.derivedData(kpi.id)).rows, [{ region: '东', n: 30 }, { region: '西', n: 20 }]);
    await assert.rejects(dict.saveDerived({ id: base.id, sql: 'SELECT region AS id, n AS region FROM ticket_kpi' }, 'boss'), /循环引用：ticket_base → ticket_kpi → ticket_base/);
    const preview = await dict.previewDerived({ sql: 'SELECT region, COUNT(*) AS n FROM ticket_base GROUP BY region' });
    assert.deepEqual(preview.dependsOn, ['ticket_base']);
});

test('导入看板 SQL：按「看板--指标」拆段、DataFab 写法改写、重复导入不重复建；看板 / 源表字典', async () => {
    const dict = await import('../src/services/data-dictionary-service.js');
    const text = '看板甲--地区分布\nselect region "地区", count(*) "数" from "db"."s"."Tickets" group by region\n\n看板甲--坏的\ndelete from tickets\n';
    const dry = await dict.importBoardSql({ text, dryRun: true }, 'boss');
    assert.deepEqual([dry.total, dry.created, dry.errors], [2, 1, 1]);
    assert.match(dry.items[0].sql, /from `Tickets` group by region|from `tickets`/i);
    assert.equal((await dict.listDerived()).some((d) => d.category === '看板甲'), false, 'dryRun 不落库');
    const done = await dict.importBoardSql({ text }, 'boss');
    assert.equal(done.created, 1);
    const def = (await dict.listDerived()).find((d) => d.category === '看板甲');
    assert.deepEqual([def.nameCn, def.dialect, def.sources], ['地区分布', 'datafab', ['Tickets']]);
    assert.match(def.sourceSql, /"db"\."s"\."Tickets"/, '原文保留');
    assert.equal((await dict.importBoardSql({ text }, 'boss')).unchanged, 1, '同一标题再导入不重复建');

    const csv = '看板\t表名\t\t备注\t源表\n红线看板\ttickets\t\t工单\tsrc_a,src_b\n\torders_0\t\t订单\t\n';
    await dict.importDictionary({ filename: 'boards.txt', text: csv }, { actor: 'boss' });
    const view = await dict.catalogView();
    assert.equal(view.tables.find((t) => t.key === 'orders_0').category, '红线看板', '看板列只写在组内第一行时沿用');
    assert.equal((await dict.tableDetail('tickets')).dictionary.upstream, 'src_a,src_b');
    await dict.importDictionary({ filename: 'case.csv', text: '表名,中文名\nNew_Tbl,大小写不同的新表' }, { actor: 'boss' });
    const again = await dict.catalogView();
    assert.equal(again.tables.find((t) => t.key === 'new_tbl').nameCn, '大小写不同的新表', '字典表名不区分大小写对上库里的表');
    assert.ok(!again.tables.some((t) => t.key === 'New_Tbl'), '不会多出一张“库里没有”的表');
});

test('接口：一键体检后台执行、状态可查、表字典可导出', async () => {
    const started = await app.inject({ method: 'POST', url: '/api/db-explorer/governance/run', payload: { kind: 'check' } });
    assert.equal(started.statusCode, 202, started.body);
    let status;
    for (let i = 0; i < 50; i += 1) {
        status = JSON.parse((await app.inject({ method: 'GET', url: '/api/db-explorer/governance/status' })).body);
        if (!status.running && status.lastRun?.trigger === 'manual' && status.lastRun.tables === 7) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(status.running, null);
    assert.equal(status.configured, true);
    assert.ok(status.state.nextCheckAt);
    const settings = await app.inject({ method: 'PUT', url: '/api/db-explorer/governance/settings', payload: { intervalMinutes: 5, collectRows: 500 } });
    assert.deepEqual([JSON.parse(settings.body).intervalMinutes, JSON.parse(settings.body).collectRows], [15, 200], '周期和行数有上下限');
    const xlsx = await app.inject({ method: 'GET', url: '/api/db-explorer/governance/dictionary/export' });
    assert.equal(xlsx.statusCode, 200, xlsx.body.slice(0, 500));
    assert.match(xlsx.headers['content-disposition'], /table-dictionary-.*\.xlsx/);
    assert.equal(xlsx.rawPayload.subarray(0, 2).toString(), 'PK');
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.rawPayload);
    const sheet = wb.getWorksheet('表字典');
    const header = sheet.getRow(3).values.slice(1);
    assert.deepEqual(header.slice(0, 4), ['表名', '表来源', '二次加工', '中文名']);
    assert.ok(header.includes('体检状态') && header.includes('行数'), '带最新体检结果列');
    assert.ok(wb.getWorksheet('体检汇总'));
    const dict = await import('../src/services/data-dictionary-service.js');
    const back = await dict.parseDictionary({ filename: 'x.xlsx', contentBase64: xlsx.rawPayload.toString('base64') });
    assert.ok(back.some((e) => e.key === 'tickets' && e.nameCn === '工单表' && e.columns.some((c) => c.name === 'region' && c.nameCn === '地区')), '导出的 Excel 能原样导回');
    const csv = await app.inject({ method: 'GET', url: '/api/db-explorer/governance/dictionary/export?format=csv' });
    assert.match(csv.headers['content-disposition'], /\.csv/);
    const catalog = JSON.parse((await app.inject({ method: 'GET', url: '/api/db-explorer/governance/catalog' })).body);
    assert.ok(catalog.tables.length >= 7);
});

test('内置默认数据：启动导入表字典和看板 SQL，内容没变不重复导入', async () => {
    const dict = await import('../src/services/data-dictionary-service.js');
    const out = await dict.applyBundledDefaults();
    assert.ok(out['board-sql.txt'].total >= 20, JSON.stringify(out));
    assert.equal(out['board-sql.txt'].errors, 0);
    assert.ok(out['netcare-script-tables.csv'].tables >= 20);
    assert.ok(out['board-tables.txt'].tables >= 20);
    const boards = (await dict.listDerived()).filter((d) => d.dialect === 'datafab' && d.createdBy === 'system');
    assert.ok(boards.length >= 20);
    assert.ok(boards.every((d) => d.sources.length && !/"/.test(d.sql)), '都改写成了 MySQL 并识别到源表');
    assert.deepEqual(await dict.applyBundledDefaults(), { skipped: 'unchanged' });
});

test('数据源问题跟踪：空表 / 库里没有开问题、有数据后自动解决；超期、解决率；对话里限制访问问题表', async () => {
    const issues = await import('../src/services/data-issue-service.js');
    const t0 = Date.now();
    const DAY = 86_400_000;
    await issues.saveConfig({ alertDays: 3, restrictChat: true });
    // tickets 被派生表引用 → DataFab·二次加工，在跟踪范围；redline_personnel 在需求清单里；position_baseline_import 不在库里
    await issues.syncWithRun({ id: 'r_issue_1', results: [{ key: 'tickets', count: 0 }, { key: 'redline_personnel', count: 0 }, { key: 'Rectification_Overdue', count: 12 }, { key: 'secret', count: null, error: '没有查询权限' }] }, { now: t0 });
    let view = await issues.issuesView({ now: t0 + 4 * DAY });
    const open = new Map(view.open.map((i) => [i.key, i]));
    assert.equal(open.get('tickets').kind, 'empty');
    assert.equal(open.get('redline_personnel').kind, 'empty');
    assert.equal(open.get('position_baseline_import').kind, 'missing', '清单里的表库里没有');
    assert.ok(!open.has('rectification_overdue'), '有数据的不算问题');
    assert.ok(!open.has('secret'), '不在跟踪范围的表不管');
    assert.ok(!open.has('gts_datalink_d5d5b2_151046751'), 'DataFab 数据集名已换成库里的别名表');
    assert.equal(open.get('t2_high_risk_command_interception').alternative.table, 't2_high_risk_command_interception_004');
    assert.equal(view.stats.overdue, view.stats.open, '4 天都超过了 3 天');
    const openedAt = open.get('redline_personnel').openedAt;

    // 第二轮：tickets 有数据了 → 已解决；redline_personnel 仍空，开始时间不变
    await issues.syncWithRun({ id: 'r_issue_2', results: [{ key: 'tickets', count: 10 }, { key: 'redline_personnel', count: 0 }, { key: 'Rectification_Overdue', count: 12 }] }, { now: t0 + 2 * DAY });
    view = await issues.issuesView({ now: t0 + 2 * DAY });
    const resolved = view.closed.find((i) => i.key === 'tickets');
    assert.ok(resolved.durationMs >= 2 * DAY);
    assert.equal(resolved.resolvedCount, 10);
    assert.equal(view.open.find((i) => i.key === 'redline_personnel').openedAt, openedAt, '问题没解决，开始时间不变');
    assert.ok(view.stats.rate > 0 && view.stats.rate < 100);
    assert.equal(view.stats.overdue, 0, '才 2 天，没超过 3 天');
    assert.equal((await issues.updateIssue('redline_personnel', { notified: true })).notifiedAt.length > 0, true);

    // 对话：问题表不用来回答，说明原因并给出替代表
    const { NETCARE_TOOLS } = await import('../src/agent/netcare-tools.js');
    const run = (name, args) => NETCARE_TOOLS.find((t) => t.name === name).run(args);
    const q = await run('netcare_query', { table: 'redline_personnel' });
    assert.equal(q.ok, false);
    assert.match(q.content, /DATA_SOURCE_ISSUE.*redline_personnel.*空表.*不要编数据/s);
    const t2 = await run('netcare_sql', { sql: 'SELECT COUNT(*) FROM t2_high_risk_command_interception' });
    assert.match(t2.content, /可改用 t2_high_risk_command_interception_004/);
    const api = JSON.parse((await app.inject({ method: 'GET', url: '/api/db-explorer/governance/issues' })).body);
    assert.ok(api.stats.open >= 1 && api.config.alertDays === 3);
    await app.inject({ method: 'PUT', url: '/api/db-explorer/governance/issues/config', payload: { restrictChat: false, alertDays: 5 } });
    const free = await run('netcare_query', { table: 'redline_personnel' });
    assert.doesNotMatch(free.content, /DATA_SOURCE_ISSUE/, '关掉限制后照常查');
    await issues.saveConfig({ restrictChat: true, alertDays: 3 });
});
