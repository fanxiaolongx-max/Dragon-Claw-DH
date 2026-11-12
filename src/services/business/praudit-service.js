// PR 稽查：稽查模板（字段、检查点、报告字段、筛选规则、原因模板）
import crypto from 'node:crypto';
import { BusinessError } from '../../core/errors.js';
import { listRecords, getRecord, putRecord, deleteRecord } from '../record-store.js';

const KIND = 'praudit_config';

// 首次使用时自动放入的内置模板
const DEFAULT_CONFIG = {
    id: 'rc_audit_default',
    name: 'RC 整改单审计 (内置)',
    fields: [
        '任务号', '索引号', '整改通知中文ID', '整改通知英文ID', '整改通知中文链接', '整改通知英文链接',
        '标题', '运营商名称', '产品域', '任务状态', '处理人', '是否延期', '延期原因', '延期审批状态',
        '延期审批人', '延期后计划完成时间', '产品存量', '决策不实施数', '排查完成时间', '延期申请备注',
        '累计延期天数', '延期审批时间', '累计延期次数', '历史责任人', '延期备案方式',
    ],
    checkpoints: [
        { key: 'c1', name: '① 书面证据', nameEn: 'Written Evidence', desc: '客户确切回复', descEn: 'Explicit customer reply' },
        { key: 'c2', name: '② 产品名称', nameEn: 'Product Name', desc: '附件明确包含', descEn: 'Clearly included in attachment' },
        { key: 'c3', name: '③ 数量', nameEn: 'Quantity', desc: '附件明确包含', descEn: 'Clearly included in attachment' },
        { key: 'c4', name: '④ 延期时间', nameEn: 'Extension Time', desc: '明确时间', descEn: 'Explicit time' },
        { key: 'c5', name: '⑤ 风险传递', nameEn: 'Risk Transfer', desc: '邮件明确风险', descEn: 'Risk clearly stated in email' },
        { key: 'c6', name: '⑥ 有效性核实', nameEn: 'Validity Verification', desc: '客户邮箱/签字', descEn: 'Customer email/signature' },
        { key: 'c7', name: '⑦ 高层审批', nameEn: 'Executive Approval', desc: '交付部长审批', descEn: 'Delivery Dept. Head approval' },
    ],
    reportFields: ['标题', '处理人', '任务状态', '是否延期'],
};

const toConfig = (record) => ({ ...record.payload, id: record.id, name: record.name, createdAt: record.createdAt, updatedAt: record.updatedAt });

function normalize(input, id) {
    const fields = Array.isArray(input.fields) ? input.fields : [];
    return {
        id,
        name: String(input.name).trim().slice(0, 200),
        fields,
        allFields: Array.isArray(input.allFields) && input.allFields.length ? input.allFields : fields,
        checkpoints: Array.isArray(input.checkpoints) ? input.checkpoints : [],
        reportFields: Array.isArray(input.reportFields) ? input.reportFields : [],
        groupField: String(input.groupField || ''),
        filterRules: Array.isArray(input.filterRules) ? input.filterRules : [],
        reasonTemplates: Array.isArray(input.reasonTemplates) ? input.reasonTemplates : [],
    };
}

async function save(config, updatedBy, createdAt = 0) {
    // 按创建时间排序：排序键固定为创建时间，改模板不会改变它在列表里的位置
    const existing = await getRecord(KIND, config.id);
    const created = existing ? Date.parse(existing.createdAt) : (createdAt || Date.now());
    return toConfig({ ...(await putRecord(KIND, { id: config.id, name: config.name, sortKey: String(created).padStart(15, '0'), payload: config, updatedBy, createdAt: created })), payload: config });
}

export async function listPrauditConfigs() {
    let records = await listRecords(KIND, { withPayload: true, limit: 500 });
    if (!records.length) {
        await save(normalize(DEFAULT_CONFIG, DEFAULT_CONFIG.id), 'system');
        records = await listRecords(KIND, { withPayload: true, limit: 500 });
    }
    // 桌面版按创建先后排列
    return records.filter((r) => r.payload).reverse().map(toConfig);
}

export async function savePrauditConfig(input = {}, updatedBy = '') {
    if (!input.name || !Array.isArray(input.fields) || !Array.isArray(input.checkpoints)) throw new BusinessError('缺少必填项：name、fields 或 checkpoints');
    const id = String(input.id || `audit_${crypto.randomBytes(8).toString('hex')}`).slice(0, 96);
    return save(normalize(input, id), updatedBy);
}

export const deletePrauditConfig = (id) => deleteRecord(KIND, id);
