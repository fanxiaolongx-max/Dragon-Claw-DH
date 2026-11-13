// 奖励申报与评优（内置工具 reward-program 的后端）：奖励规则、申报单、审批流转、公示异议、证据附件。
// 金额分配与校验规则（下面到「存取」之前）原样沿用主线版 models/reward-program-core.js。
// 存取：规则和申报单存统一记录表；处理记录、公示异议随申报单一起保存；证据附件存应用库的文件表。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STATIC_DIR } from '../../config.js';
import { listRecords, getRecord, putRecord, deleteRecord } from '../record-store.js';
import { saveBlobAsset, getBlobAsset, deleteBlobAsset } from '../blob-service.js';

const CATEGORIES = ['bounty', 'position', 'operation', 'excellence'];
const money = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_00;
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const label = (value, max = 120) => String(value ?? '').trim().slice(0, max);

function allocate(total, rows, scope) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 200) fail(`${scope}不能为空或超过 200 项`);
    let sum = 0;
    const calculated = rows.map((row, index) => {
        const mode = row.mode === 'percent' ? 'percent' : 'amount';
        const amountMinor = mode === 'amount' ? Number(row.amountMinor) : Math.round(total * Number(row.percentBp) / 10000);
        if (mode === 'percent' && (!Number.isInteger(Number(row.percentBp)) || Number(row.percentBp) < 0 || Number(row.percentBp) > 10000)) fail(`${scope}第 ${index + 1} 项百分比无效`);
        if (!money(amountMinor)) fail(`${scope}第 ${index + 1} 项金额无效`);
        sum += amountMinor;
        return { ...row, mode, amountMinor };
    });
    if (sum !== total) fail(`${scope}分配合计与总额不一致（差额 ${(total - sum) / 100} EGP）`);
    return calculated;
}

function normalizeApplication(input, rules) {
    const category = label(input.category, 30);
    if (!CATEGORIES.includes(category)) fail('奖励类别无效');
    const rule = rules.find(item => item.id === input.ruleId && item.category === category && !item.archived);
    if (!rule) fail('请选择有效的奖励规则');
    const title = label(input.title);
    if (!title) fail('请输入申请标题');
    const totalAmountMinor = Number(input.totalAmountMinor);
    if (!money(totalAmountMinor) || totalAmountMinor === 0) fail('总金额必须大于 0');
    const value = {
        category, ruleId: rule.id, ruleSnapshot: { ...rule }, title,
        period: label(input.period, 40), projectName: label(input.projectName),
        summary: label(input.summary, 3000), evidence: label(input.evidence, 2000),
        totalAmountMinor, currency: input.currency === 'CNY' ? 'CNY' : 'EGP',
        attachments: Array.isArray(input.attachments) ? input.attachments.filter(u => typeof u === 'string' && u.length <= 500).slice(0, 20) : [],
        teams: [], recipients: []
    };
    if (!value.summary) fail('请填写申报依据或事迹说明');
    if (category === 'bounty') {
        if (!value.projectName) fail('悬赏奖必须填写项目名称');
        value.teams = allocate(totalAmountMinor, input.teams, '团队').map((team, index) => {
            const name = label(team.name);
            if (!name) fail(`团队第 ${index + 1} 项缺少名称`);
            const members = allocate(team.amountMinor, team.members, `${name}成员`).map((member, memberIndex) => {
                const memberName = label(member.name);
                if (!memberName) fail(`${name}第 ${memberIndex + 1} 位成员缺少姓名`);
                return { name: memberName, staffId: label(member.staffId, 80), mode: member.mode, percentBp: member.mode === 'percent' ? Number(member.percentBp) : null, amountMinor: member.amountMinor };
            });
            return { name, mode: team.mode, percentBp: team.mode === 'percent' ? Number(team.percentBp) : null, amountMinor: team.amountMinor, members };
        });
        const staffIds = value.teams.flatMap(team => team.members.map(member => member.staffId).filter(Boolean));
        if (new Set(staffIds).size !== staffIds.length) fail('同一工号不能在悬赏奖中重复分配');
    } else {
        const recipients = Array.isArray(input.recipients) ? input.recipients : [];
        if (!recipients.length || recipients.length > 200) fail('获奖对象不能为空或超过 200 项');
        value.recipients = allocate(totalAmountMinor, recipients, '获奖对象').map((person, index) => {
            const name = label(person.name);
            if (!name) fail(`获奖对象第 ${index + 1} 项缺少名称`);
            return { name, staffId: label(person.staffId, 80), team: label(person.team), mode: person.mode, percentBp: person.mode === 'percent' ? Number(person.percentBp) : null, amountMinor: person.amountMinor };
        });
        const staffIds = value.recipients.map(person => person.staffId).filter(Boolean);
        if (new Set(staffIds).size !== staffIds.length) fail('同一工号不能重复分配');
        if (category === 'position') {
            if (!money(rule.unitAmountMinor) || rule.unitAmountMinor === 0 || !label(rule.positionName)) fail('岗位激励规则需先配置固定岗位和单人金额');
            if (value.recipients.some(person => person.amountMinor !== rule.unitAmountMinor)) fail('岗位激励每位人员金额必须等于规则中的固定单人金额');
        }
        if (category === 'operation' && rule.unitAmountMinor != null && value.recipients.some(person => person.amountMinor !== rule.unitAmountMinor)) fail('操作激励每位人员金额必须等于规则中的单人金额');
    }
    return value;
}

