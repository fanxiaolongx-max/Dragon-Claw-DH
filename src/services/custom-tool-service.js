// 自定义 HTML 工具：自包含的 HTML 页面（单文件，或导入时由压缩包合成），存应用库，在沙箱里运行。
// 可见性：管理员发布的对所有人可见（public），普通用户发布的只有自己可见（private）。
import crypto from 'node:crypto';
import { BusinessError, NotFoundError } from '../core/errors.js';
import { selectTable, upsertRow, deleteRows, sqlVal, parseJsonCol } from '../dao/scoped.js';
import { optionalDep } from '../core/optional.js';

const MAX_HTML = 4 * 1024 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;
const clip = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);

function slugify(value) {
    const slug = String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return SLUG_RE.test(slug) ? slug : '';
}

// ── 压缩包形式的多文件工具：解包后把样式、脚本、图片内联进入口页，合成一个自包含的 HTML ──
// 沙箱禁止一切网络请求，所以工具必须自包含；内联后与单文件工具走同一套存储和运行方式。
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', json: 'application/json' };
const MAX_ARCHIVE = 8 * 1024 * 1024;
const isExternal = (ref) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref);

export async function htmlFromArchive(archiveBase64) {
    const buffer = Buffer.from(String(archiveBase64 || ''), 'base64');
    if (!buffer.length) throw new BusinessError('压缩包是空的');
    if (buffer.length > MAX_ARCHIVE) throw new BusinessError('压缩包不能超过 8 MB');
    const JSZip = (await optionalDep('jszip', '压缩包形式的工具导入')).default;
    let zip;
    try { zip = await JSZip.loadAsync(buffer); } catch { throw new BusinessError('不是有效的 ZIP 压缩包'); }
    const files = Object.values(zip.files).filter((f) => !f.dir && !/(^|\/)(__MACOSX|\.DS_Store)/.test(f.name));
    if (files.length > 300) throw new BusinessError('压缩包里的文件太多（上限 300 个）');
    const htmls = files.filter((f) => /\.html?$/i.test(f.name)).sort((a, b) => a.name.split('/').length - b.name.split('/').length || a.name.length - b.name.length);
    const entry = htmls.find((f) => /(^|\/)index\.html?$/i.test(f.name)) || htmls[0];
    if (!entry) throw new BusinessError('压缩包里没有找到 HTML 页面（需要一个 index.html）');
    const byName = new Map(files.map((f) => [f.name, f]));
    const resolve = (fromFile, ref) => {
        const clean = String(ref || '').trim().split(/[?#]/)[0];
        if (!clean || isExternal(clean)) return null;
        let target;
        try { target = decodeURIComponent(new URL(clean, `http://z/${fromFile}`).pathname.slice(1)); } catch { return null; }
        return byName.get(target) || null;
    };
    const dataUri = async (file) => {
        const ext = file.name.split('.').pop().toLowerCase();
        return `data:${MIME[ext] || 'application/octet-stream'};base64,${await file.async('base64')}`;
    };
    // 样式表里的 url(...) 也要内联（相对样式表自身的位置）
    const inlineCss = async (css, fromFile) => {
        const refs = [...new Set([...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((m) => m[2]))];
        for (const ref of refs) {
            const file = resolve(fromFile, ref);
            if (file) css = css.split(ref).join(await dataUri(file));
        }
        return css;
    };
    const replaceAsync = async (text, re, fn) => {
        const parts = [];
        let last = 0;
        for (const m of text.matchAll(re)) {
            parts.push(text.slice(last, m.index), await fn(m));
            last = m.index + m[0].length;
        }
        return parts.join('') + text.slice(last);
    };
    let html = await entry.async('string');
    html = await replaceAsync(html, /<link\b[^>]*\brel=["']?stylesheet["']?[^>]*>/gi, async (m) => {
        const file = resolve(entry.name, /\bhref=["']([^"']+)["']/i.exec(m[0])?.[1]);
        return file ? `<style>\n${await inlineCss(await file.async('string'), file.name)}\n</style>` : m[0];
    });
    html = await replaceAsync(html, /<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, async (m) => {
        const file = resolve(entry.name, m[2]);
        if (!file) return m[0];
        const code = (await file.async('string')).replace(/<\/script/gi, '<\\/script');
        return `<script${`${m[1]}${m[3]}`.replace(/\s+$/, '')}>\n${code}\n</script>`;
    });
    html = await replaceAsync(html, /(<(?:img|source|audio|video|link)\b[^>]*?\b(?:src|href|poster)=)(["'])([^"']+)\2/gi, async (m) => {
        const file = resolve(entry.name, m[3]);
        return file && !/\.(?:html?|css|js)$/i.test(file.name) ? `${m[1]}${m[2]}${await dataUri(file)}${m[2]}` : m[0];
    });
    html = await replaceAsync(html, /<style\b[^>]*>([\s\S]*?)<\/style>/gi, async (m) => m[0].replace(m[1], await inlineCss(m[1], entry.name)));
    return html;
}

const toItem = (row) => ({
    slug: row.slug,
    name: row.name,
    nameEn: row.name_en || '',
    description: row.description || '',
    descriptionEn: row.description_en || '',
    icon: row.icon || '🧩',
    tags: parseJsonCol(row.tags_json, []) || [],
    href: `/custom-tools/${row.slug}/`,
    builtIn: false,
    owner: row.owner_id,
    visibility: row.visibility,
    shared: false,
    createdAt: row.created_at ? new Date(Number(row.created_at)).toISOString() : '',
    updatedAt: row.updated_at ? new Date(Number(row.updated_at)).toISOString() : '',
});

const LIST_COLS = ['slug', 'owner_id', 'visibility', 'name', 'name_en', 'description', 'description_en', 'icon', 'tags_json', 'created_at', 'updated_at'];
const canSee = (row, identity) => row.visibility === 'public' || identity?.isAdmin || row.owner_id === identity?.username;

export async function listCustomTools(identity) {
    const rows = await selectTable('custom_tools', {
        columns: LIST_COLS,
        orderBySql: '`updated_at` DESC',
        limit: 500,
        memSort: (a, b) => (b.updated_at || 0) - (a.updated_at || 0),
    });
    return rows.filter((r) => canSee(r, identity)).map(toItem);
}

async function getRow(slug, columns = ['*']) {
    const key = String(slug || '').toLowerCase();
    if (!SLUG_RE.test(key)) return null;
    const rows = await selectTable('custom_tools', { columns, whereSql: `\`slug\` = ${sqlVal(key)}`, limit: 1, memFilter: (r) => r.slug === key });
    return rows[0] || null;
}

export async function getCustomTool(slug, identity) {
    const row = await getRow(slug);
    if (!row || !canSee(row, identity)) return null;
    return { ...toItem(row), html: row.html || '' };
}

export async function saveCustomTool(input = {}, identity) {
    if (!identity?.identified && !identity?.isAdmin) throw new BusinessError('需要先登录数字人门户才能发布工具', 403);
    const html = input.archiveBase64 ? await htmlFromArchive(input.archiveBase64) : String(input.htmlContent ?? input.html ?? '');
    if (!html.trim()) throw new BusinessError('缺少 HTML 内容');
    if (html.length > MAX_HTML) throw new BusinessError(input.archiveBase64 ? '压缩包内联后超过 4 MB，请减少或压缩图片等资源' : 'HTML 文件不能超过 4 MB');
    if (!/<[a-z!][\s\S]*>/i.test(html)) throw new BusinessError('内容不是有效的 HTML');
    const name = clip(input.name, 80) || clip(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1], 80) || '未命名工具';

    let slug = slugify(input.slug) || slugify(input.nameEn) || slugify(name);
    const existing = slug ? await getRow(slug, LIST_COLS) : null;
    const mine = existing && (identity.isAdmin || existing.owner_id === identity.username);
    if (existing && !(mine && (input.overwrite === true || slugify(input.slug) === slug))) slug = '';
    if (!slug) slug = `tool-${crypto.randomUUID().slice(0, 8)}`;

    const now = Date.now();
    const tags = (Array.isArray(input.tags) ? input.tags : String(input.tags || '').split(/[,，\n]/)).map((t) => clip(t, 20)).filter(Boolean).slice(0, 6);
    await upsertRow('custom_tools', {
        slug,
        owner_id: existing && mine ? existing.owner_id : identity.username,
        visibility: identity.isAdmin ? (input.visibility === 'private' ? 'private' : 'public') : 'private',
        name,
        name_en: clip(input.nameEn, 80),
        description: clip(input.description, 400),
        description_en: clip(input.descriptionEn, 400),
        icon: clip(input.icon, 8) || '🧩',
        tags_json: JSON.stringify(tags),
        html,
        created_at: existing && mine ? existing.created_at : now,
        updated_at: now,
    }, ['slug'], ['visibility', 'name', 'name_en', 'description', 'description_en', 'icon', 'tags_json', 'html', 'updated_at']);
    return toItem(await getRow(slug, LIST_COLS));
}

export async function deleteCustomTool(slug, identity) {
    const row = await getRow(slug, LIST_COLS);
    if (!row || !canSee(row, identity)) throw new NotFoundError('工具不存在');
    if (!identity.isAdmin && row.owner_id !== identity.username) throw new BusinessError('只能删除自己发布的工具', 403);
    await deleteRows('custom_tools', { whereSql: `\`slug\` = ${sqlVal(row.slug)}`, memFilter: (r) => r.slug === row.slug });
    return { success: true };
}
