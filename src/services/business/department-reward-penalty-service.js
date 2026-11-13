// 负向事件管理（内置工具 department-reward-penalty 的后端）：人员名册、扣罚规则、违规记录、配置项、操作审计、强制修改口令、备份与恢复。
// 数据合并、备份包解析与校验沿用主线版 models/department-reward-penalty-repository.js；
// 存取换成统一记录表（drp_item 各类条目、drp_audit 审计）、应用库键值（口令）和文件表（证据附件、覆盖恢复前的安全备份）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STATIC_DIR } from '../../config.js';
import { optionalDep } from '../../core/optional.js';
import { getSetting, saveSetting } from '../system-service.js';
import { listRecords, getRecord, putRecord, deleteRecord } from '../record-store.js';
import { saveBlobAsset, getBlobAsset, listBlobAssets, deleteBlobAsset } from '../blob-service.js';

const defaultRules = JSON.parse(fs.readFileSync(path.join(STATIC_DIR, 'builtin-tools', 'department-reward-penalty', 'default-rules.json'), 'utf8'));
const jszip = async () => (await optionalDep('jszip', '负向事件数据备份包')).default;

const DEFAULT_ROLES = ['MTD', 'TL', 'TE', 'SPM', 'MS', 'SEC', 'Software', 'CS', 'NTD', 'FME', 'TD', 'PM', 'admin', 'Redline Resource', 'SP manager', 'SP admin', 'Virtual Account'];
const DEFAULT_DEDUCTIONS = ['1 Month/Time', '1 Month/Ticket', '1 Quarter/Time', '1 Quarter/Ticket', '0.5 Year/Time', '1 Month/Resource', '1 Month/FME', '1 Month/Account', 'Quarterly', '1 Monthly/Time', 'Custom'];
const DEFAULT_DEDUCTION_CATEGORIES = [{ id: 'monthly', value: '按月' }, { id: 'quarterly', value: '按季度' }, { id: 'half-year', value: '按半年' }, { id: 'other', value: '其他' }];
const deductionCategory = value => /quarter/i.test(value) ? 'quarterly' : /year/i.test(value) ? 'half-year' : /month/i.test(value) ? 'monthly' : 'other';
const CORE_BACKUP_KINDS = new Set(['personnel', 'rules', 'records', 'roles', 'deductions', 'deductionCategories', 'customerGroups', 'businessUnits']);
const KINDS = new Set([...CORE_BACKUP_KINDS, 'snapshotMappings']);
const DEFAULT_SNAPSHOT_MAPPINGS = {
    roles: [
        { scanned: 'Solution Developer', target: 'TD' },
        { scanned: '方案制作人', target: 'TD' },
        { scanned: 'Originator', target: 'PM' },
        { scanned: '建单人', target: 'PM' },
        { scanned: 'Creator', target: 'PM' },
        { scanned: 'Owner', target: 'TL' },
        { scanned: 'L1 Solution Reviewer', target: 'SPM' },
        { scanned: 'L1评审人', target: 'SPM' },
        { scanned: '实施人', target: 'FME' },
        { scanned: 'Operator', target: 'FME' },
        { scanned: 'STAFF', target: 'FME' },
        { scanned: '申请人', target: 'TE' }
    ],
    customerGroups: [
        { scanned: 'ORG', target: 'Orange' },
        { scanned: 'EG-Egypt Orange', target: 'Orange' },
        { scanned: 'Orange Egypt', target: 'Orange' },
        { scanned: 'Orange', target: 'Orange' },
        { scanned: 'Vodafone', target: 'VDF' },
        { scanned: 'VF', target: 'VDF' },
        { scanned: 'VDF', target: 'Vodafone' },
        { scanned: 'EG-Egypt Vodafone', target: 'Vodafone' },
        { scanned: 'ET', target: 'Etisalat' },
        { scanned: 'EG-Egypt ET', target: 'Etisalat' },
        { scanned: 'ET (Etisalat)', target: 'Etisalat' },
        { scanned: 'Etisalat', target: 'Etisalat' },
        { scanned: 'Telecom Egypt', target: 'WE' },
        { scanned: 'TE', target: 'WE' },
        { scanned: 'WE', target: 'Telecom Egypt' },
        { scanned: 'EG-Egypt Telecom', target: 'Telecom Egypt' }
    ],
    businessUnits: [
        { scanned: '软件', target: 'Software' },
        { scanned: '无线', target: 'Wireless' },
        { scanned: '核心网', target: 'Core' },
        { scanned: '数通', target: 'Datacom' },
        { scanned: '传输', target: 'Transmission' }
    ]
};
const BACKUP_EVIDENCE_FILENAME = /^[a-f0-9-]{36}\.(?:pdf|png|jpg|txt|zip|rar|7z|tar|gz|eml|msg)$/i;
const MAX_BACKUP_ENTRIES = 2000;
const MAX_BACKUP_JSON_BYTES = 5 * 1024 * 1024;
const MAX_BACKUP_EVIDENCE_BYTES = 100 * 1024 * 1024;
const MAX_BACKUP_EVIDENCE_FILE_BYTES = 10 * 1024 * 1024;