// ── 存取 ──
const RULE = 'reward_rule';
const APPLICATION = 'reward_application';
const httpError = (message, status) => Object.assign(new Error(message), { status });
const defaults = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(STATIC_DIR, 'builtin-tools', 'reward-program', 'default-rules.json'), 'utf8')); } catch { return []; }
})();

// 同一进程内的写操作排队；跨实例靠版本号（revision）兜底，撞上时后写的一方收到 409
let queue = Promise.resolve();
function withLock(work) {
    const current = queue.catch(() => {}).then(work);
    queue = current;
    return current;
}

async function rules() {
    const overrides = new Map((await listRecords(RULE, { withPayload: true, limit: 500 })).map((r) => [r.id, r.payload]));
    const all = [...defaults.map((item) => overrides.get(item.id) || item), ...[...overrides.values()].filter((item) => !defaults.some((seed) => seed.id === item.id))];
    return all.filter((item) => !item.deleted);
}
async function saveRule(rule, actor = '') {
    await putRecord(RULE, { id: rule.id, name: rule.name || '', payload: rule, updatedBy: actor });
    return rule;
}
async function deleteRule(id, actor = '') {
    // 自带的规则不能真的删掉（否则下次又回来），记一个「已删除」的覆盖
    if (defaults.some((seed) => seed.id === id)) await putRecord(RULE, { id, payload: { id, deleted: true }, updatedBy: actor });
    else await deleteRecord(RULE, id);
    return { ok: true, id };
}

// 申报单记录：payload = { data（表单内容）, events, objections }；状态放 period 列、申报人放 group 列，列表时不必读正文
const unpack = (record) => record && ({
    ...record.payload.data, id: record.id, applicant: record.group, status: record.period, revision: Number(record.summary?.revision) || 1,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
});
async function loadRecord(id) {
    return /^[0-9a-f-]{36}$/.test(String(id || '')) ? getRecord(APPLICATION, String(id)) : null;
}
async function storeRecord(record, { status, revision, data, events, objections, actor }) {
    await putRecord(APPLICATION, {
        id: record.id, group: record.group, name: String(data.title || ''), period: status, sortKey: new Date().toISOString(),
        summary: { revision, category: data.category }, payload: { data, events, objections }, updatedBy: actor,
        createdAt: record.createdAt ? Date.parse(record.createdAt) : 0,
    });
    return unpack(await getRecord(APPLICATION, record.id));
}
const application = async (id) => unpack(await loadRecord(id));

