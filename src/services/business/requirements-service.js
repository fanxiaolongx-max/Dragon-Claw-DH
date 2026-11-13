// 需求广场：提需求、按流程流转、留处理记录。数据存统一记录表：
//   requirement              一条需求（正文、处理记录）；列表只读摘要
//   requirement_images       需求的配图（单独存，打开详情时不必把图片一起读出来）
//   requirement_upload(+_chunk)  大请求的分块暂存，15 分钟过期
// 与主线版的差别：处理人是管理员（主线版是超级管理员）；没有技能/工具的发布审核（基座 Web 版管理员直接保存技能）。
// 提交内容沿用主线版前端的加密信封；密钥对存应用库（私钥加密后保存），多实例共用同一把。
import crypto from 'node:crypto';
import { BusinessError } from '../../core/errors.js';
import { encryptSecret, decryptSecret } from '../../core/secrets.js';
import { getSetting, saveSetting } from '../system-service.js';
import { listRecords, getRecord, putRecord, deleteRecord } from '../record-store.js';

const KIND = 'requirement';
const IMAGES = 'requirement_images';
const UPLOAD = 'requirement_upload';
const CHUNK = 'requirement_upload_chunk';
export const STATUSES = ['提交', '需求接受', '需求实现中', '需求完成', '验收完成', '需求评价'];
const REJECTED = '已拒绝';
const fail = (message, status = 400, code) => Object.assign(new BusinessError(message, status), code ? { codeName: code } : {});
const pad = (id) => String(id).padStart(12, '0');
const canEdit = (req, identity) => Boolean(identity.isAdmin) || req.creator === identity.username;

// ── 图片 ──
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
function isImage(type, data) {
    if (type === 'image/png') return data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    if (type === 'image/jpeg') return data.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
    if (type === 'image/gif') return /^(GIF87a|GIF89a)$/.test(data.toString('ascii', 0, 6));
    return type === 'image/webp' && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
}
function parseImages(input, existing = []) {
    if (input === undefined) return existing;
    const invalid = () => fail('最多上传 6 张图片，每张不超过 4 MB（PNG、JPG、WebP、GIF）', 400, 'REQUIREMENT_IMAGE_INVALID');
    if (!Array.isArray(input) || input.length + existing.length > MAX_IMAGES) throw invalid();
    return [...existing, ...input.map((image) => {
        if (typeof image?.data !== 'string' || image.data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) throw invalid();
        const bytes = Buffer.from(image.data, 'base64');
        if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== image.data || !isImage(image.type, bytes)) throw invalid();
        return { name: String(image.name || 'image').slice(0, 120), type: image.type, data: image.data };
    })];
}

// ── 记录读写 ──
const listRow = (p) => {
    const description = String(p.description || '');
    return {
        id: p.id, title: p.title, description: description.slice(0, 300), ...(description.length > 300 ? { description_truncated: true } : {}),
        status: p.status, creator: p.creator, assignee: p.assignee || '', category: p.category, urgent: p.urgent ? 1 : 0,
        created_at: p.created_at, updated_at: p.updated_at,
        // 流程流转次数（首页效能看板用）
        transitions: Array.isArray(p.logs) ? p.logs.length : 0,
    };
};
async function load(id) {
    const key = Number(id);
    if (!Number.isSafeInteger(key) || key <= 0) return null;
    return (await getRecord(KIND, pad(key)))?.payload || null;
}
async function store(req) {
    await putRecord(KIND, {
        id: pad(req.id), name: req.title, group: req.status, sortKey: pad(req.id), summary: listRow(req), payload: req,
        updatedBy: req.updated_by || req.creator, createdAt: Date.parse(req.created_at) || 0,
    });
}
function addLog(req, oldStatus, newStatus, remark, operator) {
    req.logs.push({ id: req.logs.length + 1, req_id: req.id, old_status: oldStatus, new_status: newStatus, remark, operator, created_at: new Date().toISOString() });
}

export async function listRequirements() {
    return (await listRecords(KIND, { limit: 1000 })).map((r) => r.summary).filter((s) => s && s.id);
}

export async function getRequirement(id, identity) {
    const req = await load(id);
    if (!req) throw fail('需求不存在', 404);
    return {
        ...req,
        images: (req.imageNames || []).map((name, index) => ({ name, href: `/api/requirements/${req.id}/images/${index}` })),
        imageNames: undefined,
        canEdit: canEdit(req, identity),
        canManage: Boolean(identity.isAdmin),
    };
}

export async function getRequirementImage(id, index) {
    const key = Number(id);
    if (!Number.isSafeInteger(key) || !/^\d+$/.test(String(index))) throw fail('图片不存在', 404);
    const image = (await getRecord(IMAGES, pad(key)))?.payload?.[Number(index)];
    if (!image) throw fail('图片不存在', 404);
    return { type: image.type, buffer: Buffer.from(image.data, 'base64') };
}

