// 问卷调研（「六个一信息收集」内置工具的后端）：可配置的问卷模板、提交记录、Excel 台账导出。
// 模板与提交都存统一记录表（survey_template / survey_submission）；字段规范化与答案校验沿用主线版逻辑。
import crypto from 'node:crypto';
import { optionalDep } from '../../core/optional.js';
import { listRecords, getRecord, putRecord, deleteRecord } from '../record-store.js';

const TEMPLATE = 'survey_template';
const SUBMISSION = 'survey_submission';

const FIELD_TYPES = new Set(['text', 'textarea', 'date', 'number', 'select', 'radio', 'checkbox']);

function makeId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function normalizeOptions(options) {
    if (!Array.isArray(options)) return [];
    return options
        .map(option => {
            if (typeof option === 'string') {
                const text = option.trim();
                return text ? { label: text, value: text } : null;
            }
            const label = String(option && option.label || '').trim();
            const value = String(option && option.value || label).trim();
            return label && value ? { label, value } : null;
        })
        .filter(Boolean)
        .slice(0, 100);
}

function normalizeSuggestions(suggestions) {
    if (!Array.isArray(suggestions)) return [];
    return suggestions
        .map(group => {
            const category = String(group && group.category || '').trim();
            const items = Array.isArray(group && group.items)
                ? group.items.map(item => String(item || '').trim()).filter(Boolean).slice(0, 50)
                : [];
            return category && items.length ? { category, items } : null;
        })
        .filter(Boolean)
        .slice(0, 30);
}

function normalizeOrgChart(orgChart, options) {
    if (!Array.isArray(orgChart)) return [];
    const optionValues = new Set(options.map(option => option.value));
    const usedValues = new Set();
    return orgChart
        .map(node => {
            const value = String(node && node.value || '').trim();
            if (!value || !optionValues.has(value) || usedValues.has(value)) return null;
            usedValues.add(value);
            const parentValue = String(node && node.parentValue || '').trim();
            return {
                value,
                parentValue: parentValue && parentValue !== value && optionValues.has(parentValue) ? parentValue : ''
            };
        })
        .filter(Boolean);
}

function normalizeUrlValidation(validation) {
    if (!validation || validation.type !== 'url') return null;
    const domains = Array.isArray(validation.domains)
        ? validation.domains.map(domain => String(domain || '').trim().toLowerCase())
            .filter(Boolean).slice(0, 20)
        : [];
    return {
        type: 'url',
        allowNone: validation.allowNone !== false,
        noneValue: String(validation.noneValue || '无').trim() || '无',
        domains
    };
}

function managerOrgChart(options) {
    const findValue = patterns => {
        const option = options.find(item => patterns.some(pattern => pattern.test(item.label)));
        return option ? option.value : '';
    };
    const regionPresident = findValue([/Region President/i, /地区部总裁/, /地总/]);
    const vp = findValue([/^代表 \(VP\)$/i, /^VP$/i, /代表.*VP/i]);
    const deliveryVp = findValue([/交付VP/i, /Delivery VP/i]);
    const buDirector = findValue([/BU长/i, /BU Director/i]);
    const fr = findValue([/^FR$/i]);
    const csm = findValue([/^CSM/i]);
    const spm = findValue([/^SPM/i]);
    const ad = findValue([/^AD/i, /Account Director/i]);

    return [
        { value: regionPresident, parentValue: '' },
        { value: vp, parentValue: regionPresident },
        { value: deliveryVp, parentValue: vp },
        { value: buDirector, parentValue: vp },
        { value: fr, parentValue: deliveryVp },
        { value: csm, parentValue: deliveryVp },
        { value: spm, parentValue: deliveryVp },
        { value: ad, parentValue: buDirector }
    ].filter(node => node.value);
}

function customerOrgChart(options) {
    const findValue = patterns => {
        const option = options.find(item => patterns.some(pattern => pattern.test(item.label)));
        return option ? option.value : '';
    };
    const ceo = findValue([/^CEO$/i]);
    const cto = findValue([/^CTO$/i]);
    const gm = findValue([/^GM$/i]);
    const hod = findValue([/^HOD$/i]);
    const operationDirector = findValue([/运维总监/i, /O&M Director/i]);

    return [
        { value: ceo, parentValue: '' },
        { value: cto, parentValue: ceo },
        { value: gm, parentValue: ceo },
        { value: hod, parentValue: ceo },
        { value: operationDirector, parentValue: gm }
    ].filter(node => node.value);
}