async function listApplications(user, admin) {
    const records = await listRecords(APPLICATION, { withPayload: true, limit: 1000 });
    return records.filter((r) => admin || r.group === user || ['publicity', 'published'].includes(r.period)).map(unpack).map((item) => (admin || item.applicant === user ? item : {
        // 别人的记录只给公示需要的内容：不带金额和工号
        id: item.id, category: item.category, ruleId: item.ruleId, title: item.title, period: item.period, projectName: item.projectName,
        status: item.status, createdAt: item.createdAt, updatedAt: item.updatedAt, summary: item.summary, evidence: item.evidence, attachments: item.attachments,
        teams: item.teams?.map((team) => ({ name: team.name, members: team.members?.map((member) => ({ name: member.name })) })),
        recipients: item.recipients?.map((person) => ({ name: person.name, team: person.team })),
    }));
}

const eventOf = (actor, action, note = '') => ({ actor, action, note, createdAt: new Date().toISOString() });
const events = async (id) => (await loadRecord(id))?.payload.events || [];
async function objections(id, actor, admin) {
    const list = (await loadRecord(id))?.payload.objections || [];
    return admin ? list : list.filter((item) => item.actor === actor);
}

function insert(payload, actor) {
    return withLock(async () => storeRecord({ id: crypto.randomUUID(), group: actor }, { status: 'draft', revision: 1, data: payload, events: [eventOf(actor, 'create')], objections: [], actor }));
}

function update(id, expectedRevision, actor, next, action, note = '') {
    return withLock(async () => {
        const record = await loadRecord(id);
        if (!record) throw httpError('申请不存在', 404);
        const old = unpack(record);
        if (old.revision !== expectedRevision) throw httpError('记录已被其他人更新，请刷新后重试', 409);
        const pending = record.payload.objections.filter((item) => item.status === 'open').length;
        if (old.status === 'publicity' && next.status === 'completed' && pending) throw httpError(`还有 ${pending} 条公示异议未处理，不能结束公示`, 409);
        // next.payload 可能是整条旧记录（审批、撤销时）：去掉由记录列维护的字段，只留表单内容
        const { id: _id, applicant: _applicant, status: _status, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...data } = next.payload;
        return storeRecord(record, {
            status: next.status, revision: old.revision + 1, data: { ...data, category: next.category, ruleId: next.ruleId },
            events: [...record.payload.events, eventOf(actor, action, note)], objections: record.payload.objections, actor,
        });
    });
}

function remove(id) {
    return withLock(async () => {
        const old = await application(id);
        if (!old) throw httpError('申请不存在', 404);
        if (!['draft', 'archived', 'completed'].includes(old.status)) throw httpError('只能删除草稿或已归档记录', 409);
        await deleteRecord(APPLICATION, id);
        return { id, deleted: true, status: old.status };
    });
}

function clearArchived(category) {
    return withLock(async () => {
        const items = (await listRecords(APPLICATION, { withPayload: true, limit: 1000 })).map(unpack)
            .filter((item) => ['archived', 'completed'].includes(item.status) && (!category || category === 'all' || item.category === category));
        for (const item of items) await deleteRecord(APPLICATION, item.id);
        return { count: items.length, items };
    });
}

function addObjection(applicationId, actor, note) {
    return withLock(async () => {
        const record = await loadRecord(applicationId);
        if (!record || record.period !== 'publicity') throw httpError('当前不在公示期', 409);
        const objection = { id: crypto.randomUUID(), actor, note, status: 'open', resolution: '', resolvedBy: null, createdAt: new Date().toISOString(), resolvedAt: null };
        const old = unpack(record);
        await storeRecord(record, {
            status: old.status, revision: old.revision, data: record.payload.data, actor,
            events: [...record.payload.events, eventOf(actor, 'objection', '已提交公示异议')], objections: [...record.payload.objections, objection],
        });
        return { id: objection.id, status: 'open', createdAt: objection.createdAt };
    });
}