async function list() {
    const rows = await itemRows();
    const state = { personnel: [], rules: [], records: [], roles: [], deductions: [], deductionCategories: [], customerGroups: [], businessUnits: [], snapshotMappings: null };
    for (const row of rows) {
        if (row.kind === 'snapshotMappings' && row.id === 'config') {
            try { state.snapshotMappings = JSON.parse(row.payload_json); } catch (_) {}
        } else if (CORE_BACKUP_KINDS.has(row.kind)) {
            state[row.kind].push(JSON.parse(row.payload_json));
        }
    }
    if (!state.snapshotMappings) {
        state.snapshotMappings = JSON.parse(JSON.stringify(DEFAULT_SNAPSHOT_MAPPINGS));
    }
    const savedRules = new Map(state.rules.map(rule => [rule.id, rule]));
    state.rules = [...defaultRules.map(rule => savedRules.get(rule.id) || rule), ...state.rules.filter(rule => !defaultRules.some(seed => seed.id === rule.id))];
    for (const [kind, defaults] of [['roles', [...new Set([...DEFAULT_ROLES, ...defaultRules.flatMap(rule => rule.roles).filter(r => r.toUpperCase() !== 'ALL')])]], ['deductions', [...new Set([...DEFAULT_DEDUCTIONS, ...defaultRules.map(rule => rule.deduct)])]]]) {
        const values = new Map(defaults.map(value => [value, { id: value, value, ...(kind === 'deductions' ? { categoryId: deductionCategory(value) } : {}) }]));
        for (const saved of state[kind]) values.set(saved.id, saved);
        state[kind] = [...values.values()].filter(item => !item.archived && (kind !== 'roles' || item.value.toUpperCase() !== 'ALL')).map(item => kind === 'deductions' ? { ...item, categoryId: item.categoryId || deductionCategory(item.value) } : item);
    }
    const categories = new Map(DEFAULT_DEDUCTION_CATEGORIES.map(item => [item.id, item]));
    for (const saved of state.deductionCategories) categories.set(saved.id, saved);
    state.deductionCategories = [...categories.values()].filter(item => !item.archived);
    state.customerGroups = state.customerGroups.filter(item => !item.archived);
    state.businessUnits = state.businessUnits.filter(item => !item.archived);
    return state;
}

async function put(kind, id, payload, actor, action = '保存', reason = '') {
    const results = await putMany([{ kind, id, payload }], actor, action, reason);
    return results[0];
}

