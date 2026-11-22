// 身份加固：
// 1) 服务端核验前端注入的 x-dh-user：配置了核验地址（底座 /api/dh/user/current）时，
//    带上本次请求的 Cookie 去问一次底座「这个会话是谁」，结果按 Cookie 缓存几分钟；
// 2) 开发者免登录：管理员生成一次性展示的令牌，打开 /dev-login?token=… 后拿到 8 小时的管理员会话，
//    用于测试和收集基座环境信息。令牌只存哈希，可随时吊销；环境变量 DH_DEV_TOKEN 可固定一个令牌。
import crypto from 'node:crypto';
import { config } from '../config.js';
import { kvGet, kvSet, isMemoryMode } from '../dao/scoped.js';
import { pushLog } from './log-ring.js';
import { parseCookies } from './identity.js';
import { isSameUserId } from './access.js';

const DEV_KEY = 'dh_dev_login';
const VERIFY_KEY = 'dh_identity_verify';
export const DEV_COOKIE = 'dh_dev_admin';
export const DEV_USER = 'dev-admin';
export const DEV_SESSION_MS = 8 * 3600_000;
const SETTINGS_TTL_MS = 30_000;
const VERIFY_TTL_MS = 5 * 60_000;
const VERIFY_FAIL_TTL_MS = 30_000;
const VERIFY_TIMEOUT_MS = 3000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEqual = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

let settings = { at: 0, dev: null, verifyUrl: '' };
const verifyState = { lastOkAt: 0, lastError: '', lastErrorAt: 0 };
const verifyCache = new Map();

async function loadSettings(force = false) {
    if (!force && settings.at && Date.now() - settings.at < SETTINGS_TTL_MS) return settings;
    let dev = null;
    let verifyUrl = '';
    try {
        const raw = await kvGet(DEV_KEY, null);
        if (raw && raw.hash && Number(raw.expiresAt) > Date.now()) dev = { ...raw, source: 'generated' };
        const v = await kvGet(VERIFY_KEY, null);
        verifyUrl = String(v?.url || '').trim();
    } catch {
        // 应用库暂不可用：沿用上一次读到的配置，不缓存
        return { ...settings, at: settings.at };
    }
    settings = { at: Date.now(), dev, verifyUrl };
    return settings;
}

function envDevToken() {
    return config.devToken ? { hash: sha256(config.devToken), expiresAt: 0, source: 'env' } : null;
}

async function devSecrets() {
    const s = await loadSettings();
    return [envDevToken(), s.dev].filter(Boolean);
}

// ── 开发者免登录 ──

export async function generateDevToken(createdBy, days = 7) {
    const token = `dhdev_${crypto.randomBytes(24).toString('base64url')}`;
    const ttlDays = Math.min(30, Math.max(1, Number(days) || 7));
    const record = { hash: sha256(token), expiresAt: Date.now() + ttlDays * 86400_000, createdBy, createdAt: Date.now() };
    await kvSet(DEV_KEY, record);
    await loadSettings(true);
    pushLog({ level: 'WARN', category: 'AUTH', message: `开发者免登录令牌已生成（${ttlDays} 天有效）`, userId: createdBy });
    return { token, expiresAt: record.expiresAt };
}

export async function revokeDevToken(by) {
    await kvSet(DEV_KEY, null);
    await loadSettings(true);
    pushLog({ level: 'WARN', category: 'AUTH', message: '开发者免登录令牌已吊销', userId: by });
}

/** 校验 URL 里的令牌；通过时返回要写入 Cookie 的会话值。 */
export async function redeemDevToken(token) {
    const t = String(token || '').trim();
    if (!t || t.length > 200) return null;
    const hash = sha256(t);
    const match = (await devSecrets()).find((s) => safeEqual(s.hash, hash));
    if (!match) return null;
    const exp = Date.now() + DEV_SESSION_MS;
    const nonce = crypto.randomBytes(9).toString('base64url');
    const sig = crypto.createHmac('sha256', match.hash).update(`${exp}.${nonce}`).digest('base64url');
    return { value: `${exp}.${nonce}.${sig}`, exp, source: match.source };
}

async function devSessionValid(cookieValue) {
    const parts = String(cookieValue || '').split('.');
    if (parts.length !== 3) return false;
    const [expStr, nonce, sig] = parts;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    for (const s of await devSecrets()) {
        const expect = crypto.createHmac('sha256', s.hash).update(`${expStr}.${nonce}`).digest('base64url');
        if (safeEqual(expect, sig)) return true;
    }
    return false;
}

// ── 服务端核验 x-dh-user ──