function activityDescriptionSuggestions() {
    return [
        { category: '保障类（最常见）', items: [
            '{客户}{节日/事件}首日保障（{运营商1}/{运营商2}/{运营商3}）',
            '{客户}夏令时调整值守保障',
            '{客户} DST Major Operation Assurance'
        ] },
        { category: '故障恢复类', items: [
            'P1{故障描述}故障恢复保障',
            '{客户}{设备}{故障描述}故障恢复保障',
            '{客户}VIP站点紧急抢修恢复保障'
        ] },
        { category: '高层对标类', items: [
            '会见{客户} CTO，汇报{项目}保障结果',
            '地总与{客户}客户高层对标（{主题}）',
            '{客户} CEO/CTO高层对标 - {人员}（含服务主题）'
        ] },
        { category: '例会/汇报类', items: [
            'X月 CNBG/EBG网络安全大会，主管讲安全',
            '{客户}客户月度维护例会汇报'
        ] },
        { category: 'Summit/Drilling类', items: [
            '{客户} Service Summit',
            '{客户} {领域} Drilling Summary'
        ] }
    ];
}

function normalizeFields(fields) {
    if (!Array.isArray(fields) || fields.length === 0) {
        const err = new Error('模板至少需要一个字段');
        err.status = 400;
        throw err;
    }

    const usedKeys = new Set();
    return fields.slice(0, 100).map((field, index) => {
        const label = String(field && field.label || '').trim();
        if (!label) {
            const err = new Error(`第 ${index + 1} 个字段缺少名称`);
            err.status = 400;
            throw err;
        }

        let key = String(field.key || '')
            .trim()
            .replace(/[^a-zA-Z0-9_-]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 64);
        if (!key) key = `field_${index + 1}`;
        const baseKey = key;
        let suffix = 2;
        while (usedKeys.has(key)) key = `${baseKey}_${suffix++}`;
        usedKeys.add(key);

        const type = FIELD_TYPES.has(field.type) ? field.type : 'text';
        const options = normalizeOptions(field.options);
        if (['select', 'radio', 'checkbox'].includes(type) && options.length === 0) {
            const err = new Error(`字段“${label}”至少需要一个选项`);
            err.status = 400;
            throw err;
        }

        const orgChart = normalizeOrgChart(field.orgChart, options);
        return {
            id: String(field.id || makeId('field')),
            key,
            label,
            exportLabel: String(field.exportLabel || '').trim().slice(0, 200),
            description: String(field.description || '').trim().slice(0, 500),
            type,
            required: Boolean(field.required),
            placeholder: String(field.placeholder || '').trim().slice(0, 200),
            defaultValue: field.defaultValue === undefined ? '' : field.defaultValue,
            width: field.width === 'half' ? 'half' : 'full',
            display: ['cards', 'orgchart'].includes(field.display) ? field.display : 'standard',
            min: field.min === '' || field.min === undefined ? null : Number(field.min),
            max: field.max === '' || field.max === undefined ? null : Number(field.max),
            options,
            suggestions: normalizeSuggestions(field.suggestions),
            orgChart,
            validation: normalizeUrlValidation(field.validation)
        };
    });
}