async function parseBackupContent(bufferOrObject) {
    if (!bufferOrObject) throw Object.assign(new Error('备份数据包为空'), { status: 400 });
    if (Buffer.isBuffer(bufferOrObject)) {
        if (bufferOrObject.length >= 4 && bufferOrObject[0] === 0x50 && bufferOrObject[1] === 0x4b && bufferOrObject[2] === 0x03 && bufferOrObject[3] === 0x04) {
            const zip = await (await jszip()).loadAsync(bufferOrObject);
            const zipEntries = Object.values(zip.files);
            if (zipEntries.length > MAX_BACKUP_ENTRIES) throw Object.assign(new Error('备份包文件数量超过安全限制'), { status: 400 });
            const dataFile = zip.file('data.json');
            if (!dataFile) throw Object.assign(new Error('备份数据包中缺少 data.json 文件'), { status: 400 });
            const declaredDataSize = Number(dataFile._data?.uncompressedSize);
            if (Number.isFinite(declaredDataSize) && declaredDataSize > MAX_BACKUP_JSON_BYTES) throw Object.assign(new Error('备份数据内容超过安全限制'), { status: 400 });
            const dataText = await dataFile.async('string');
            if (Buffer.byteLength(dataText, 'utf8') > MAX_BACKUP_JSON_BYTES) throw Object.assign(new Error('备份数据内容超过安全限制'), { status: 400 });
            const data = JSON.parse(dataText);
            const manifestFile = zip.file('manifest.json');
            const manifest = manifestFile ? JSON.parse(await manifestFile.async('string')) : null;

            const evidenceMap = new Map();
            const files = zip.file(/^evidence\//);
            let totalEvidenceBytes = 0;
            for (const file of files) {
                if (!file.dir) {
                    const filename = path.basename(file.name);
                    if (!BACKUP_EVIDENCE_FILENAME.test(filename)) throw Object.assign(new Error('备份包中包含无效的证据文件名'), { status: 400 });
                    const declaredSize = Number(file._data?.uncompressedSize);
                    if (Number.isFinite(declaredSize) && (declaredSize > MAX_BACKUP_EVIDENCE_FILE_BYTES || totalEvidenceBytes + declaredSize > MAX_BACKUP_EVIDENCE_BYTES)) throw Object.assign(new Error('备份包证据文件超过安全限制'), { status: 400 });
                    const buffer = await file.async('nodebuffer');
                    if (buffer.length > MAX_BACKUP_EVIDENCE_FILE_BYTES || totalEvidenceBytes + buffer.length > MAX_BACKUP_EVIDENCE_BYTES) throw Object.assign(new Error('备份包证据文件超过安全限制'), { status: 400 });
                    totalEvidenceBytes += buffer.length;
                    evidenceMap.set(filename, buffer);
                }
            }
            return { data, manifest, evidenceMap };
        } else {
            const text = bufferOrObject.toString('utf8');
            const parsed = JSON.parse(text);
            if (parsed.data && typeof parsed.data === 'object') {
                return { data: parsed.data, manifest: parsed.manifest || null, evidenceMap: new Map() };
            }
            return { data: parsed, manifest: null, evidenceMap: new Map() };
        }
    } else if (typeof bufferOrObject === 'object') {
        if (bufferOrObject.data && typeof bufferOrObject.data === 'object') {
            return { data: bufferOrObject.data, manifest: bufferOrObject.manifest || null, evidenceMap: new Map() };
        }
        return { data: bufferOrObject, manifest: null, evidenceMap: new Map() };
    }
    throw Object.assign(new Error('不支持的数据包格式'), { status: 400 });
}

function invalidBackup(message) {
    throw Object.assign(new Error(message), { status: 400 });
}

function validateIncomingData(data, { mode = 'merge', currentState } = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) invalidBackup('数据包内容不是有效的对象');
    const presentKinds = [...CORE_BACKUP_KINDS].filter(kind => Object.hasOwn(data, kind));
    if (!presentKinds.length) invalidBackup('数据包不包含奖惩业务数据');
    if (mode === 'replace' && presentKinds.length !== CORE_BACKUP_KINDS.size) invalidBackup('覆盖恢复需要包含全部数据分类的完整备份包');
    if (mode === 'replace' && !presentKinds.some(kind => Array.isArray(data[kind]) && data[kind].length)) invalidBackup('覆盖恢复不能使用全空数据包');
    for (const kind of CORE_BACKUP_KINDS) {
        if (Object.hasOwn(data, kind) && !Array.isArray(data[kind])) {
            invalidBackup(`数据包中的 "${kind}" 不是有效的数组`);
        }
        const ids = new Set();
        for (const item of data[kind] || []) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) invalidBackup(`数据包中的 "${kind}" 包含无效项目`);
            const itemId = String(item.id || item.value || '').trim();
            if (!itemId || itemId.length > 100 || ids.has(itemId)) invalidBackup(`数据包中的 "${kind}" 存在缺失或重复 ID`);
            ids.add(itemId);
        }
    }
    if (!currentState) return;
    const fromCurrent = kind => mode === 'merge' ? currentState[kind] || [] : [];
    const combined = kind => new Map([...fromCurrent(kind), ...(data[kind] || [])].map(item => [item.id || item.value, item]));
    const groups = combined('customerGroups'), bus = combined('businessUnits');
    const roles = new Set([...DEFAULT_ROLES, ...defaultRules.flatMap(rule => rule.roles), ...combined('roles').values()].map(item => typeof item === 'string' ? item : item.value));
    const deductions = new Set([...DEFAULT_DEDUCTIONS, ...defaultRules.map(rule => rule.deduct), ...combined('deductions').values()].map(item => typeof item === 'string' ? item : item.value));
    const categories = new Set([...DEFAULT_DEDUCTION_CATEGORIES.map(item => item.id), ...combined('deductionCategories').keys()]);
    const personnel = combined('personnel');
    const rules = new Map([...defaultRules, ...combined('rules').values()].map(rule => [rule.id, rule]));
    for (const deduction of data.deductions || []) {
        if (!deduction.value || !categories.has(deduction.categoryId || deductionCategory(deduction.value))) invalidBackup('扣罚标准存在无效分类');
    }
    for (const person of data.personnel || []) {
        if (!String(person.name || '').trim()) invalidBackup('人员姓名不能为空');
        const personRoleValues = Array.isArray(person.roles) ? person.roles : [person.role].filter(Boolean);
        if (!personRoleValues.length || personRoleValues.some(role => !roles.has(role))) invalidBackup('人员引用了无效角色');
        const groupIds = Array.isArray(person.customerGroupIds) ? person.customerGroupIds : [person.customerGroupId].filter(Boolean);
        if (groupIds.some(id => !groups.has(id))) invalidBackup('人员引用了不存在的客户群');
        if (!person.archived && !groupIds.length && (Object.hasOwn(person, 'customerGroupIds') || Object.hasOwn(person, 'customerGroupId'))) invalidBackup('在册人员至少需要一个客户群');
        const buIds = Array.isArray(person.businessUnitIds) ? person.businessUnitIds : [];
        if (buIds.some(id => !bus.has(id))) invalidBackup('人员引用了不存在的 BU');
    }
    for (const rule of data.rules || []) {
        const ruleRoleValues = Array.isArray(rule.roles) ? rule.roles : String(rule.roles || '').split(/[,+/]/).map(value => value.trim()).filter(Boolean);
        if (!rule.svcModule || !rule.subModule || !rule.desc || !ruleRoleValues.length || ruleRoleValues.some(role => role !== 'ALL' && !roles.has(role)) || !deductions.has(rule.deduct)) invalidBackup('规则字段或角色、扣罚标准引用无效');
        if (rule.weight != null && (!Number.isInteger(Number(rule.weight)) || Number(rule.weight) < 0 || Number(rule.weight) > 100)) invalidBackup('规则权重无效');
    }
    for (const record of data.records || []) {
        if (!['draft', 'published', 'revoked', 'archived'].includes(record.status) || !/^\d{4}-\d{2}-\d{2}$/.test(String(record.date || ''))) invalidBackup('违规记录状态或日期无效');
        const historical = record.status !== 'draft';
        if (!personnel.has(record.staffId) && !(historical && record.personSnapshot?.name)) invalidBackup('违规记录引用了不存在的人员');
        if (!rules.has(record.ruleId) && !(historical && record.ruleSnapshot?.desc)) invalidBackup('违规记录引用了不存在的规则');
        if (record.customerGroupId && !groups.has(record.customerGroupId) && !(historical && record.personSnapshot?.customerGroupName)) invalidBackup('违规记录引用了不存在的客户群');
        if (record.status === 'draft' && !record.customerGroupId && record.createdBy !== 'legacy-import') invalidBackup('违规草稿缺少客户群');
    }
}

