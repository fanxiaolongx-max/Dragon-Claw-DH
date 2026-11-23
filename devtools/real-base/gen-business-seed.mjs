// 生成联调用的「业务库」造数脚本 business-seed.sql：让内置的看板 SQL（rectification_overdue、business_backup_t8）
// 和表字典里的看板表在 Debian 上也能算出结果。数据全部虚构（地区、人名、单号都是编的），固定随机种子，重复生成结果一致。
// 用法：node devtools/real-base/gen-business-seed.mjs > devtools/real-base/business-seed.sql
let seed = 20261123;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (list) => list[Math.floor(rnd() * list.length)];
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`);
const day = (offset) => { const d = new Date(Date.UTC(2026, 10, 23) + offset * 86400000); return d.toISOString().slice(0, 10); };
const ts = (offset, hour = 10) => `${day(offset)} ${String(hour).padStart(2, '0')}:00:00`;

const REGIONS = [
    ['示例东部地区部', 'Demo East Region', ['东一代表处', '东二代表处', '东三代表处'], ['甲国', '乙国']],
    ['示例西部地区部', 'Demo West Region', ['西一代表处', '西二代表处'], ['丙国', '丁国']],
    ['示例南部地区部', 'Demo South Region', ['南一代表处', '南二代表处', '南三代表处'], ['戊国']],
    ['示例北部地区部', 'Demo North Region', ['北一代表处', '北二代表处'], ['己国', '庚国']],
    ['示例中部地区部', 'Demo Central Region', ['中一代表处'], ['辛国']],
];
// 看板 SQL 里按这些编号归类“共性问题 / M 硬盘”专项；其余编号是普通整改通知
const SC = ['SC2200020451', 'SC2200019693', 'SC2200019694', 'SC2200019551', 'SC2200018998', 'SC2200019611', 'SC2200020430', 'SC2200020431', 'SC2200020473', 'SC2200020474',
    'SC2200021061', 'SC2200021282', 'SC2200021256', 'SC2200021168', 'SC2200021319', 'SC2200021203', 'SC2200021205', 'SC2200020203', 'SC2200021328', 'SC2200021259',
    'SC2200021284', 'SC2200021283', 'SC2200021257', 'SC2200021169', 'SC2200021320', 'SC2200021204', 'SC2200021206', 'SC2200020204'];
const OTHER_SC = Array.from({ length: 12 }, (_, i) => `SC22000${30000 + i * 7}`);
const STATUS = ['Check', 'Check Overdue', 'Rectification Implementation', 'Rectification Implementation', 'Rectification Completed', 'Rectification Closed', 'Rectification Closed', 'Rectification Overdue', 'Not Involve'];
const PRODUCT_LINES = [['路由器', 'Router'], ['光传输', 'Optical'], ['数据存储', 'Storage'], ['无线', 'Wireless'], ['云核心网', 'Cloud Core'], ['能源', 'Energy']];
const PEOPLE = Array.from({ length: 16 }, (_, i) => [`u${String(100 + i)}`, `示例员工${String(i + 1).padStart(2, '0')}`]);

const out = [];
const table = (name, columns, rows) => {
    out.push(`DROP TABLE IF EXISTS \`${name}\`;`);
    out.push(`CREATE TABLE \`${name}\` (\n  ${columns.map(([c, t]) => `\`${c}\` ${t}`).join(',\n  ')}\n) DEFAULT CHARSET=utf8mb4;`);
    for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        out.push(`INSERT INTO \`${name}\` (${columns.map(([c]) => `\`${c}\``).join(', ')}) VALUES\n${chunk.map((r) => `(${columns.map(([c]) => q(r[c])).join(', ')})`).join(',\n')};`);
    }
};

// ── rectification_overdue：整改任务（一行一个任务）──
const roCols = [
    ['task_id', 'varchar(32)'], ['pid', 'varchar(32)'], ['source_id_ch', 'varchar(32)'], ['source_id_en', 'varchar(32)'], ['name_ch', 'varchar(200)'], ['name_en', 'varchar(200)'],
    ['notice_type_name', 'varchar(64)'], ['task_owner', 'varchar(32)'], ['fullname', 'varchar(64)'], ['delivery_scene', 'varchar(64)'],
    ['region_cn_name', 'varchar(64)'], ['region_en_name', 'varchar(64)'], ['repoffice_cn_name', 'varchar(64)'], ['repoffice_en_name', 'varchar(64)'], ['country_cn_name', 'varchar(64)'],
    ['network_name', 'varchar(128)'], ['network_cust_name', 'varchar(128)'], ['itr_product_line_name', 'varchar(64)'], ['product_line_name', 'varchar(64)'], ['product_category', 'varchar(64)'], ['bu', 'varchar(32)'],
    ['task_status', 'varchar(64)'], ['task_type', 'varchar(32)'], ['data_source', 'varchar(32)'], ['task_create_type', 'varchar(32)'], ['implement_type', 'varchar(32)'], ['request_delay_reason', 'varchar(200)'],
    ['first_publish_time', 'datetime'], ['task_create_time', 'datetime'], ['check_plan_end_time', 'datetime'], ['rectify_plan_end_time', 'datetime'], ['support_end_time', 'datetime'],
    ['approved_delay_end_time', 'datetime'], ['task_implement_complete_time', 'datetime'], ['task_approved_delay_times', 'int'],
    ['task_hw_plan_ne_qty', 'int'], ['task_hw_actual_ne_qty', 'int'], ['task_cust_plan_ne_qty', 'int'], ['task_cust_actual_ne_qty', 'int'], ['task_not_implement_ne_qty', 'int'],
    ['sub_task_hw_plan_ne_qty', 'int'], ['key_ne', 'varchar(8)'], ['uncomplete_nes', 'int'],
    ['h1_plan_nes', 'int'], ['h1_uncompleted_nes', 'int'], ['uncomplete_task_h1', 'int'], ['h2_plan_nes', 'int'], ['h2_uncompleted_nes', 'int'], ['uncomplete_task_h2', 'int'],
    ['total_plan_nes', 'int'], ['total_uncompleted_nes', 'int'], ['total_flag', 'varchar(8)'],
];
const ro = [];
for (let i = 0; i < 640; i += 1) {
    const [region, regionEn, offices, countries] = pick(REGIONS);
    const office = pick(offices);
    const status = pick(STATUS);
    const sc = rnd() < 0.55 ? pick(SC) : pick(OTHER_SC);
    const [pl, plEn] = pick(PRODUCT_LINES);
    const [owner, name] = pick(PEOPLE);
    const hwPlan = int(0, 40), custPlan = int(0, 15), notImpl = rnd() < 0.15 ? int(1, 6) : 0;
    const done = ['Rectification Completed', 'Rectification Closed'].includes(status);
    const hwAct = done ? hwPlan : status === 'Not Involve' ? 0 : int(0, hwPlan);
    const custAct = done ? custPlan : int(0, custPlan);
    const uncomplete = Math.max(0, hwPlan + custPlan - hwAct - custAct);
    const h1 = rnd() < 0.55;
    const created = -int(30, 300);
    const planEnd = created + int(60, 260);
    const supportEnd = planEnd + int(-40, 60);
    ro.push({
        task_id: `RT${String(100000 + i)}`, pid: `PN${String(5000 + Math.floor(i / 3))}`,
        source_id_ch: sc, source_id_en: rnd() < 0.5 ? sc : null, name_ch: `示例整改通知 ${sc.slice(-4)}`, name_en: `Demo rectification notice ${sc.slice(-4)}`,
        notice_type_name: pick(['技术通知', '预警通知', '整改通知']), task_owner: owner, fullname: name, delivery_scene: pick(['现网整改', '新建交付', '扩容交付']),
        region_cn_name: region, region_en_name: regionEn, repoffice_cn_name: rnd() < 0.03 ? null : office, repoffice_en_name: `${office} (EN)`, country_cn_name: pick(countries),
        network_name: `示例网络-${int(1, 40)}`, network_cust_name: `示例客户${int(1, 25)}`, itr_product_line_name: pl, product_line_name: pl, product_category: `${pl}产品`, bu: pick(['运营商', '企业']),
        task_status: status, task_type: pick(['整改', '排查']), data_source: pick(['RC', 'BR']), task_create_type: pick(['自动', '手工']), implement_type: pick(['华为实施', '客户实施', '联合实施']),
        request_delay_reason: rnd() < 0.2 ? '客户窗口期受限' : null,
        first_publish_time: rnd() < 0.9 ? ts(created - int(0, 10)) : null, task_create_time: ts(created), check_plan_end_time: ts(created + 30), rectify_plan_end_time: ts(planEnd), support_end_time: ts(supportEnd),
        approved_delay_end_time: rnd() < 0.15 ? ts(int(-10, 90)) : null, task_implement_complete_time: done ? ts(planEnd - int(0, 30)) : null, task_approved_delay_times: rnd() < 0.2 ? int(1, 3) : 0,
        task_hw_plan_ne_qty: hwPlan, task_hw_actual_ne_qty: hwAct, task_cust_plan_ne_qty: custPlan, task_cust_actual_ne_qty: custAct, task_not_implement_ne_qty: notImpl,
        sub_task_hw_plan_ne_qty: hwPlan, key_ne: rnd() < 0.3 ? 'Y' : 'N', uncomplete_nes: uncomplete,
        h1_plan_nes: h1 ? hwPlan + custPlan : 0, h1_uncompleted_nes: h1 ? uncomplete : 0, uncomplete_task_h1: h1 && uncomplete ? 1 : 0,
        h2_plan_nes: h1 ? 0 : hwPlan + custPlan, h2_uncompleted_nes: h1 ? 0 : uncomplete, uncomplete_task_h2: !h1 && uncomplete ? 1 : 0,
        total_plan_nes: hwPlan + custPlan, total_uncompleted_nes: uncomplete, total_flag: h1 ? 'H1' : 'H2',
    });
}
table('rectification_overdue', roCols, ro);

// ── business_backup_t8：批量整改电子流（一行一个电子流环节记录）──
const t8Cols = [
    ['orderid', 'varchar(32)'], ['task_id', 'varchar(32)'], ['task_status', 'varchar(64)'], ['nid_ch', 'varchar(32)'], ['nid_en', 'varchar(32)'], ['ticketstatus', 'varchar(32)'],
    ['originator', 'varchar(64)'], ['current_phase', 'varchar(64)'], ['currentoperator', 'varchar(64)'], ['createtime', 'datetime'], ['operate_time', 'datetime'],
    ['region_cn_name', 'varchar(64)'], ['region_en_name', 'varchar(64)'], ['repoffice_cn_name', 'varchar(64)'], ['repoffice_en_name', 'varchar(64)'], ['country_name_cn', 'varchar(64)'], ['country_name_en', 'varchar(64)'],
    ['product_line_name_cn', 'varchar(64)'], ['product_line_name_en', 'varchar(64)'], ['product_name', 'varchar(64)'],
    ['service_approver_start_time', 'datetime'], ['service_approver_end_time', 'datetime'], ['service_approver_lost_sla', 'varchar(4)'],
    ['service_representative_lost_sla', 'varchar(4)'], ['pdt_manager_start_time', 'datetime'], ['pdt_manager_end_time', 'datetime'], ['pdt_manager_lost_sla', 'varchar(4)'],
];
const t8 = [];
for (let i = 0; i < 320; i += 1) {
    const [region, regionEn, offices, countries] = pick(REGIONS);
    const [pl, plEn] = pick(PRODUCT_LINES);
    const created = -int(5, 120);
    const phase = pick(['服务审批人', '服务代表', 'PDT经理', '已完成']);
    const saEnd = phase === '服务审批人' ? null : created + int(1, 6);
    const pdtStart = ['PDT经理', '已完成'].includes(phase) ? saEnd + int(1, 5) : null;
    const pdtEnd = phase === '已完成' ? pdtStart + int(1, 8) : null;
    const country = pick(countries);
    t8.push({
        orderid: `BR${String(700000 + i)}`, task_id: `RT${String(100000 + int(0, 639))}`, task_status: pick(STATUS), nid_ch: pick(SC), nid_en: pick(SC), ticketstatus: phase === '已完成' ? 'Closed' : 'Open',
        originator: pick(PEOPLE)[1], current_phase: phase, currentoperator: phase === '已完成' ? null : pick(PEOPLE)[1], createtime: ts(created), operate_time: ts(created + int(0, 20)),
        region_cn_name: region, region_en_name: regionEn, repoffice_cn_name: pick(offices), repoffice_en_name: 'Demo Office', country_name_cn: country, country_name_en: `${country} (EN)`,
        product_line_name_cn: pl, product_line_name_en: plEn, product_name: `${pl}示例产品${int(1, 4)}`,
        service_approver_start_time: ts(created), service_approver_end_time: saEnd === null ? null : ts(saEnd), service_approver_lost_sla: rnd() < 0.2 ? 'Y' : 'N',
        service_representative_lost_sla: rnd() < 0.15 ? 'Y' : 'N', pdt_manager_start_time: pdtStart === null ? null : ts(pdtStart), pdt_manager_end_time: pdtEnd === null ? null : ts(pdtEnd), pdt_manager_lost_sla: rnd() < 0.1 ? 'Y' : 'N',
    });
}
table('business_backup_t8', t8Cols, t8);

// ── 表字典里的其他看板表：结构简化，有数据（其中一张故意留空，演示“空表”说明）──
const simple = ['redline_personnel', 'redline_post_new', 'gts_datalink_d5d5b2_151046751', 'redline_project', 'redline_match', 'netcare_network_project',
    'redline_resource_investment', 'redline_resource_investment_new_total', 'redline_resource_investment_new', 'business_backup_t7',
    'value_network_inspection', 'inspection_coverage', 'inspection_topic_improvement', 'ds_6jp5uhmzpdkgjxhfpuohup', 'risk_prevention',
    'vulnerability_warning', 'first_node_vulnerability_warning', 'topn_list_total2023', 'drill_live_network', 't2_high_risk_command_interception'];
const simpleCols = [['id', 'int'], ['region_cn_name', 'varchar(64)'], ['repoffice_cn_name', 'varchar(64)'], ['item_name', 'varchar(128)'], ['metric_value', 'decimal(12,2)'], ['stat_date', 'date']];
for (const [n, name] of simple.entries()) {
    const rows = name === 't2_high_risk_command_interception' ? [] : Array.from({ length: 20 + (n * 13) % 90 }, (_, i) => {
        const [region, , offices] = pick(REGIONS);
        return { id: i + 1, region_cn_name: region, repoffice_cn_name: pick(offices), item_name: `示例条目${i + 1}`, metric_value: Math.round(rnd() * 10000) / 100, stat_date: day(-int(0, 90)) };
    });
    table(name, simpleCols, rows);
}

process.stdout.write(`-- 联调用业务库造数（自动生成，勿手改）：node devtools/real-base/gen-business-seed.mjs > devtools/real-base/business-seed.sql\n${out.join('\n')}\n`);
