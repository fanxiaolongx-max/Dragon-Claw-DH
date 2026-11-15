// 技能（SKILL.md）：内置技能随包发布（只读），自定义技能存应用库。格式与桌面版一致，草稿可互相导入。
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { ROOT_DIR } from '../config.js';
import { BusinessError, NotFoundError } from '../core/errors.js';
import { optionalDep } from '../core/optional.js';
import { selectTable, upsertRow, updateRows, deleteRows, sqlVal, kvGet, kvSet } from '../dao/scoped.js';

const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
const LIMITS = { name: 80, description: 400, body: 60_000, files: 100, fileBytes: 1024 * 1024, totalFileBytes: 3 * 1024 * 1024, readChars: 60_000 };
const BUILTIN_DIR = path.join(ROOT_DIR, 'src', 'agent', 'builtin-skills');

export function parseFrontMatter(raw) {
    const text = String(raw || '').replace(/^﻿/, '');
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    if (!match) return { fields: {}, body: text.trim() };
    const fields = {};
    const lines = match[1].split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const pair = lines[index].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (!pair) continue;
        const key = pair[1].toLowerCase().replace(/-/g, '_');
        let value = pair[2].trim();
        if (/^[>|][+-]?$/.test(value)) {
            const parts = [];
            while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1]) || !lines[index + 1].trim())) parts.push(lines[++index].trim());
            value = parts.join(value.startsWith('>') ? ' ' : '\n').trim();
        }
        fields[key] = value.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    }
    return { fields, body: text.slice(match[0].length).trim() };
}

function slugify(value) {
    const slug = String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41);
    return /^[a-z]/.test(slug) ? slug.replace(/-+$/g, '') : '';
}
const clip = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

export function normalizeSkillMarkdown(raw, { fallbackId = '', overrides = {} } = {}) {
    const { fields, body } = parseFrontMatter(raw);
    if (!body) throw new BusinessError('SKILL.md 缺少正文（技能的执行步骤）');
    if (body.length > LIMITS.body) throw new BusinessError(`SKILL.md 正文超过 ${LIMITS.body} 字`);
    const id = slugify(overrides.id) || slugify(fields.id) || (ID_RE.test(String(fields.name || '').toLowerCase()) ? String(fields.name).toLowerCase() : '')
        || slugify(fallbackId) || slugify(fields.name_en) || `skill-${Date.now().toString(36)}`;
    if (!ID_RE.test(id)) throw new BusinessError('技能标识只能使用小写英文、数字和连字符，并以字母开头');
    return {
        id,
        name: clip(overrides.name || fields.name || fields.name_en || id, LIMITS.name),
        nameEn: clip(overrides.nameEn || fields.name_en || fields.name || id, LIMITS.name),
        description: clip(overrides.description || fields.description || fields.description_en || '', LIMITS.description),
        descriptionEn: clip(overrides.descriptionEn || fields.description_en || fields.description || '', LIMITS.description),
        icon: clip(overrides.icon || fields.icon || '✨', 8) || '✨',
        workspace: false,
        body,
    };
}

// ── 技能包的附带文件（scripts / references / assets …）──
// 基座版没有本地磁盘和命令执行，所以整包存在应用库里：每个技能一份 skill_files:<id>，文本原样、其余按 base64；
// 模型用 read_skill 的 file 参数按需读取，导出时原样还原。文件跟随技能：覆盖时替换，回退时还原，删除时一起删。
const TEXT_FILE_RE = /\.(md|markdown|txt|py|js|mjs|cjs|ts|json|ya?ml|toml|ini|sh|bash|ps1|bat|csv|tsv|html?|css|xml|sql|r|rb|go|java|kt|swift|c|h|cpp|hpp|rs|php)$/i;
const filesKey = (id) => `skill_files:${id}`;
const backupFilesKey = (id, backupId) => `skill_backup_files:${id}:${backupId}`;
const COUNTS_KEY = 'skill_file_counts';

