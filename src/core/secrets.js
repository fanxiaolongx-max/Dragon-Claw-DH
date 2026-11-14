// 落库密钥加密。背景：基座允许其他应用只读本应用 schema，明文 API Key 入库等于对全平台公开。
// 口令优先取环境变量 DH_SECRET_KEY；未配置时退化为按 APP_UUID 派生——这只能避免明文直接出现在查询结果里，
// 不构成真正的保密（UUID 对其他应用可见）。需要保密时请让平台注入 DH_SECRET_KEY，或用环境变量 AI_API_KEY 直接提供密钥。
import crypto from 'node:crypto';
import { config } from '../config.js';

const PREFIX = 'enc:v1:';
const key = crypto.scryptSync(config.secretKey || `dh-app:${config.appUuid || 'local'}`, 'dragon-claw-dh', 32);

export const secretsAreStrong = () => Boolean(config.secretKey);

export function encryptSecret(plain) {
    const text = String(plain || '');
    if (!text || text.startsWith(PREFIX)) return text;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decryptSecret(stored) {
    const text = String(stored || '');
    if (!text.startsWith(PREFIX)) return text; // 兼容历史明文
    try {
        const raw = Buffer.from(text.slice(PREFIX.length), 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
        return ''; // 口令变更后无法解密：当作未配置，由管理员重新填写
    }
}

// ── 按归属隔离的加密（保险箱密钥）：每个归属一把由主口令派生的子密钥，并把 scope 作为附加校验数据，
//    密文挪到别的账号或别的名称下无法解开。主口令的强弱同上（见 secretsAreStrong）。
const SCOPED_PREFIX = 'enc:s1:';
const scopedKey = (owner) => Buffer.from(crypto.hkdfSync('sha256', key, Buffer.from(String(owner), 'utf8'), Buffer.from('dh-vault-v1', 'utf8'), 32));

export function sealScoped(owner, scope, plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', scopedKey(owner), iv);
    cipher.setAAD(Buffer.from(`${owner}\n${scope}`, 'utf8'));
    const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return SCOPED_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/** 解不开（口令变更、密文被挪动或篡改）返回 null */
export function openScoped(owner, scope, stored) {
    const text = String(stored || '');
    if (!text.startsWith(SCOPED_PREFIX)) return null;
    try {
        const raw = Buffer.from(text.slice(SCOPED_PREFIX.length), 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', scopedKey(owner), raw.subarray(0, 12));
        decipher.setAAD(Buffer.from(`${owner}\n${scope}`, 'utf8'));
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
        return null;
    }
}