async function lookupPlatformUser(url, cookieHeader) {
    const key = sha256(cookieHeader);
    const hit = verifyCache.get(key);
    if (hit && Date.now() < hit.until) return hit.result;
    let result;
    try {
        const r = await fetch(url, {
            headers: { cookie: cookieHeader, accept: 'application/json' },
            redirect: 'manual',
            signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        });
        const body = await r.json().catch(() => null);
        if (body && body.code === 0 && body.data && body.data.uid) {
            result = { status: 'ok', uid: String(body.data.uid).trim(), name: String(body.data.cn || body.data.name || '').trim() };
        } else if (r.status === 401 || r.status === 403 || (body && Number(body.code) === 401) || r.ok) {
            result = { status: 'anonymous' };
        } else {
            throw new Error(`HTTP ${r.status}`);
        }
        verifyState.lastOkAt = Date.now();
    } catch (err) {
        verifyState.lastError = String(err?.message || err).slice(0, 200);
        verifyState.lastErrorAt = Date.now();
        result = { status: 'error' };
    }
    verifyCache.set(key, { result, until: Date.now() + (result.status === 'error' ? VERIFY_FAIL_TTL_MS : VERIFY_TTL_MS) });
    if (verifyCache.size > 2000) verifyCache.delete(verifyCache.keys().next().value);
    return result;
}

export async function setVerifyUrl(url, by) {
    const clean = String(url || '').trim();
    if (clean && !/^https?:\/\/[^\s]+$/i.test(clean)) throw new Error('核验地址必须是 http(s) 地址');
    await kvSet(VERIFY_KEY, { url: clean, updatedBy: by, updatedAt: Date.now() });
    verifyCache.clear();
    await loadSettings(true);
    pushLog({ level: 'WARN', category: 'AUTH', message: clean ? `身份核验地址已设为 ${clean}` : '身份核验已关闭', userId: by });
}

/** 试一次核验地址，返回底座认出的账号（管理员配置前自测用）。 */
export async function probeVerifyUrl(url, cookieHeader) {
    verifyCache.clear();
    return lookupPlatformUser(url, String(cookieHeader || ''));
}

export async function guardStatus() {
    const s = await loadSettings(true);
    return {
        devLogin: {
            envToken: Boolean(config.devToken),
            generated: s.dev ? { expiresAt: s.dev.expiresAt, createdBy: s.dev.createdBy, createdAt: s.dev.createdAt } : null,
            sessionHours: DEV_SESSION_MS / 3600_000,
        },
        verify: { url: s.verifyUrl || config.userVerifyUrl || '', fromEnv: !s.verifyUrl && Boolean(config.userVerifyUrl), ...verifyState },
    };
}

/**
 * 在 parseIdentity 的结果上做加固（就地修改 identity）：
 *  - 带有效开发者会话：直接成为开发者管理员；
 *  - 身份来自前端 x-dh-user 且配置了核验地址：用底座的结论覆盖，核验不可用时不给管理员权限。
 */
export async function hardenIdentity(req, identity) {
    if (isMemoryMode()) return identity;
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[DEV_COOKIE] && await devSessionValid(cookies[DEV_COOKIE]).catch(() => false)) {
        Object.assign(identity, {
            id: DEV_USER, username: DEV_USER, displayName: '开发者（免登录）', identified: true,
            source: 'dev-login', devAdmin: true, unverified: false,
        });
        return identity;
    }
    if (identity.source !== 'platform:dh/user/current') return identity;
    const url = (await loadSettings()).verifyUrl || config.userVerifyUrl;
    if (!url) return identity;
    const result = await lookupPlatformUser(url, String(req.headers.cookie || ''));
    if (result.status === 'ok') {
        identity.verified = true;
        if (!isSameUserId(result.uid, identity.username)) {
            pushLog({ level: 'WARN', category: 'AUTH', message: `x-dh-user=${identity.username} 与底座会话 ${result.uid} 不一致，按底座身份处理`, userId: result.uid });
            Object.assign(identity, {
                id: result.uid.slice(0, 120), username: result.uid.slice(0, 120),
                displayName: (result.name || result.uid).slice(0, 120), source: 'platform:verified', identityConflict: true,
            });
        }
    } else if (result.status === 'anonymous') {
        pushLog({ level: 'WARN', category: 'AUTH', message: `x-dh-user=${identity.username} 没有对应的底座会话，按未登录处理` });
        Object.assign(identity, { identified: false, source: 'platform:rejected', identityConflict: true });
    } else {
        // 核验地址暂时不通：照常识别，但不授予管理员权限，避免伪造的头借机提权
        identity.unverified = true;
    }
    return identity;
}