function defaultTemplates() {
    const managerOptions = ['代表 (VP)', 'BU长 (BU Director)', 'AD (Account Director)', '交付VP (Delivery VP)', 'FR', 'BU主管 (BU Manager)', 'CSM', 'SPM', 'BG长 (BG Director)', 'VP (Region President)'];
    const customerOptions = ['CTO', '运维总监', '部门维护主管', 'CEO', 'HOD', 'GM', '无'];
    const sharedFields = [
        {
            key: 'activityDesc', label: '活动描述', description: 'Activity Description', type: 'textarea',
            required: true, width: 'full', placeholder: '可选择推荐模板，也可以自由输入',
            suggestions: activityDescriptionSuggestions()
        },
        { key: 'activityDate', label: '活动日期', description: 'Activity Date', type: 'date', required: true, width: 'half' },
        {
            key: 'managerRoles', label: '参加主管', description: '可多选', type: 'checkbox', required: true, display: 'orgchart', width: 'full',
            options: managerOptions,
            orgChart: managerOrgChart(normalizeOptions(managerOptions))
        },
        {
            key: 'materialArchive', label: '素材归档目录', type: 'text', required: true,
            defaultValue: '无', width: 'full',
            validation: { type: 'url', allowNone: true, noneValue: '无', domains: ['onebox.huawei.com'] }
        },
        {
            key: 'networkSafety', label: '涉及网络平安内容', type: 'radio', required: true, display: 'cards', width: 'half',
            options: ['是', '否']
        },
        {
            key: 'jamLink', label: 'JAM链接', type: 'text', required: true,
            defaultValue: '无', width: 'half',
            validation: { type: 'url', allowNone: true, noneValue: '无', domains: ['3ms.huawei.com'] }
        },
        {
            key: 'customerRoles', label: '卷入客户角色', type: 'checkbox', display: 'orgchart', width: 'full',
            options: customerOptions,
            orgChart: customerOrgChart(normalizeOptions(customerOptions))
        }
    ];

    return [
        ['maintenance', '与客户的维护活动', 'Maintenance Activities with Customers'],
        ['communication', '与维护人员的面对面沟通', 'Face-to-face Communication with Staff'],
        ['recovery', '网络故障的恢复支持', 'Network Fault Recovery Support'],
        ['supervision', '重大变更的现场督导', 'Major Changes Onsite Supervision'],
        ['drill', '与客户应急预案的实操演练', 'Emergency Drill with Customers'],
        ['declaration', '代表处网络安全宣誓', 'Network Safety Declaration']
    ].map(([id, name, description]) => ({
        id,
        name,
        description,
        fields: sharedFields
    }));
}

function validateAnswers(template, answers) {
    const normalized = {};
    for (const field of template.fields) {
        const value = answers ? answers[field.key] : undefined;
        const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
        if (field.required && empty) {
            const err = new Error(`请填写“${field.label}”`);
            err.status = 400;
            throw err;
        }
        if (!empty && field.validation && field.validation.type === 'url') {
            const textValue = String(value).trim();
            const isNone = field.validation.allowNone && textValue === field.validation.noneValue;
            if (!isNone) {
                let parsed;
                try {
                    parsed = new URL(textValue);
                } catch (parseErr) {
                    const err = new Error(`“${field.label}”必须填写完整的网址链接`);
                    err.status = 400;
                    throw err;
                }
                if (parsed.protocol !== 'https:') {
                    const err = new Error(`“${field.label}”必须使用 HTTPS 链接`);
                    err.status = 400;
                    throw err;
                }
                const domains = Array.isArray(field.validation.domains) ? field.validation.domains : [];
                const hostname = parsed.hostname.toLowerCase();
                const allowed = domains.length === 0 || domains.some(domain =>
                    hostname === domain || hostname.endsWith(`.${domain}`)
                );
                if (!allowed) {
                    const err = new Error(`“${field.label}”必须使用指定域名：${domains.join('、')}`);
                    err.status = 400;
                    throw err;
                }
            }
        }
        if (field.type === 'checkbox') {
            normalized[field.key] = Array.isArray(value) ? Array.from(new Set(value.map(String))).slice(0, 100) : [];
        } else if (field.type === 'number' && !empty) {
            const numberValue = Number(value);
            if (!Number.isFinite(numberValue)) {
                const err = new Error(`“${field.label}”必须是有效数字`);
                err.status = 400;
                throw err;
            }
            normalized[field.key] = numberValue;
        } else {
            normalized[field.key] = empty ? '' : String(value).slice(0, 20000);
        }
    }
    return normalized;
}

// ── 存取 ──
const mapTemplate = (record) => ({ ...record.payload, active: record.payload.active !== false, createdAt: record.createdAt, updatedAt: record.updatedAt });
const mapSubmission = (record) => ({ ...record.payload, createdAt: record.payload.createdAt || record.createdAt, updatedAt: record.updatedAt });
const httpError = (message, status) => Object.assign(new Error(message), { status });