export async function createRequirement(body, identity) {
    const { title, description = '', category, urgent, images } = body || {};
    if (typeof title !== 'string' || !title.trim()) throw fail('标题为必填项');
    if (typeof category !== 'string' || !category.trim()) throw fail('页面分类为必选项');
    if (typeof description !== 'string') throw fail('需求描述无效');
    const attachments = parseImages(images);
    // 编号取现有最大值加一；两人同时提交撞号时再往后挪
    let id = (await listRecords(KIND, { limit: 1 })).map((r) => Number(r.id))[0] || 0;
    do { id += 1; } while (await getRecord(KIND, pad(id)));
    const now = new Date().toISOString();
    const req = {
        id, title: title.slice(0, 200), description: description.slice(0, 20_000), category: category.slice(0, 80), status: STATUSES[0],
        creator: identity.username, assignee: '', urgent: urgent === true || urgent === 1 || urgent === '1' ? 1 : 0,
        imageNames: attachments.map((a) => a.name), logs: [], created_at: now, updated_at: now,
    };
    addLog(req, '', STATUSES[0], '创建需求', identity.username);
    if (attachments.length) await putRecord(IMAGES, { id: pad(id), payload: attachments, updatedBy: identity.username });
    await store(req);
    return { success: true, id, message: '需求提交成功' };
}

export async function updateRequirement(id, body, identity) {
    const req = await load(id);
    if (!req) throw fail('需求不存在', 404);
    if (!canEdit(req, identity)) throw fail('没有权限修改此需求', 403);
    const { title, description, category, status, assignee, remark, urgent, images } = body || {};
    const canManage = Boolean(identity.isAdmin);
    if (!canManage && ((status !== undefined && status !== req.status) || (assignee !== undefined && (assignee || '') !== (req.assignee || '')))) {
        throw fail('仅管理员可处理需求', 403);
    }
    for (const value of [title, description, category, status, assignee, remark]) {
        if (value !== undefined && typeof value !== 'string') throw fail('需求字段无效');
    }
    if ((title !== undefined && !title.trim()) || (category !== undefined && !category.trim())) throw fail('标题和页面分类为必填项');
    const nextStatus = canManage && status !== undefined ? status : req.status;
    if (nextStatus !== req.status) {
        if (req.status === REJECTED) throw fail('已拒绝的需求无法再流转');
        if (nextStatus !== REJECTED) {
            const from = STATUSES.indexOf(req.status);
            const to = STATUSES.indexOf(nextStatus);
            if (to < 0 || from < 0) throw fail('无效的状态');
            if (to < from) throw fail('流程不能回退');
            if (to > from + 1) throw fail('流程不能跳级');
        }
    }
    if (images !== undefined) {
        const existing = (await getRecord(IMAGES, pad(req.id)))?.payload || [];
        const merged = parseImages(images, existing);
        await putRecord(IMAGES, { id: pad(req.id), payload: merged, updatedBy: identity.username });
        req.imageNames = merged.map((a) => a.name);
    }
    const oldStatus = req.status;
    Object.assign(req, {
        title: (title ?? req.title).slice(0, 200), description: (description ?? req.description).slice(0, 20_000), category: (category ?? (req.category || '未分类')).slice(0, 80),
        status: nextStatus, assignee: canManage ? (assignee ?? req.assignee).slice(0, 80) : req.assignee,
        urgent: urgent === undefined ? req.urgent : (urgent === true || urgent === 1 || urgent === '1' ? 1 : 0),
        updated_at: new Date().toISOString(), updated_by: identity.username,
    });
    if (nextStatus !== oldStatus || remark?.trim()) addLog(req, oldStatus, nextStatus, (remark || '更新需求信息').slice(0, 2000), identity.username);
    await store(req);
    return { success: true, message: '更新成功' };
}

export async function deleteRequirement(id, identity) {
    const req = await load(id);
    if (!req) throw fail('需求不存在', 404);
    if (!canEdit(req, identity)) throw fail('没有权限删除此需求', 403);
    await deleteRecord(IMAGES, pad(req.id));
    await deleteRecord(KIND, pad(req.id));
    return { success: true, message: '删除成功' };
}

// ── 加密信封（与主线版前端 requirements-client.js 的协议一致）──
const VERSION = 1;
const MAX_PLAINTEXT_BYTES = Math.floor((50 * 1024 * 1024 - 4096) * 3 / 4) - 16;
const KEY_SETTING = 'requirements_transport_key';
let keyCache = null;

