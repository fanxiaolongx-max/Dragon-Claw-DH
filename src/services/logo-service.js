// 平台标识（Logo）：管理员上传的 PNG 存应用库（多实例共享），没有上传时用包里自带的图。
import fs from 'node:fs';
import path from 'node:path';
import { STATIC_DIR } from '../config.js';
import { BusinessError } from '../core/errors.js';
import { saveBlobAsset, getBlobAsset, deleteBlobAsset } from './blob-service.js';

const LOGO_KEY = 'platform_logo';
const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_MS = 60_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const bundledFile = () => path.join(STATIC_DIR, 'assets', 'logo.png');

let cache = { at: 0, logo: undefined };

async function customLogo() {
    if (cache.logo !== undefined && Date.now() - cache.at < CACHE_MS) return cache.logo;
    let logo = null;
    try {
        const asset = await getBlobAsset(LOGO_KEY);
        if (asset?.buffer?.length) logo = { buffer: asset.buffer, updatedAt: Number(asset.meta?.updatedAt) || Date.now(), uploadedBy: asset.meta?.uploadedBy || '' };
    } catch { /* 应用库暂时不可用：用自带的图，不缓存 */ return null; }
    cache = { at: Date.now(), logo };
    return logo;
}

export async function logoStatus() {
    const custom = await customLogo();
    const bundled = fs.existsSync(bundledFile());
    const updatedAt = custom?.updatedAt || (bundled ? Math.floor(fs.statSync(bundledFile()).mtimeMs) : 0);
    return {
        ok: true,
        hasLogo: Boolean(custom) || bundled,
        custom: Boolean(custom),
        updatedAt,
        storageMode: custom ? 'runtime' : 'source',
        logoUrl: `assets/logo.png?t=${updatedAt}`,
        logoRawUrl: `assets/logo.png?t=${updatedAt}`,
        fileSizes: { logo: custom ? custom.buffer.length : (bundled ? fs.statSync(bundledFile()).size : 0) },
    };
}

/** 当前生效的 Logo 图片；没有任何图片时返回 null */
export async function logoImage() {
    const custom = await customLogo();
    if (custom) return { buffer: custom.buffer, custom: true };
    return fs.existsSync(bundledFile()) ? { buffer: fs.readFileSync(bundledFile()), custom: false } : null;
}

export async function saveLogo(buffer, uploadedBy = '') {
    if (!Buffer.isBuffer(buffer) || buffer.length < 64) throw new BusinessError('没有收到图片');
    if (buffer.length > MAX_BYTES) throw new BusinessError('图标不能超过 8 MB，请压缩后再上传');
    if (!buffer.subarray(0, 8).equals(PNG_MAGIC)) throw new BusinessError('图标必须是 PNG 图片');
    const updatedAt = Date.now();
    await saveBlobAsset({ key: LOGO_KEY, category: 'platform', filename: 'logo.png', mimeType: 'image/png', buffer, meta: { updatedAt, uploadedBy } });
    cache = { at: Date.now(), logo: { buffer, updatedAt, uploadedBy } };
    return { ...(await logoStatus()), assetCount: 1 };
}

export async function resetLogo() {
    await deleteBlobAsset(LOGO_KEY);
    cache = { at: Date.now(), logo: null };
    return logoStatus();
}
