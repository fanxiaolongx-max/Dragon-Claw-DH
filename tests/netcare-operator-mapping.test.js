import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profile, hintsOf, codeMappingHintForRows, resolveCodeMappingsForRows } from '../src/services/netcare/table-catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

test('NetCare 运营商/地代编码自动识别与按存在性提示映射表', () => {
    const seed = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/services/netcare/netcare-table-seed.json'), 'utf8'));
    assert.match(seed.tables.cs_nc_comm_customer_d_list.nameCn, /运营商/);
    assert.match(seed.tables.common_data_rep.nameCn, /代表处/);

    const fields = profile(
        [
            { name: 't1_operator_code', dataType: 'varchar' },
            { name: 'customer_number', dataType: 'varchar' },
            { name: 'repoffice_code', dataType: 'varchar' },
            { name: 'risk_status', dataType: 'varchar' },
        ],
        [{ t1_operator_code: '028262', customer_number: '10001', repoffice_code: '026921', risk_status: 'Closed' }],
    );
    assert.equal(fields.find((f) => f.name === 't1_operator_code').role, 'operator');
    assert.equal(fields.find((f) => f.name === 'customer_number').role, 'customer');
    assert.equal(fields.find((f) => f.name === 'repoffice_code').role, 'office');

    // 1. 当前库存在映射表 -> 自动提示优先查 cs_nc_comm_customer_d_list 与 common_data_rep
    const withTables = hintsOf('op_ioc_digital_cert_2026_d_dwd', fields, null, {
        operator: ['cs_nc_comm_customer_d_list', 'cs_nc_comm_customer_d_list_dim'],
        rep: ['common_data_rep'],
        country: [],
    });
    assert.ok(withTables.some((h) => h.includes('cs_nc_comm_customer_d_list') && h.includes('t1_operator_code') && h.includes('customer_number = cust_account_num')));
    assert.ok(withTables.some((h) => h.includes('common_data_rep') && h.includes('repoffice_code')));

    // 2. 当前库不存在映射表 -> 严格不误提示
    const withoutTables = hintsOf('op_ioc_digital_cert_2026_d_dwd', fields, null, {
        operator: [],
        rep: [],
        country: [],
    });
    assert.equal(withoutTables.some((h) => h.includes('cs_nc_comm_customer_d_list')), false);
    assert.equal(withoutTables.some((h) => h.includes('common_data_rep')), false);

    // 3. 映射表自身不自循环提示
    const selfHints = hintsOf('cs_nc_comm_customer_d_list', fields, null, {
        operator: ['cs_nc_comm_customer_d_list'],
        rep: ['common_data_rep'],
        country: [],
    });
    assert.equal(selfHints.some((h) => h.includes('cs_nc_comm_customer_d_list')), false);

    // 4. SQL/Query 返回纯运营商编码但无名称列 -> 自动附带映射提醒
    const rawRows = [
        { t1_operator_code: 'Others', total_tasks: 630 },
        { t1_operator_code: '028262', total_tasks: 543 },
        { t1_operator_code: '028238', total_tasks: 197 },
    ];
    const rowHint = codeMappingHintForRows(rawRows, { operator: ['cs_nc_comm_customer_d_list'], rep: [] });
    assert.match(rowHint, /t1_operator_code/);
    assert.match(rowHint, /cs_nc_comm_customer_d_list/);

    // 5. 返回结果已包含运营商名称列，或库里无映射表 -> 不重复提醒
    const namedRows = [{ t1_operator_code: '028262', hq_cust_category_cn_name: '移动系统部', total_tasks: 543 }];
    assert.equal(codeMappingHintForRows(namedRows, { operator: ['cs_nc_comm_customer_d_list'], rep: [] }), '');
    assert.equal(codeMappingHintForRows(rawRows, { operator: [], rep: [] }), '');
});

test('NetCare 服务端实时编码解析：按真实列动态 IN 查询、不缓存过时名称、缺表静默跳过', async () => {
    const dimCols = {
        cs_nc_comm_customer_d_list: ['hq_cust_category_code', 'hq_cust_category_cn_name', 'hq_cust_category_en_name', 'cust_account_num', 'mergered_cust_name'],
        common_data_rep: ['dept_code', 'rep_name_cn', 'rep_name_en'],
    };
    let liveName = '移动系统部';
    const sqlLog = [];
    const runQuery = async (sql) => {
        sqlLog.push(sql);
        if (sql.includes('hq_cust_category_code')) {
            return [
                { __code: '028262', __cn: liveName, __en: 'China Mobile Dept' },
                { __code: '028238', __cn: '电信系统部', __en: 'China Telecom Dept' },
            ];
        }
        if (sql.includes('dept_code')) {
            return [{ __code: '026921', __cn: '埃及代表处', __en: 'Egypt Rep Office' }];
        }
        return [];
    };
    const getCols = async (t) => dimCols[t] || [];
    const mapTables = { operator: ['cs_nc_comm_customer_d_list'], rep: ['common_data_rep'], country: [] };

    const rows = [
        { t1_operator_code: 'Others', repoffice_code: '026921', cnt: 630 },
        { t1_operator_code: '028262', repoffice_code: '026921', cnt: 543 },
        { t1_operator_code: '028238', repoffice_code: '026921', cnt: 197 },
    ];
    const out1 = await resolveCodeMappingsForRows(rows, { scope: 'business', mapTables, getCols, runQuery });
    assert.match(out1, /实时编码名称映射/);
    assert.match(out1, /028262: 移动系统部 \/ China Mobile Dept/);
    assert.match(out1, /028238: 电信系统部 \/ China Telecom Dept/);
    assert.match(out1, /026921: 埃及代表处 \/ Egypt Rep Office/);
    assert.doesNotMatch(out1, /Others:/, 'Others 不应作为纯数字编码去查映射');
    assert.equal(sqlLog.length, 2, '运营商 + 地代各一条轻量 IN 查询');

    // 业务维表更新后下一次立刻返回最新名称（不缓存名称值）
    liveName = '中国移动系统部（更新）';
    const out2 = await resolveCodeMappingsForRows(rows, { scope: 'business', mapTables, getCols, runQuery });
    assert.match(out2, /028262: 中国移动系统部（更新） \/ China Mobile Dept/);

    // 库里无映射表或结果已含名称列 -> 0 次查询直接返回空串
    const countBefore = sqlLog.length;
    assert.equal(await resolveCodeMappingsForRows(rows, { scope: 'business', mapTables: { operator: [], rep: [], country: [] }, getCols, runQuery }), '');
    assert.equal(await resolveCodeMappingsForRows([{ t1_operator_code: '028262', hq_cust_category_cn_name: '移动系统部' }], { scope: 'business', mapTables, getCols, runQuery }), '');
    assert.equal(sqlLog.length, countBefore);
});
