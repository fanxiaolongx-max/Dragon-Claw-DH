import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profile, hintsOf, codeMappingHintForRows } from '../src/services/netcare/table-catalog.js';

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