export function safeRelative(value) {
    const clean = String(value || '').replace(/\\/g, '/');
    if (!clean || clean.startsWith('/') || /^[a-zA-Z]:/.test(clean)) return '';
    const parts = clean.split('/');
    return parts.some((part) => !part || part === '.' || part === '..') ? '' : parts.join('/');
}
const isBinary = (file) => typeof file?.base64 === 'string';
const bytesOf = (file) => (isBinary(file) ? Buffer.from(file.base64, 'base64') : Buffer.from(String(file?.content ?? ''), 'utf8'));
function packageFile(relative, buffer) {
    if (TEXT_FILE_RE.test(relative) && !buffer.includes(0)) {
        const content = buffer.toString('utf8');
        if (Buffer.from(content, 'utf8').equals(buffer)) return { path: relative, content };
    }
    return { path: relative, base64: buffer.toString('base64') };
}
function cleanFiles(input) {
    const out = [];
    let total = 0;
    for (const file of Array.isArray(input) ? input : []) {
        const relative = safeRelative(file?.path);
        if (!relative || relative.toLowerCase() === 'skill.md' || out.some((f) => f.path === relative) || out.length >= LIMITS.files) continue;
        const size = bytesOf(file).length;
        if (size > LIMITS.fileBytes || total + size > LIMITS.totalFileBytes) continue;
        total += size;
        out.push(isBinary(file) ? { path: relative, base64: file.base64 } : { path: relative, content: String(file.content ?? '') });
    }
    return out;
}
/** 给界面和接口用：二进制文件不带内容，只给大小 */
export const publicFiles = (files) => (Array.isArray(files) ? files : []).map((file) => (isBinary(file)
    ? { path: file.path, content: '', binary: true, size: bytesOf(file).length }
    : { path: file.path, content: String(file.content ?? ''), size: Buffer.byteLength(String(file.content ?? '')) }));

async function dropKv(key) {
    await deleteRows('sys_kv_store', { whereSql: `\`kv_key\` = ${sqlVal(key)}`, memFilter: (r) => r.kv_key === key });
}
async function loadFiles(id) {
    const list = await kvGet(filesKey(id), []);
    return Array.isArray(list) ? list : [];
}
async function fileCounts() {
    const counts = await kvGet(COUNTS_KEY, {});
    return counts && typeof counts === 'object' && !Array.isArray(counts) ? counts : {};
}
async function storeFiles(id, files) {
    const list = cleanFiles(files);
    if (list.length) await kvSet(filesKey(id), list); else await dropKv(filesKey(id));
    const counts = await fileCounts();
    if (list.length) counts[id] = list.length; else delete counts[id];
    await kvSet(COUNTS_KEY, counts);
    return list;
}

let builtinCache = null;
function builtins() {
    if (builtinCache) return builtinCache;
    const list = [];
    try {
        for (const file of fs.readdirSync(BUILTIN_DIR).filter((f) => f.endsWith('.md')).sort()) {
            const skill = normalizeSkillMarkdown(fs.readFileSync(path.join(BUILTIN_DIR, file), 'utf8'), { fallbackId: file.replace(/\.md$/, '') });
            list.push({ ...skill, builtIn: true, customized: false, hidden: false, source: 'builtin', fileCount: 0, createdBy: '', createdAt: 0, updatedAt: 0, files: [] });
        }
    } catch { /* 目录缺失时只是没有内置技能 */ }
    builtinCache = list;
    return list;
}

const rowToSkill = (row) => ({
    id: row.id,
    name: row.name,
    nameEn: row.name_en || row.name,
    description: row.description,
    descriptionEn: row.description_en || row.description,
    icon: row.icon || '✨',
    workspace: false,
    builtIn: false,
    customized: false,
    hidden: false,
    source: row.source === 'builtin' ? 'chat' : (row.source || 'chat'),
    fileCount: 0,
    createdBy: row.created_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    body: row.body || '',
    files: [],
});

export async function listSkills({ withBody = false } = {}) {
    const rows = await selectTable('agent_skills', {
        columns: withBody ? ['*'] : ['id', 'name', 'name_en', 'description', 'description_en', 'icon', 'source', 'created_by', 'created_at', 'updated_at'],
        orderBySql: '`updated_at` DESC',
        limit: 500,
        memSort: (a, b) => (b.updated_at || 0) - (a.updated_at || 0),
    });
    const counts = rows.length ? await fileCounts().catch(() => ({})) : {};
    const custom = rows.map((row) => ({ ...rowToSkill(row), fileCount: Number(counts[row.id]) || 0 }));
    const taken = new Set(custom.map((s) => s.id));
    const all = [...builtins().filter((s) => !taken.has(s.id)), ...custom];
    return withBody ? all : all.map(({ body, files, ...rest }) => rest);
}

export async function getSkill(id) {
    const key = String(id || '').toLowerCase();
    const rows = await selectTable('agent_skills', { whereSql: `\`id\` = ${sqlVal(key)}`, limit: 1, memFilter: (r) => r.id === key });
    if (rows.length) {
        const files = await loadFiles(key);
        return { ...rowToSkill(rows[0]), files, fileCount: files.length };
    }
    return builtins().find((s) => s.id === key) || null;
}