async function inspectBackupPackage(bufferOrObject, { mode = 'merge' } = {}) {
    const { data: incoming, manifest, evidenceMap } = await parseBackupContent(bufferOrObject);
    const currentState = await list();
    validateIncomingData(incoming, { mode, currentState });
    const diff = {};
    const stats = {};

    for (const kind of CORE_BACKUP_KINDS) {
        const items = incoming[kind] || [];
        stats[kind] = items.length;
        const currentItems = currentState[kind] || [];
        const currentIdSet = new Set(currentItems.map(item => String(item.id || item.value)));
        let newCount = 0, updateCount = 0;
        for (const item of items) {
            const id = String(item.id || item.value);
            if (currentIdSet.has(id)) updateCount++;
            else newCount++;
        }
        diff[kind] = { new: newCount, update: updateCount, total: items.length, current: currentItems.length };
    }
    stats.evidenceFiles = evidenceMap ? evidenceMap.size : 0;

    return {
        valid: true,
        manifest: manifest || { type: 'department-reward-penalty-backup', version: 1, exportedAt: '未知' },
        stats,
        diff
    };
}

async function getSnapshotMappings() {
    const row = await itemRow('snapshotMappings', 'config');
    if (!row || !row.payload_json) {
        return JSON.parse(JSON.stringify(DEFAULT_SNAPSHOT_MAPPINGS));
    }
    try {
        const saved = JSON.parse(row.payload_json);
        const hasCustomBUs = Boolean(saved.hasCustomBusinessUnits);
        const buList = Array.isArray(saved.businessUnits) ? saved.businessUnits : null;
        let businessUnits = DEFAULT_SNAPSHOT_MAPPINGS.businessUnits;
        if (hasCustomBUs && buList) {
            businessUnits = buList;
        } else if (buList && buList.length > 0) {
            businessUnits = buList;
        }

        const savedRoles = Array.isArray(saved.roles) ? [...saved.roles] : [];
        for (const def of DEFAULT_SNAPSHOT_MAPPINGS.roles) {
            if (!savedRoles.some(m => String(m.scanned || '').trim().toLowerCase() === String(def.scanned).trim().toLowerCase())) {
                savedRoles.push(def);
            }
        }

        const savedGroups = Array.isArray(saved.customerGroups) ? [...saved.customerGroups] : [];
        for (const def of DEFAULT_SNAPSHOT_MAPPINGS.customerGroups) {
            if (!savedGroups.some(m => String(m.scanned || '').trim().toLowerCase() === String(def.scanned).trim().toLowerCase())) {
                savedGroups.push(def);
            }
        }

        return {
            roles: savedRoles,
            customerGroups: savedGroups,
            businessUnits,
            updatedAt: saved.updatedAt || ''
        };
    } catch {
        return JSON.parse(JSON.stringify(DEFAULT_SNAPSHOT_MAPPINGS));
    }
}