let seeding = null;
/** 一个模板都没有时放入六个默认模板（与主线版一致） */
async function ensureTemplates() {
    const records = await listRecords(TEMPLATE, { withPayload: true, limit: 500 });
    if (records.length) return records;
    seeding ||= (async () => {
        let order = 0;
        for (const template of defaultTemplates()) {
            order += 1;
            await putRecord(TEMPLATE, {
                id: template.id, name: template.name, sortKey: String(order).padStart(6, '0'),
                payload: { id: template.id, name: template.name, description: template.description, fields: normalizeFields(template.fields), active: true },
            });
        }
    })().finally(() => { seeding = null; });
    await seeding;
    return listRecords(TEMPLATE, { withPayload: true, limit: 500 });
}

export async function listTemplates() {
    // 记录表按排序键倒序；模板按创建先后正序展示
    return (await ensureTemplates()).map(mapTemplate).reverse();
}

export async function getTemplate(id) {
    await ensureTemplates();
    const record = await getRecord(TEMPLATE, String(id || ''));
    return record ? mapTemplate(record) : null;
}

export async function saveTemplate(payload, username = '') {
    const name = String(payload?.name || '').trim();
    if (!name) throw httpError('模板名称不能为空', 400);
    const id = String(payload.id || makeId('survey')).trim().replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64);
    const fields = normalizeFields(payload.fields);
    const existing = await getRecord(TEMPLATE, id);
    await putRecord(TEMPLATE, {
        id, name, sortKey: existing?.sortKey || `1${Date.now()}`, updatedBy: username,
        payload: { id, name, description: String(payload.description || '').trim(), fields, active: payload.active !== false },
        createdAt: existing ? Date.parse(existing.createdAt) : 0,
    });
    return getTemplate(id);
}

export const deleteTemplate = (id) => deleteRecord(TEMPLATE, String(id || ''));

export async function createSubmission(payload, username) {
    const template = await getTemplate(String(payload?.templateId || ''));
    if (!template || !template.active) throw httpError('调查模板不存在或已停用', 404);
    const answers = validateAnswers(template, payload.answers || {});
    const id = makeId('submission');
    const createdAt = new Date().toISOString();
    await putRecord(SUBMISSION, {
        id, group: template.id, name: template.name, sortKey: createdAt, updatedBy: username,
        payload: { id, templateId: template.id, templateName: template.name, answers, submittedBy: String(username || ''), createdAt },
    });
    return { id, templateId: template.id, templateName: template.name, submittedBy: username || '', createdAt };
}

export async function listSubmissions({ templateId = '', limit = 100 } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 100, 50_000));
    return (await listRecords(SUBMISSION, { group: String(templateId || ''), withPayload: true, limit: max, maxRows: 50_000 })).map(mapSubmission);
}

export async function getSubmission(id) {
    const record = await getRecord(SUBMISSION, String(id || ''));
    return record ? mapSubmission(record) : null;
}

export async function updateSubmission(id, payload, username) {
    const existing = await getRecord(SUBMISSION, String(id || ''));
    if (!existing) throw httpError('记录不存在', 404);
    const template = await getTemplate(String(payload?.templateId || existing.payload.templateId));
    if (!template) throw httpError('调查模板不存在', 404);
    const answers = validateAnswers(template, payload.answers || {});
    await putRecord(SUBMISSION, {
        id: existing.id, group: template.id, name: template.name, sortKey: existing.sortKey, updatedBy: username,
        payload: { ...existing.payload, templateId: template.id, templateName: template.name, answers },
        createdAt: Date.parse(existing.createdAt),
    });
    return getSubmission(existing.id);
}

export const deleteSubmission = (id) => deleteRecord(SUBMISSION, String(id || ''));