// files：数组表示整包替换附带文件（导入、回退）；不传表示只改 SKILL.md，原有附带文件保留
export async function saveSkill(markdown, { createdBy = '', source = 'chat', overwrite = false, overrides = {}, fileName = '', backupSummary = '', files } = {}) {
    const skill = normalizeSkillMarkdown(markdown, { fallbackId: String(fileName || '').replace(/\.(md|markdown|txt)$/i, ''), overrides });
    if (builtins().some((s) => s.id === skill.id)) throw new BusinessError(`「${skill.id}」是内置技能的标识，请换一个标识`, 409);
    const existing = await getSkill(skill.id);
    if (existing && !overwrite) {
        throw Object.assign(new BusinessError(`技能「${skill.id}」已存在，确认要覆盖吗？`, 409), { codeName: 'SKILL_EXISTS' });
    }
    if (existing) await backupSkill(existing, { createdBy, summary: backupSummary || (source === 'import' ? '导入覆盖前的版本' : '修改前的版本') });
    const now = Date.now();
    await upsertRow('agent_skills', {
        id: skill.id,
        name: skill.name,
        name_en: skill.nameEn,
        description: skill.description,
        description_en: skill.descriptionEn,
        icon: skill.icon,
        body: skill.body,
        source,
        created_by: existing?.createdBy || createdBy,
        created_at: existing?.createdAt || now,
        updated_at: now,
    }, ['id'], ['name', 'name_en', 'description', 'description_en', 'icon', 'body', 'source', 'updated_at']);
    if (Array.isArray(files)) await storeFiles(skill.id, files);
    return getSkill(skill.id);
}

export function previewSkill(markdown, { fileName = '', files = [], skipped = 0 } = {}) {
    const skill = normalizeSkillMarkdown(markdown, { fallbackId: String(fileName || '').replace(/\.(md|markdown|txt)$/i, '') });
    return { ...skill, fileCount: files.length, skippedFiles: skipped, files: publicFiles(files) };
}

async function requireCustom(id) {
    const key = String(id || '').toLowerCase();
    if (builtins().some((s) => s.id === key)) throw new BusinessError('内置技能不能修改或删除', 403);
    const rows = await selectTable('agent_skills', { columns: ['id'], whereSql: `\`id\` = ${sqlVal(key)}`, limit: 1, memFilter: (r) => r.id === key });
    if (!rows.length) throw new NotFoundError('技能不存在');
    return key;
}

export async function renameSkill(id, name) {
    const key = await requireCustom(id);
    const next = clip(name, LIMITS.name);
    if (!next) throw new BusinessError('名称不能为空');
    await updateRows('agent_skills', { name: next, updated_at: Date.now() }, { whereSql: `\`id\` = ${sqlVal(key)}`, memFilter: (r) => r.id === key });
    return { success: true };
}

export async function removeSkill(id) {
    const key = await requireCustom(id);
    const current = await getSkill(key);
    if (current) await backupSkill(current, { summary: '删除前的版本' });
    await deleteRows('agent_skills', { whereSql: `\`id\` = ${sqlVal(key)}`, memFilter: (r) => r.id === key });
    await storeFiles(key, []);
    return { success: true };
}

// ── 版本历史：每次覆盖、回退前把旧版本存一份（每个技能最多 10 份，存键值表）──
const MAX_BACKUPS = 10;
const backupKey = (id) => `skill_backups:${id}`;

async function loadBackups(id) {
    const list = await kvGet(backupKey(String(id || '').toLowerCase()), []);
    return Array.isArray(list) ? list : [];
}

async function backupSkill(skill, { createdBy = '', summary = '' } = {}) {
    try {
        const list = await loadBackups(skill.id);
        const markdown = skillMarkdown(skill);
        const files = cleanFiles(skill.files);
        const filesHash = files.length ? crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex') : '';
        if (list[0]?.markdown === markdown && (list[0]?.filesHash || '') === filesHash) return;
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        if (files.length) await kvSet(backupFilesKey(skill.id, id), files);
        list.unshift({ id, createdAt: Date.now(), createdBy, name: skill.name, summary, markdown, fileCount: files.length, filesHash });
        for (const old of list.slice(MAX_BACKUPS)) if (old.fileCount) await dropKv(backupFilesKey(skill.id, old.id)).catch(() => {});
        await kvSet(backupKey(skill.id), list.slice(0, MAX_BACKUPS));
    } catch { /* 备份失败不阻止保存 */ }
}

export async function listSkillBackups(id) {
    return (await loadBackups(id)).map(({ markdown, filesHash, ...rest }) => ({ ...rest, size: String(markdown || '').length }));
}