function resolveObjection(applicationId, objectionId, actor, resolution) {
    return withLock(async () => {
        const record = await loadRecord(applicationId);
        const item = record?.payload.objections.find((o) => o.id === objectionId);
        if (!item) throw httpError('异议不存在', 404);
        if (item.status !== 'open') throw httpError('异议已处理', 409);
        const resolvedAt = new Date().toISOString();
        const old = unpack(record);
        await storeRecord(record, {
            status: old.status, revision: old.revision, data: record.payload.data, actor,
            events: [...record.payload.events, eventOf(actor, 'resolve_objection', resolution)],
            objections: record.payload.objections.map((o) => (o.id === objectionId ? { ...o, status: 'resolved', resolution, resolvedBy: actor, resolvedAt } : o)),
        });
        return { id: objectionId, status: 'resolved', resolution, resolvedBy: actor, resolvedAt };
    });
}

// ── 证据附件 ──
const EVIDENCE_NAME_RE = /^[a-f0-9-]{36}\.(?:pdf|png|jpg|jpeg|txt|zip|rar|7z|tar|gz|eml|msg)$/i;
const EVIDENCE_MIME = {
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8', '.zip': 'application/zip',
    '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed', '.tar': 'application/x-tar', '.gz': 'application/gzip', '.eml': 'message/rfc822', '.msg': 'application/vnd.ms-outlook',
};
const MIME_EXT = new Map([
    ['application/pdf', '.pdf'], ['image/png', '.png'], ['image/jpeg', '.jpg'], ['text/plain', '.txt'], ['application/zip', '.zip'], ['application/x-zip-compressed', '.zip'],
    ['application/vnd.rar', '.rar'], ['application/x-rar-compressed', '.rar'], ['application/x-7z-compressed', '.7z'], ['application/x-tar', '.tar'],
    ['application/gzip', '.gz'], ['application/x-gzip', '.gz'], ['message/rfc822', '.eml'], ['application/vnd.ms-outlook', '.msg'], ['application/x-msg', '.msg'],
]);
const evidenceKey = (prefix, filename) => `${prefix}-evidence/${filename}`;

/** 保存一份证据附件，返回页面里引用它的地址。prefix 区分工具（reward-program / department-reward-penalty） */
async function saveEvidence({ prefix, originalName, mimeType, buffer, owner }) {
    if (!buffer?.length) throw httpError('请选择证据文件', 400);
    if (buffer.length > 15 * 1024 * 1024) throw httpError('证据文件不能超过 15 MB', 413);
    const originalExt = path.extname(String(originalName || '')).toLowerCase();
    let extension = MIME_EXT.get(String(mimeType || '').toLowerCase());
    if (!extension && EVIDENCE_MIME[originalExt]) extension = originalExt === '.jpeg' ? '.jpg' : originalExt;
    if (!extension) throw httpError('仅支持 PDF、PNG、JPG、TXT、压缩包(ZIP/RAR/7Z/TAR/GZ) 及邮件(EML/MSG) 格式', 400);
    const filename = crypto.randomUUID() + extension;
    await saveBlobAsset({ key: evidenceKey(prefix, filename), category: `${prefix}-evidence`, filename: String(originalName || filename).slice(0, 200), mimeType: EVIDENCE_MIME[extension], buffer, meta: { owner } });
    return { path: `/api/${prefix}/evidence/${filename}`, filename: originalName, size: buffer.length };
}
async function readEvidence(prefix, filename) {
    if (!EVIDENCE_NAME_RE.test(String(filename || ''))) throw httpError('文件名无效', 400);
    const asset = await getBlobAsset(evidenceKey(prefix, filename));
    if (!asset) throw httpError('文件不存在', 404);
    return { buffer: asset.buffer, mimeType: EVIDENCE_MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream' };
}
async function deleteEvidenceFiles(prefix, attachments) {
    for (const item of Array.isArray(attachments) ? attachments : []) {
        const filename = path.basename(String(item || ''));
        if (EVIDENCE_NAME_RE.test(filename)) await deleteBlobAsset(evidenceKey(prefix, filename)).catch(() => {});
    }
}

export {
    CATEGORIES, money, label, allocate, normalizeApplication,
    rules, saveRule, deleteRule, application, listApplications, events, objections, insert, update, remove, clearArchived, addObjection, resolveObjection,
    saveEvidence, readEvidence, deleteEvidenceFiles,
};