// ── Excel 台账 ──
const MANAGER_STAT_COLUMNS = [
    { key: 'managerAD', label: '系统部AD Account Director', patterns: [/^AD$/i, /Account Director/i] },
    { key: 'managerDeliveryVP', label: '交付副代表 Delivery & Service Director', patterns: [/Delivery VP/i, /交付VP/i, /交付副代表/i] },
    { key: 'managerBG', label: 'BG长 BG Director', patterns: [/BG Director/i, /BG长/i, /BU Director/i, /BU长/i] },
    { key: 'managerCountry', label: '代表 Country General Manager', patterns: [/^VP$/i, /^代表 \(VP\)$/i, /Country General Manager/i] },
    { key: 'managerRegion', label: '地总 Region President', patterns: [/Region President/i, /地区部总裁/i, /地总/i] },
];
const optionLabels = (template, key) => new Map((template?.fields.find((f) => f.key === key)?.options || []).map((o) => [String(o.value), String(o.label)]));
function managerStatValue(template, answers, column) {
    const selected = Array.isArray(answers?.managerRoles) ? answers.managerRoles.map(String) : [];
    const labels = optionLabels(template, 'managerRoles');
    const texts = [...new Set(selected.flatMap((value) => [value, labels.get(value) || '']).filter(Boolean))];
    return texts.some((value) => column.patterns.some((pattern) => pattern.test(value))) ? 1 : 0;
}
function exportAnswerValue(template, key, value) {
    if (!Array.isArray(value)) return value ?? '';
    const labels = optionLabels(template, key);
    return [...new Set(value.map((item) => labels.get(String(item)) || String(item)))].join('/');
}

export async function exportSubmissionsWorkbook(templateId = '') {
    const ExcelJS = (await optionalDep('exceljs', '问卷台账 Excel 导出')).default;
    const [templates, submissions] = await Promise.all([listTemplates(), listSubmissions({ templateId, limit: 50_000 })]);
    const exportTemplates = templateId ? templates.filter((t) => t.id === templateId) : templates;
    const fieldMap = new Map();
    for (const template of exportTemplates) {
        for (const field of template.fields) if (!fieldMap.has(field.key)) fieldMap.set(field.key, { label: field.label, exportLabel: field.exportLabel || field.label });
    }
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Dragon Claw';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('六个一信息台账', { views: [{ state: 'frozen', ySplit: 1 }] });
    const dataColumns = Array.from(fieldMap, ([key, config]) => ({
        header: config.exportLabel || config.label,
        key: `answer_${key}`,
        width: key === 'activityDesc' ? 36 : ['managerRoles', 'customerRoles'].includes(key) ? 30 : Math.min(20, Math.max(10, String(config.exportLabel || config.label).length + 3)),
    }));
    const managerColumns = MANAGER_STAT_COLUMNS.map((column) => ({ header: column.label, key: column.key, width: 16 }));
    const managerIndex = dataColumns.findIndex((column) => column.key === 'answer_managerRoles');
    if (managerIndex >= 0) dataColumns.splice(managerIndex + 1, 0, ...managerColumns);
    else dataColumns.push(...managerColumns);
    sheet.columns = dataColumns;
    for (const item of submissions) {
        const template = templates.find((candidate) => candidate.id === item.templateId);
        const row = {};
        for (const [key] of fieldMap) row[`answer_${key}`] = exportAnswerValue(template, key, item.answers[key]);
        for (const column of MANAGER_STAT_COLUMNS) row[column.key] = managerStatValue(template, item.answers, column);
        sheet.addRow(row);
    }
    sheet.getRow(1).eachCell((cell) => {
        cell.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1768AC' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    for (const column of MANAGER_STAT_COLUMNS) {
        const headerCell = sheet.getCell(1, sheet.getColumn(column.key).number);
        headerCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD89B20' } };
        headerCell.font = { bold: true, size: 9, color: { argb: 'FF3B2B00' } };
    }
    sheet.getRow(1).height = 52;
    sheet.autoFilter = { from: 'A1', to: sheet.getRow(1).getCell(sheet.columnCount).address };
    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        row.height = 18;
        row.font = { size: 9 };
        row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
        if (fieldMap.has('activityDesc')) row.getCell(sheet.getColumn('answer_activityDesc').number).alignment = { vertical: 'middle', horizontal: 'left', wrapText: false };
        if (rowNumber % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F7FA' } };
    });
    return { filename: `六个一信息台账_${new Date().toISOString().slice(0, 10)}.xlsx`, buffer: Buffer.from(await workbook.xlsx.writeBuffer()) };
}
