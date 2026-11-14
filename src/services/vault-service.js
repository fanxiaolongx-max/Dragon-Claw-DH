// 保险箱 · API 密钥与 Secret（与主线版 password-vault 的密钥部分同接口、同校验）。
// 归属只认登录账号：每人只能读写自己的条目，管理员也没有代管入口。
// 存在统一记录表 biz_records（kind=vault_secret）：group_key=归属，name=密钥名；列表只读摘要，密文只在正文里。
// 基座 Web 版没有内置浏览器，所以没有「网站登录凭据」；也没有平台登录密码可复核，查看明文改为限次 + 记审计。
import crypto from 'node:crypto';
import { BusinessError } from '../core/errors.js';
import { sealScoped, openScoped, secretsAreStrong } from '../core/secrets.js';
import { listRecords, getRecord, putRecord, deleteRecord, countRecords } from './record-store.js';

const KIND = 'vault_secret';
export const LIMITS = { secretName: 128, secretValue: 65536, secretsPerOwner: 1000 };

const fail = (message, status = 400) => new BusinessError(message, status);

/** 归属键：账号统一小写；超过列宽时取摘要 */
export function ownerKey(username) {
    const name = String(username || '').trim().toLowerCase();
    if (!name) throw fail('无法确定账号', 401);
    return name.length <= 64 ? name : crypto.createHash('sha256').update(name).digest('hex');
}

const publicSecret = (r) => ({
    id: r.id,
    name: r.name,
    category: r.summary.category || 'api_key',
    label: r.summary.label || '',
    createdAt: Date.parse(r.createdAt) || 0,
    updatedAt: Date.parse(r.updatedAt) || 0,
    lastUsedAt: r.summary.lastUsedAt || null,
    useCount: r.summary.useCount || 0,
});

function checkFields({ name, value, label, category }, { partial = false } = {}) {
    if (name !== undefined || !partial) {
        if (typeof name !== 'string' || !name.trim() || name.length > LIMITS.secretName) throw fail('请填写密钥名称（最长 128 字符）');
        if (!/^[a-zA-Z0-9_.-]+$/.test(name.trim())) throw fail('密钥名称只能包含字母、数字、下划线、中划线或点');
    }
    if (value !== undefined || !partial) {
        if (typeof value !== 'string' || !value || value.length > LIMITS.secretValue) throw fail('请填写密钥内容（最长 64KB）');
    }
    if (label !== undefined && (typeof label !== 'string' || label.length > 500)) throw fail('备注过长');
    if (category !== undefined && (typeof category !== 'string' || category.length > 32)) throw fail('分类名称过长');
}

async function owned(owner, id) {
    const record = await getRecord(KIND, String(id || ''));
    if (!record || record.group !== owner) throw fail('密钥条目不存在', 404);
    return record;
}

const write = (owner, username, { id, name, cipher, category, label, lastUsedAt = null, useCount = 0, createdAt = 0 }) => putRecord(KIND, {
    id, group: owner, name, sortKey: name.toLowerCase().slice(0, 64), updatedBy: username, createdAt,
    summary: { category, label, lastUsedAt, useCount },
    payload: { cipher },
});

export const vaultFeatures = () => ({
    logins: false,
    reauth: false,
    strong: secretsAreStrong(),
    secretNotes: [
        '只有你自己能看到和使用，管理员也看不到别人的密钥。',
        secretsAreStrong()
            ? '密钥加密后保存在本应用的数据库里，列表和 AI 上下文里都不会出现明文。'
            : '密钥加密后保存在本应用的数据库里；平台尚未配置独立加密口令（DH_SECRET_KEY），保密强度有限，请勿存放高敏感密钥。',
        '查看明文需要再确认一次，并会记入审计日志。',
    ],
});

export async function listSecrets(username) {
    const owner = ownerKey(username);
    const rows = await listRecords(KIND, { group: owner, limit: LIMITS.secretsPerOwner, maxRows: LIMITS.secretsPerOwner });
    return { secrets: rows.map(publicSecret).sort((a, b) => a.name.localeCompare(b.name)) };
}

