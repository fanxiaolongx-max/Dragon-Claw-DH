// 技能（SKILL.md）：内置技能随包发布（只读），自定义技能存应用库。格式与桌面版一致，草稿可互相导入。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../config.js';
import { BusinessError, NotFoundError } from '../core/errors.js';
import { optionalDep } from '../core/optional.js';
import { selectTable, upsertRow, updateRows, deleteRows, sqlVal } from '../dao/scoped.js';

const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
const LIMITS = { name: 80, description: 400, body: 60_000 };
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
    source: row.source || 'chat',
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
    const custom = rows.map(rowToSkill);
    const taken = new Set(custom.map((s) => s.id));
    const all = [...builtins().filter((s) => !taken.has(s.id)), ...custom];
    return withBody ? all : all.map(({ body, files, ...rest }) => rest);
}

export async function getSkill(id) {
    const key = String(id || '').toLowerCase();
    const rows = await selectTable('agent_skills', { whereSql: `\`id\` = ${sqlVal(key)}`, limit: 1, memFilter: (r) => r.id === key });
    if (rows.length) return rowToSkill(rows[0]);
    return builtins().find((s) => s.id === key) || null;
}

export async function saveSkill(markdown, { createdBy = '', source = 'chat', overwrite = false, overrides = {}, fileName = '' } = {}) {
    const skill = normalizeSkillMarkdown(markdown, { fallbackId: String(fileName || '').replace(/\.(md|markdown|txt)$/i, ''), overrides });
    if (builtins().some((s) => s.id === skill.id)) throw new BusinessError(`「${skill.id}」是内置技能的标识，请换一个标识`, 409);
    const existing = await getSkill(skill.id);
    if (existing && !overwrite) {
        throw Object.assign(new BusinessError(`技能「${skill.id}」已存在，确认要覆盖吗？`, 409), { codeName: 'SKILL_EXISTS' });
    }
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
    return getSkill(skill.id);
}

export function previewSkill(markdown, { fileName = '' } = {}) {
    const skill = normalizeSkillMarkdown(markdown, { fallbackId: String(fileName || '').replace(/\.(md|markdown|txt)$/i, '') });
    return { ...skill, fileCount: 0, files: [] };
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
    await deleteRows('agent_skills', { whereSql: `\`id\` = ${sqlVal(key)}`, memFilter: (r) => r.id === key });
    return { success: true };
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
    return { buffer: await zip.generateAsync({ type: 'nodebuffer' }), filename: `${skill.id}.zip` };
}

/** 从压缩包里取最浅一层的 SKILL.md */
export async function skillMarkdownFromArchive(buffer) {
    const JSZip = (await optionalDep('jszip', '技能压缩包导入')).default;
    const zip = await JSZip.loadAsync(buffer);
    const entry = Object.values(zip.files).filter((f) => !f.dir && /(^|\/)SKILL\.md$/i.test(f.name))
        .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
    if (!entry) throw new BusinessError('压缩包里没有找到 SKILL.md');
    return { markdown: await entry.async('string'), fallbackId: entry.name.split('/').slice(-2, -1)[0] || '' };
}