async function transportKeys(reload = false) {
    if (keyCache && !reload) return keyCache;
    let stored = await getSetting(KEY_SETTING, null);
    const pem = stored?.privateKey ? decryptSecret(stored.privateKey) : '';
    if (!stored?.keyId || !pem.includes('PRIVATE KEY')) {
        const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        stored = {
            keyId: crypto.randomBytes(16).toString('hex'),
            publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
            privateKey: encryptSecret(pair.privateKey.export({ type: 'pkcs8', format: 'pem' })),
        };
        await saveSetting(KEY_SETTING, stored);
        // 两个实例同时首次生成时，以库里最后留下的那把为准
        stored = (await getSetting(KEY_SETTING, null)) || stored;
    }
    keyCache = { keyId: stored.keyId, publicKey: stored.publicKey, privateKey: crypto.createPrivateKey(decryptSecret(stored.privateKey)) };
    return keyCache;
}
const contextFor = (identity) => JSON.stringify(['default', identity.username]);
const badEnvelope = (code = 'REQUIREMENT_TRANSPORT_INVALID', status = 400) => fail(code === 'REQUIREMENT_TRANSPORT_KEY_CHANGED' ? '服务器加密密钥已更新，请重新提交需求' : '需求加密数据校验失败，请重新提交', status, code);

export async function transportConfig(identity) {
    const { publicKey, keyId } = await transportKeys();
    return { version: VERSION, publicKey, keyId, context: contextFor(identity), maxPlaintextBytes: MAX_PLAINTEXT_BYTES };
}