async function saveSnapshotMappings(mappings, actor = 'System') {
    const existing = await getSnapshotMappings();
    const hasCustomBUs = Array.isArray(mappings?.businessUnits) || Boolean(existing?.hasCustomBusinessUnits);
    const payload = {
        id: 'config',
        roles: Array.isArray(mappings?.roles) ? mappings.roles.filter(m => m && String(m.scanned || '').trim() && String(m.target || '').trim()).map(m => ({
            scanned: String(m.scanned).trim(),
            target: String(m.target).trim()
        })) : (Array.isArray(existing?.roles) ? existing.roles : []),
        customerGroups: Array.isArray(mappings?.customerGroups) ? mappings.customerGroups.filter(m => m && String(m.scanned || '').trim() && String(m.target || '').trim()).map(m => ({
            scanned: String(m.scanned).trim(),
            target: String(m.target).trim()
        })) : (Array.isArray(existing?.customerGroups) ? existing.customerGroups : []),
        businessUnits: Array.isArray(mappings?.businessUnits) ? mappings.businessUnits.filter(m => m && String(m.scanned || '').trim() && String(m.target || '').trim()).map(m => ({
            scanned: String(m.scanned).trim(),
            target: String(m.target).trim()
        })) : (Array.isArray(existing?.businessUnits) ? existing.businessUnits : []),
        hasCustomBusinessUnits: hasCustomBUs,
        updatedAt: new Date().toISOString()
    };
    await put('snapshotMappings', 'config', payload, actor, '更新快照字段映射', '更新角色、客户群及BU映射配置');
    return payload;
}

// ── 存取 ──
const ITEM = 'drp_item';
const AUDIT = 'drp_audit';
const PIN_SETTING = 'department_reward_penalty:force_edit_pin';
const EVIDENCE_CATEGORY = 'department-reward-penalty-evidence';
const SAFETY_CATEGORY = 'department-reward-penalty-backups';
const httpError = (message, status) => Object.assign(new Error(message), { status });
const ensureReady = async () => {};

// 记录标识 = 类别:条目标识（过长时换成摘要）；排序键记下首次写入的先后，等价于主线版按插入顺序读取
const itemKey = (kind, id) => { const key = `${kind}:${id}`; return key.length <= 96 ? key : `${kind}:#${crypto.createHash('sha1').update(String(id)).digest('hex')}`; };
let sequence = 0;
const nextSortKey = () => `${String(Date.now()).padStart(15, '0')}${String(sequence++ % 100000).padStart(5, '0')}`;

async function itemRecords() {
    return (await listRecords(ITEM, { withPayload: true, limit: 50_000, maxRows: 50_000 })).reverse();
}
async function itemRows() {
    return (await itemRecords()).map((record) => ({ kind: record.group, id: String(record.payload?.id ?? record.name), payload_json: JSON.stringify(record.payload) }));
}
async function itemRow(kind, id) {
    const record = await getRecord(ITEM, itemKey(kind, id));
    return record ? { payload_json: JSON.stringify(record.payload) } : null;
}
async function writeItem(kind, id, payload, actor) {
    const existing = await getRecord(ITEM, itemKey(kind, id));
    await putRecord(ITEM, { id: itemKey(kind, id), group: kind, name: String(id), sortKey: existing?.sortKey || nextSortKey(), payload, updatedBy: actor, createdAt: existing ? Date.parse(existing.createdAt) : 0 });
}

