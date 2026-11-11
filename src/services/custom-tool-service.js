// 自定义 HTML 工具：单个自包含 HTML 页面，存应用库，在沙箱里运行。
// 可见性：管理员发布的对所有人可见（public），普通用户发布的只有自己可见（private）。
import crypto from 'node:crypto';
import { BusinessError, NotFoundError } from '../core/errors.js';
import { selectTable, upsertRow, deleteRows, sqlVal, parseJsonCol } from '../dao/scoped.js';

const MAX_HTML = 4 * 1024 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;
const clip = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);

function slugify(value) {
    const slug = String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return SLUG_RE.test(slug) ? slug : '';
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
    if (input.archiveBase64) throw new BusinessError('Web 版暂只支持单个 HTML 文件，请把样式和脚本内联到一个 .html 文件里再导入');
    const html = String(input.htmlContent ?? input.html ?? '');
    if (!html.trim()) throw new BusinessError('缺少 HTML 内容');
    if (html.length > MAX_HTML) throw new BusinessError('HTML 文件不能超过 4 MB');
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