function decode(value, min, max = min) {
    if (typeof value !== 'string' || value.length > 4 * Math.ceil(max / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw badEnvelope();
    const result = Buffer.from(value, 'base64');
    if (result.length < min || result.length > max || result.toString('base64') !== value) throw badEnvelope();
    return result;
}

/** 解开加密信封；没有信封的请求体原样返回（脚本、测试直接提交明文） */
export async function decryptBody(body, { identity, method, path }) {
    if (!body || !Object.hasOwn(body, 'encryptedPayload')) return body;
    if (Object.keys(body).length !== 1) throw badEnvelope();
    const envelope = body.encryptedPayload;
    if (!envelope || envelope.version !== VERSION) throw badEnvelope();
    let pair = await transportKeys();
    if (envelope.keyId !== pair.keyId) pair = await transportKeys(true); // 可能是另一个实例生成的密钥
    if (envelope.keyId !== pair.keyId) throw badEnvelope('REQUIREMENT_TRANSPORT_KEY_CHANGED', 409);
    const encryptedKey = decode(envelope.encryptedKey, 256);
    const iv = decode(envelope.iv, 12);
    const ciphertext = decode(envelope.ciphertext, 17, MAX_PLAINTEXT_BYTES + 16);
    try {
        const aesKey = crypto.privateDecrypt({ key: pair.privateKey, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, encryptedKey);
        if (aesKey.length !== 32) throw new Error('bad key');
        const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
        decipher.setAAD(Buffer.from(JSON.stringify([VERSION, method, path, contextFor(identity)])));
        decipher.setAuthTag(ciphertext.subarray(-16));
        const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
        const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.hasOwn(payload, 'encryptedPayload')) throw new Error('bad payload');
        return payload;
    } catch {
        throw badEnvelope();
    }
}

// ── 分块上传：请求超过约 800 KB 时前端把加密信封拆成多块 ──
const MAX_CHUNK_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const UPLOAD_TTL_MS = 15 * 60 * 1000;
const uploadFail = (message, status = 400) => fail(message, status, 'REQUIREMENT_UPLOAD_INVALID');

async function dropUpload(session) {
    for (let index = 0; index < session.totalChunks; index += 1) await deleteRecord(CHUNK, `${session.id}:${index}`);
    await deleteRecord(UPLOAD, session.id);
}
async function getUpload(uploadId, identity) {
    const session = /^[a-f0-9]{32}$/.test(String(uploadId)) ? (await getRecord(UPLOAD, uploadId))?.payload : null;
    if (!session || session.owner !== identity.username || session.expiresAt < Date.now()) throw uploadFail('需求上传会话不存在或已过期，请重新提交', 404);
    return session;
}
const saveUpload = (session) => putRecord(UPLOAD, { id: session.id, group: session.owner, sortKey: String(session.expiresAt), payload: session, updatedBy: session.owner });

export async function startUpload(body, identity) {
    const { method, requirementId, totalBytes, totalChunks, sha256, catalogUpdate } = body || {};
    if (catalogUpdate) throw uploadFail('基座 Web 版没有技能与工具的发布审核，管理员可以直接保存', 404);
    if (!['POST', 'PUT'].includes(method)
        || (method === 'PUT' && (!Number.isSafeInteger(requirementId) || requirementId <= 0))
        || (method === 'POST' && requirementId != null)
        || !Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_TOTAL_BYTES
        || !Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > 256 || totalChunks > totalBytes
        || totalBytes > totalChunks * MAX_CHUNK_BYTES || !/^[a-f0-9]{64}$/.test(sha256 || '')) {
        throw uploadFail('需求分块上传参数无效或总大小超过 50 MB');
    }
    if (method === 'PUT') {
        const req = await load(requirementId);
        if (!req) throw fail('需求不存在', 404);
        if (!canEdit(req, identity)) throw fail('没有权限修改此需求', 403);
    }
    // 顺手清掉本人过期的暂存，并限制同时进行的上传数
    const mine = await listRecords(UPLOAD, { group: identity.username, withPayload: true, limit: 50 });
    let active = 0;
    for (const record of mine) {
        if (record.payload?.expiresAt < Date.now()) await dropUpload(record.payload);
        else if (!record.payload?.result) active += 1;
    }
    if (active >= 3) throw uploadFail('未完成的需求上传过多，请稍后重试', 429);
    const session = {
        id: crypto.randomBytes(16).toString('hex'), owner: identity.username,
        target: { method, requirementId: requirementId ?? null, path: method === 'POST' ? '/api/requirements' : `/api/requirements/${requirementId}` },
        totalBytes, totalChunks, sha256, chunks: {}, receivedBytes: 0, expiresAt: Date.now() + UPLOAD_TTL_MS,
    };
    await saveUpload(session);
    return { uploadId: session.id };
}

export async function receiveUploadChunk(uploadId, body, identity) {
    const session = await getUpload(uploadId, identity);
    if (session.result || session.processing) throw uploadFail('需求上传已经完成或正在保存', 409);
    const { index, data } = body || {};
    if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks || typeof data !== 'string') throw uploadFail('分块参数无效');
    const size = Buffer.byteLength(data, 'utf8');
    if (!size || size > MAX_CHUNK_BYTES) throw uploadFail('分块大小无效');
    const hash = crypto.createHash('sha256').update(data, 'utf8').digest('hex');
    const known = session.chunks[index];
    if (known) {
        if (known.hash !== hash) throw uploadFail('重复分块内容不一致', 409);
    } else {
        if (session.receivedBytes + size > session.totalBytes) throw uploadFail('分块总大小不一致');
        await putRecord(CHUNK, { id: `${session.id}:${index}`, group: session.id, payload: data, updatedBy: identity.username });
        session.chunks[index] = { hash, size };
        session.receivedBytes += size;
        session.expiresAt = Date.now() + UPLOAD_TTL_MS;
        await saveUpload(session);
    }
    return { receivedChunks: Object.keys(session.chunks).length };
}

/** 收齐后校验整包并保存；结果留在暂存记录里，响应丢失后重试不会再写一次 */
export async function completeUpload(uploadId, identity) {
    const session = await getUpload(uploadId, identity);
    if (session.result) return session.result;
    if (Object.keys(session.chunks).length !== session.totalChunks) throw uploadFail('需求分块尚未全部接收', 409);
    if (session.processing && Date.now() - session.processing < 60_000) throw uploadFail('需求正在保存', 409);
    session.processing = Date.now();
    await saveUpload(session);
    let result;
    try {
        const parts = [];
        for (let index = 0; index < session.totalChunks; index += 1) parts.push(String((await getRecord(CHUNK, `${session.id}:${index}`))?.payload ?? ''));
        const serialized = parts.join('');
        if (Buffer.byteLength(serialized, 'utf8') !== session.totalBytes || crypto.createHash('sha256').update(serialized, 'utf8').digest('hex') !== session.sha256) throw uploadFail('需求整包校验失败');
        let envelope;
        try { envelope = JSON.parse(serialized); } catch { throw uploadFail('需求上传内容格式无效'); }
        if (!envelope || Object.keys(envelope).length !== 1 || !envelope.encryptedPayload) throw uploadFail('需求上传必须使用加密数据');
        const payload = await decryptBody(envelope, { identity, method: session.target.method, path: session.target.path });
        const body = session.target.method === 'POST' ? await createRequirement(payload, identity) : await updateRequirement(session.target.requirementId, payload, identity);
        result = { status: 200, body };
    } catch (error) {
        // 校验失败也记下来：同一个会话重试得到同样的结果
        result = { status: error instanceof BusinessError ? error.code : 500, body: { error: error instanceof BusinessError ? error.message : '需求保存失败', code: error.codeName } };
    }
    for (let index = 0; index < session.totalChunks; index += 1) await deleteRecord(CHUNK, `${session.id}:${index}`);
    await saveUpload({ ...session, processing: 0, chunks: {}, result, expiresAt: Date.now() + UPLOAD_TTL_MS });
    return result;
}

export async function cancelUpload(uploadId, identity) {
    const session = await getUpload(uploadId, identity);
    if (session.result) return; // 留着回执，供重试取结果
    await dropUpload(session);
}