// 同一进程内的写操作排队（主线版用数据库事务；这里没有跨语句事务，靠排队和「先写后删」保证不丢数据）
let queue = Promise.resolve();
function withLock(work) {
    const current = queue.catch(() => {}).then(work);
    queue = current;
    return current;
}

async function item(kind, id) {
    if (!KINDS.has(kind)) throw httpError('无效的数据类型', 400);
    const record = await getRecord(ITEM, itemKey(kind, id));
    if (record) return record.payload;
    return kind === 'rules' ? defaultRules.find((rule) => rule.id === id) || null : null;
}

async function audit(actor, action, kind, id, before, after, reason) {
    const createdAt = new Date().toISOString();
    await putRecord(AUDIT, {
        id: crypto.randomUUID(), group: String(kind).slice(0, 64), name: String(action), sortKey: `${createdAt}${String(sequence++ % 100000).padStart(5, '0')}`, updatedBy: actor,
        payload: { actor, action, kind, item_id: String(id), before: before || null, after: after || null, reason: reason || '', created_at: createdAt },
    });
}

async function listAudit({ page = 1, pageSize = 20 } = {}) {
    const size = Math.max(1, Math.min(200, Number.parseInt(pageSize, 10) || 20));
    const total = (await listRecords(AUDIT, { limit: 50_000, maxRows: 50_000 })).length;
    const totalPages = Math.max(1, Math.ceil(total / size));
    const currentPage = Math.max(1, Math.min(totalPages, Number.parseInt(page, 10) || 1));
    const records = await listRecords(AUDIT, { withPayload: true, limit: size, offset: (currentPage - 1) * size, maxRows: 50_000 });
    return { rows: records.map((record) => ({ id: record.id, ...record.payload })), total, page: currentPage, pageSize: size, totalPages };
}

async function getAuditPayloadBytes() {
    return (await listRecords(AUDIT, { limit: 50_000, maxRows: 50_000 })).reduce((sum, record) => sum + record.payloadBytes, 0);
}

// 强制修改口令：没设置过时是默认口令 0000（与主线版一致），设置后只存加盐摘要
const hasCustomForceEditPin = async () => Boolean((await getSetting(PIN_SETTING, null))?.hash);
async function verifyForceEditPin(pin) {
    const stored = await getSetting(PIN_SETTING, null);
    const salt = stored?.salt || 'department-reward-penalty-default-pin-v1';
    const expected = stored?.hash ? Buffer.from(stored.hash, 'hex') : crypto.scryptSync('0000', salt, 32);
    const actual = crypto.scryptSync(String(pin ?? ''), salt, 32);
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}
function changeForceEditPin(currentPin, newPin, actor) {
    return withLock(async () => {
        if (!await verifyForceEditPin(currentPin)) throw httpError('当前修改口令不正确', 403);
        const salt = crypto.randomBytes(16).toString('hex');
        await saveSetting(PIN_SETTING, { salt, hash: crypto.scryptSync(newPin, salt, 32).toString('hex'), updatedAt: new Date().toISOString() });
        await audit(actor, '修改强制编辑口令', 'security', 'force-edit-pin', null, { changed: true }, '');
    });
}

function putMany(changes, actor, action = '保存', reason = '') {
    return withLock(async () => {
        if (changes.some(({ kind }) => !KINDS.has(kind))) throw new Error('无效的数据类型');
        const results = [];
        for (const { kind, id, payload } of changes) {
            const before = await item(kind, id);
            const after = { ...payload, id };
            await writeItem(kind, id, after, actor);
            await audit(actor, action, kind, id, before, after, reason);
            results.push(after);
        }
        return results;
    });
}

function putPublishedWithPin(id, payload, pin, actor, reason) {
    return withLock(async () => {
        if (!await verifyForceEditPin(pin)) throw httpError('修改口令不正确', 403);
        const before = await item('records', id);
        if (!before || before.status !== 'published') throw httpError('只能强制修改已发布记录', 409);
        const after = { ...payload, id };
        await writeItem('records', id, after, actor);
        await audit(actor, '强制修改已发布违规', 'records', id, before, after, reason);
        return after;
    });
}