export async function getSkillBackup(id, backupId) {
    const key = String(id || '').toLowerCase();
    const backup = (await loadBackups(key)).find((b) => b.id === String(backupId));
    if (!backup) return null;
    const files = backup.fileCount ? await kvGet(backupFilesKey(key, backup.id), []) : [];
    return { ...backup, files: Array.isArray(files) ? files : [] };
}

export async function rollbackSkill(id, backupId, { createdBy = '' } = {}) {
    const key = await requireCustom(id);
    const backup = await getSkillBackup(key, backupId);
    if (!backup) throw new NotFoundError('这个历史版本不存在');
    return saveSkill(backup.markdown, { createdBy, source: 'chat', overwrite: true, overrides: { id: key }, backupSummary: '回退前的版本', files: backup.files });
}

export function skillMarkdown(skill) {
    const line = (k, v) => (v ? `${k}: ${String(v).replace(/\r?\n/g, ' ')}\n` : '');
    return `---\n${line('id', skill.id)}${line('name', skill.name)}${line('name_en', skill.nameEn)}${line('description', skill.description)}${line('description_en', skill.descriptionEn)}${line('icon', skill.icon)}---\n${skill.body}\n`;
}

export async function exportSkillZip(id) {
    const skill = await getSkill(id);
    if (!skill) return null;
    const JSZip = (await optionalDep('jszip', '技能下载')).default;
    const zip = new JSZip();
    zip.file(`${skill.id}/SKILL.md`, skillMarkdown(skill));
    for (const file of skill.files || []) zip.file(`${skill.id}/${file.path}`, isBinary(file) ? bytesOf(file) : file.content);
    return { buffer: await zip.generateAsync({ type: 'nodebuffer' }), filename: `${skill.id}.zip` };
}

/** 读出整个技能包：最浅一层的 SKILL.md，加上它所在文件夹里的全部文件 */
export async function skillPackageFromArchive(buffer) {
    const JSZip = (await optionalDep('jszip', '技能压缩包导入')).default;
    const zip = await JSZip.loadAsync(buffer);
    const entries = Object.values(zip.files).filter((f) => {
        const parts = f.name.replace(/\\/g, '/').split('/').filter(Boolean);
        return !f.dir && !parts.some((part) => part === '__MACOSX' || part === '.DS_Store' || part.startsWith('._') || part === '..');
    });
    const entry = entries.filter((f) => /(^|\/)SKILL\.md$/i.test(f.name))
        .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
    if (!entry) throw new BusinessError('压缩包里没有找到 SKILL.md');
    const root = entry.name.replace(/\\/g, '/').replace(/[^/]*$/, '');
    const files = [];
    let total = 0;
    let skipped = 0;
    for (const item of entries) {
        const name = item.name.replace(/\\/g, '/');
        if (item === entry || !name.startsWith(root)) continue;
        const relative = safeRelative(name.slice(root.length));
        if (!relative || files.length >= LIMITS.files) { skipped += 1; continue; }
        const bytes = await item.async('nodebuffer');
        if (bytes.length > LIMITS.fileBytes || total + bytes.length > LIMITS.totalFileBytes) { skipped += 1; continue; }
        total += bytes.length;
        files.push(packageFile(relative, bytes));
    }
    return { markdown: await entry.async('string'), fallbackId: root.split('/').filter(Boolean).pop() || '', files, skipped };
}

const sizeText = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
/** 技能正文后面的一段：包里有哪些文件、怎么读 */
export function skillFilesNote(skill) {
    const files = publicFiles(skill?.files);
    if (!files.length) return '';
    return `\n\n#### 技能包文件\n${files.map((file) => `- ${file.path}（${file.binary ? '二进制，' : ''}${sizeText(file.size)}）`).join('\n')}\n`
        + `需要某个文件的内容时调用 read_skill（id 填 ${skill.id}，file 填上面的路径）。当前环境不能执行脚本：脚本只能读来参考其中的逻辑，不要声称已经运行。`;
}
/** read_skill 带 file：读技能包里的一个文件 */
export async function readSkillFile(id, filePath) {
    const skill = await getSkill(id);
    if (!skill) return null;
    const wanted = safeRelative(filePath);
    const file = (skill.files || []).find((f) => f.path === wanted);
    if (!file) return { missing: true, files: (skill.files || []).map((f) => f.path) };
    if (isBinary(file)) return { path: wanted, binary: true, size: bytesOf(file).length };
    return { path: wanted, content: file.content.slice(0, LIMITS.readChars), truncated: file.content.length > LIMITS.readChars };
}
