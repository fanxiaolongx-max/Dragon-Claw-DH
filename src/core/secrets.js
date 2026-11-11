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