function correctHistoricalRoleWithPin(id, { expectedRole, expectedRuleId, expectedRuleSnapshot, role, pin, actor, reason }) {
    return withLock(async () => {
        if (!await verifyForceEditPin(pin)) throw httpError('修改口令不正确', 403);
        const before = await item('records', id);
        if (!before || before.status !== 'published' || before.createdBy !== 'legacy-import' || !before.migrationWarning) throw httpError('仅可更正待复核的已发布迁移记录', 409);
        if (before.ruleId !== expectedRuleId || before.personSnapshot?.role !== expectedRole || JSON.stringify(before.ruleSnapshot) !== JSON.stringify(expectedRuleSnapshot)) throw httpError('记录已变更，请刷新后重试', 409);
        const now = new Date().toISOString();
        const after = {
            ...before,
            personSnapshot: { ...before.personSnapshot, role, roles: [role] },
            migrationWarning: false,
            historicalRoleCorrection: { from: expectedRole, to: role, correctedAt: now, correctedBy: actor, reason },
            forcedEditAt: now, forcedEditBy: actor, forcedEditReason: reason,
        };
        await writeItem('records', id, after, actor);
        await audit(actor, '更正迁移记录历史角色', 'records', id, before, after, reason);
        return after;
    });
}

function remove(kind, id, actor, action = '删除', reason = '') {
    return withLock(async () => {
        if (!KINDS.has(kind)) throw new Error('无效的数据类型');
        const before = await item(kind, id);
        if (!before) throw httpError('记录不存在', 404);
        await deleteRecord(ITEM, itemKey(kind, id));
        await audit(actor, action, kind, id, before, null, reason);
        return { success: true, id };
    });
}