export async function saveSecret(username, { name, value, category = 'api_key', label = '' } = {}) {
    const owner = ownerKey(username);
    checkFields({ name, value, label, category });
    const sName = name.trim();
    const rows = await listRecords(KIND, { group: owner, limit: LIMITS.secretsPerOwner, maxRows: LIMITS.secretsPerOwner });
    const existing = rows.find((r) => r.name === sName);
    if (!existing && (await countRecords(KIND, { group: owner })) >= LIMITS.secretsPerOwner) throw fail(`每个账号最多保存 ${LIMITS.secretsPerOwner} 个 API 密钥`, 400);
    const record = await write(owner, username, {
        id: existing?.id || crypto.randomUUID(), name: sName, cipher: sealScoped(owner, sName, value),
        category: String(category || 'api_key').trim() || 'api_key', label: String(label || '').trim(),
        lastUsedAt: existing?.summary.lastUsedAt || null, useCount: existing?.summary.useCount || 0, createdAt: Date.parse(existing?.createdAt) || 0,
    });
    return { secret: publicSecret(record), created: !existing };
}

export async function updateSecret(username, id, changes = {}) {
    const owner = ownerKey(username);
    const record = await owned(owner, id);
    checkFields(changes, { partial: true });
    const name = changes.name === undefined ? record.name : changes.name.trim();
    let cipher = record.payload?.cipher;
    if (changes.value !== undefined || name !== record.name) {
        const plain = changes.value !== undefined ? changes.value : openScoped(owner, record.name, cipher);
        if (plain == null) throw fail('这条密钥已无法解开（加密口令变更过），请重新填写密钥内容', 409);
        cipher = sealScoped(owner, name, plain);
    }
    if (name !== record.name) {
        const rows = await listRecords(KIND, { group: owner, limit: LIMITS.secretsPerOwner, maxRows: LIMITS.secretsPerOwner });
        if (rows.some((r) => r.name === name && r.id !== record.id)) throw fail('已有同名密钥', 409);
    }
    return publicSecret(await write(owner, username, {
        id: record.id, name, cipher,
        category: changes.category === undefined ? record.summary.category || 'api_key' : String(changes.category).trim() || 'api_key',
        label: changes.label === undefined ? record.summary.label || '' : changes.label.trim(),
        lastUsedAt: record.summary.lastUsedAt || null, useCount: record.summary.useCount || 0, createdAt: Date.parse(record.createdAt) || 0,
    }));
}

export async function removeSecret(username, id) {
    const owner = ownerKey(username);
    const record = await owned(owner, id);
    await deleteRecord(KIND, record.id);
    return true;
}

export async function revealSecret(username, id) {
    const owner = ownerKey(username);
    const record = await owned(owner, id);
    const value = openScoped(owner, record.name, record.payload?.cipher);
    if (value == null) throw fail('这条密钥已无法解开（加密口令变更过），请重新保存', 409);
    return { name: record.name, value };
}

/** 服务端按名称取用（供后续需要凭据的平台能力调用）；记录使用次数。不存在返回 null。 */
export async function getSecret(username, name) {
    if (!username || !name) return null;
    const owner = ownerKey(username);
    const rows = await listRecords(KIND, { group: owner, withPayload: true, limit: LIMITS.secretsPerOwner, maxRows: LIMITS.secretsPerOwner });
    const record = rows.find((r) => r.name === String(name).trim());
    if (!record) return null;
    const value = openScoped(owner, record.name, record.payload?.cipher);
    if (value == null) return null;
    const now = Date.now();
    const useCount = (record.summary.useCount || 0) + 1;
    await write(owner, username, { id: record.id, name: record.name, cipher: record.payload.cipher, category: record.summary.category || 'api_key', label: record.summary.label || '', lastUsedAt: now, useCount, createdAt: Date.parse(record.createdAt) || 0 });
    return { id: record.id, name: record.name, category: record.summary.category || 'api_key', label: record.summary.label || '', value, lastUsedAt: now, useCount };
}