// ── 证据附件（存应用库的文件表）──
const evidenceKey = (filename) => `${EVIDENCE_CATEGORY}/${filename}`;
const EVIDENCE_MIME = {
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8', '.zip': 'application/zip', '.rar': 'application/vnd.rar',
    '.7z': 'application/x-7z-compressed', '.tar': 'application/x-tar', '.gz': 'application/gzip', '.eml': 'message/rfc822', '.msg': 'application/vnd.ms-outlook',
};
async function saveEvidenceFile(filename, buffer, { originalName = '', owner = '' } = {}) {
    if (!BACKUP_EVIDENCE_FILENAME.test(filename)) throw httpError('文件名无效', 400);
    await saveBlobAsset({ key: evidenceKey(filename), category: EVIDENCE_CATEGORY, filename: String(originalName || filename).slice(0, 200), mimeType: EVIDENCE_MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream', buffer, meta: { owner } });
}
async function readEvidenceFile(filename) {
    if (!BACKUP_EVIDENCE_FILENAME.test(String(filename || ''))) throw httpError('文件名无效', 400);
    const asset = await getBlobAsset(evidenceKey(filename));
    if (!asset) throw httpError('文件不存在', 404);
    return { buffer: asset.buffer, mimeType: EVIDENCE_MIME[path.extname(filename).toLowerCase()] || '' };
}
const evidenceFilenames = async () => (await listBlobAssets(EVIDENCE_CATEGORY)).map((row) => path.basename(row.asset_key)).filter((name) => BACKUP_EVIDENCE_FILENAME.test(name));

// ── 备份与恢复 ──
async function exportBackupPackage({ includeEvidence = true, actor = 'system' } = {}) {
    const state = await list();
    const saved = Object.fromEntries([...KINDS].map((kind) => [kind, new Map()]));
    for (const record of await itemRecords()) if (KINDS.has(record.group)) saved[record.group].set(String(record.payload?.id ?? record.name), record.payload);
    // 当前有效的条目（含自带的默认项）加上库里保存过的全部条目（含已归档的）
    const collections = {};
    for (const kind of CORE_BACKUP_KINDS) {
        const merged = new Map();
        for (const entry of state[kind] || []) if (entry && (entry.id || entry.value)) merged.set(entry.id || entry.value, entry);
        for (const [id, entry] of saved[kind]) merged.set(id, entry);
        collections[kind] = [...merged.values()];
    }

    const exportedAt = new Date().toISOString();
    const evidenceContents = [];
    let evidenceBytes = 0;
    if (includeEvidence) {
        for (const filename of await evidenceFilenames()) {
            const asset = await getBlobAsset(evidenceKey(filename));
            if (!asset) continue;
            if (asset.buffer.length > MAX_BACKUP_EVIDENCE_FILE_BYTES || evidenceBytes + asset.buffer.length > MAX_BACKUP_EVIDENCE_BYTES) invalidBackup('证据文件超出备份包安全限制，无法生成可恢复的完整备份');
            evidenceContents.push([filename, asset.buffer]);
            evidenceBytes += asset.buffer.length;
        }
    }
    if (evidenceContents.length + 3 > MAX_BACKUP_ENTRIES) invalidBackup('证据文件数量超出备份包安全限制，无法生成可恢复的完整备份');
    const manifest = {
        type: 'department-reward-penalty-backup', version: 1, exportedAt, exportedBy: actor, tenantId: 'default',
        stats: { ...Object.fromEntries([...CORE_BACKUP_KINDS].map((kind) => [kind, collections[kind].length])), evidenceFiles: evidenceContents.length },
    };
    const dataJson = JSON.stringify(collections, null, 2);
    if (Buffer.byteLength(dataJson, 'utf8') > MAX_BACKUP_JSON_BYTES) invalidBackup('业务数据超出备份包安全限制，无法生成可恢复的完整备份');
    const zip = new (await jszip())();
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    zip.file('data.json', dataJson);
    for (const [filename, content] of evidenceContents) zip.file(`evidence/${filename}`, content);
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    await audit(actor, '导出备份数据包', 'backup', 'export', null, { stats: manifest.stats, includeEvidence }, '导出数据备份包');
    return { zipBuffer, jsonString: JSON.stringify({ manifest, data: collections }, null, 2), manifest, filename: `department-reward-penalty-backup-${exportedAt.slice(0, 10)}.zip` };
}

async function restoreBackupPackage(bufferOrObject, { mode = 'merge', pin, actor = 'admin' } = {}) {
    if (!['merge', 'replace'].includes(mode)) throw httpError('无效的恢复模式', 400);
    const { data: incoming, evidenceMap } = await parseBackupContent(bufferOrObject);
    validateIncomingData(incoming, { mode });
    return withLock(async () => {
        validateIncomingData(incoming, { mode, currentState: await list() });
        if (mode === 'replace') {
            if (!await verifyForceEditPin(pin)) throw httpError('操作口令不正确，覆盖恢复已被拦截', 403);
            // 覆盖前先留一份完整备份；只保留最近 3 份
            const safety = await exportBackupPackage({ includeEvidence: true, actor: 'system-safety-backup' });
            await saveBlobAsset({ key: `${SAFETY_CATEGORY}/safety-before-replace-${Date.now()}.zip`, category: SAFETY_CATEGORY, filename: safety.filename, mimeType: 'application/zip', buffer: safety.zipBuffer, meta: { actor } });
            for (const old of (await listBlobAssets(SAFETY_CATEGORY)).slice(3)) await deleteBlobAsset(old.asset_key);
        }
        const counts = { personnel: 0, rules: 0, records: 0, roles: 0, deductions: 0, deductionCategories: 0, customerGroups: 0, businessUnits: 0, evidence: 0 };
        // 先把证据和条目都写进去，覆盖模式最后才删掉备份包里没有的：中途失败时库里只会多、不会少
        for (const [filename, buffer] of evidenceMap) await saveEvidenceFile(filename, buffer, { owner: actor });
        counts.evidence = evidenceMap.size;
        const keep = new Set();
        for (const kind of CORE_BACKUP_KINDS) {
            for (const entry of incoming[kind] || []) {
                const id = String(entry.id || entry.value || crypto.randomUUID());
                await writeItem(kind, id, { ...entry, id }, actor);
                keep.add(itemKey(kind, id));
                counts[kind] += 1;
            }
        }
        if (mode === 'replace') {
            for (const record of await itemRecords()) if (CORE_BACKUP_KINDS.has(record.group) && !keep.has(record.id)) await deleteRecord(ITEM, record.id);
            for (const filename of await evidenceFilenames()) if (!evidenceMap.has(filename)) await deleteBlobAsset(evidenceKey(filename));
        }
        await audit(actor, mode === 'replace' ? '覆盖恢复数据包' : '增量恢复数据包', 'backup', mode, null, { mode, counts }, `执行数据包${mode === 'replace' ? '覆盖' : '增量'}恢复`);
        return { success: true, mode, counts };
    });
}

export {
    DEFAULT_ROLES, DEFAULT_DEDUCTIONS, DEFAULT_DEDUCTION_CATEGORIES, deductionCategory,
    DEFAULT_SNAPSHOT_MAPPINGS, getSnapshotMappings, saveSnapshotMappings,
    ensureReady, list, listAudit, getAuditPayloadBytes, item, put, putMany, putPublishedWithPin, correctHistoricalRoleWithPin, remove, audit,
    hasCustomForceEditPin, verifyForceEditPin, changeForceEditPin,
    exportBackupPackage, inspectBackupPackage, restoreBackupPackage, parseBackupContent,
    saveEvidenceFile, readEvidenceFile,
};
