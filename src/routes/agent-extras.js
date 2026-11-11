// 技能、自定义 HTML 工具、对话附件的接口。
import { BusinessError } from '../core/errors.js';
import { resolveAdmin } from '../core/access.js';
import {
    listSkills, getSkill, saveSkill, previewSkill, renameSkill, removeSkill, exportSkillZip, skillMarkdownFromArchive,
} from '../services/skill-service.js';
import { listCustomTools, getCustomTool, saveCustomTool, deleteCustomTool } from '../services/custom-tool-service.js';
import { saveChatUpload, readChatUpload } from '../services/chat-upload-service.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const overridesFrom = (body) => {
    const pick = (key) => (typeof body?.[key] === 'string' && body[key].trim() ? body[key].trim() : undefined);
    return { name: pick('name'), nameEn: pick('nameEn'), description: pick('description'), descriptionEn: pick('descriptionEn'), icon: pick('icon') };
};
function decodeArchive(body) {
    const base64 = String(body?.archiveBase64 || '');
    if (!base64) throw new BusinessError('缺少 SKILL 压缩包');
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > 5 * 1024 * 1024) throw new BusinessError('SKILL 压缩包不能超过 5 MB');
    return buffer;
}

// 列表与下载对所有人开放；创建、导入、改名、删除仅管理员（由 core/access.js 统一拦截）
export async function agentSkillsRoutes(fastify) {
    fastify.addHook('onSend', async (_req, reply, payload) => { reply.header('Cache-Control', 'private, no-store'); return payload; });

    fastify.get('/', async () => ({ items: await listSkills() }));

    fastify.post('/', async (req) => {
        const markdown = String(req.body?.skillMd || '');
        if (!markdown.trim()) throw new BusinessError('缺少 SKILL.md 内容');
        const skill = await saveSkill(markdown, {
            createdBy: req.userIdentity.username,
            source: req.body?.source === 'import' ? 'import' : 'chat',
            overwrite: req.body?.overwrite === true,
            fileName: req.body?.archiveName,
            overrides: overridesFrom(req.body),
        });
        return { skill };
    });

    fastify.post('/preview', async (req) => {
        if (typeof req.body?.skillMd === 'string') return { skill: previewSkill(req.body.skillMd, { fileName: req.body?.archiveName }) };
        const { markdown, fallbackId } = await skillMarkdownFromArchive(decodeArchive(req.body));
        return { skill: previewSkill(markdown, { fileName: fallbackId || req.body?.archiveName }) };
    });

    fastify.post('/import', async (req) => {
        const { markdown, fallbackId } = await skillMarkdownFromArchive(decodeArchive(req.body));
        const skill = await saveSkill(markdown, {
            createdBy: req.userIdentity.username,
            source: 'import',
            overwrite: req.body?.overwrite === true,
            fileName: fallbackId || req.body?.archiveName,
            overrides: overridesFrom(req.body),
        });
        return { skill };
    });

    fastify.post('/restore-builtins', async () => ({ restored: 0 }));

    fastify.get('/:id', async (req, reply) => {
        const skill = await getSkill(req.params.id);
        if (!skill) return reply.code(404).send({ error: '技能不存在' });
        return { skill };
    });
    fastify.get('/:id/backups', async () => ({ items: [] }));
    fastify.patch('/:id/name', async (req) => renameSkill(req.params.id, req.body?.name));
    fastify.delete('/:id', async (req) => removeSkill(req.params.id));
    fastify.get('/:id/export', async (req, reply) => {
        const archive = await exportSkillZip(req.params.id);
        if (!archive) return reply.code(404).send({ error: '技能不存在' });
        reply.header('Content-Type', 'application/zip');
        reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(archive.filename)}"`);
        reply.header('X-Skill-Export-Filename', encodeURIComponent(archive.filename));
        return reply.send(archive.buffer);
    });
}

export async function customToolsRoutes(fastify) {
    fastify.get('/', async (req) => listCustomTools(req.userIdentity));
    fastify.post('/', async (req, reply) => reply.code(201).send(await saveCustomTool(req.body || {}, req.userIdentity)));
    fastify.delete('/:slug', async (req) => deleteCustomTool(req.params.slug, req.userIdentity));
    fastify.get('/:slug/export', async (req, reply) => {
        const tool = await getCustomTool(req.params.slug, req.userIdentity);
        if (!tool) return reply.code(404).send({ error: '工具不存在' });
        reply.header('Content-Type', 'text/html; charset=utf-8');
        reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(`${tool.slug}.html`)}"`);
        return reply.send(tool.html);
    });
    // 桌面版的工具市场、备份等接口：Web 版没有，返回空结果保持页面安静
    fastify.get('/f12-to-extension/scripts', async () => ({ scripts: [] }));
    fastify.get('/market/platform', async () => ({ tools: [] }));
    fastify.get('/backup/summary', async () => ({ tools: [], count: 0 }));
    fastify.get('/team-tools', async () => ({ items: [] }));
}

export async function agentFilesRoutes(fastify) {
    // 对话里附件卡片的预览 / 下载：只能取自己上传的文件
    fastify.get('/stat', async (req, reply) => {
        const file = await readChatUpload(String(req.query?.path || ''), req.userIdentity.username);
        if (!file) return reply.code(404).send({ error: '文件不存在或已过期' });
        return { path: String(req.query.path), name: file.name, size: file.size, isFile: true, mimeType: file.mimeType };
    });
    fastify.get('/raw', async (req, reply) => {
        const file = await readChatUpload(String(req.query?.path || ''), req.userIdentity.username, { withData: true });
        if (!file || !file.buffer) return reply.code(404).send({ error: '文件不存在' });
        const inlineOk = /^image\/(png|jpe?g|gif|webp)$/i.test(file.mimeType) && req.query?.download !== '1';
        reply.header('Content-Type', inlineOk ? file.mimeType : 'application/octet-stream');
        reply.header('Content-Disposition', `${inlineOk ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Cache-Control', 'private, max-age=300');
        return reply.send(file.buffer);
    });
}

/** POST /api/ai/uploads（multipart，字段 files）；精简包没有上传组件时由 server.js 统一返回 501 */
export async function handleChatUpload(req, reply) {
    if (typeof req.parts !== 'function') return reply.code(501).send({ error: '当前安装包未包含文件上传组件（精简包），请改用完整包' });
    const files = [];
    for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        const buffer = await part.toBuffer();
        files.push(await saveChatUpload({ filename: part.filename, mimeType: part.mimetype, buffer, ownerId: req.userIdentity.username }));
        if (files.length >= 5) break;
    }
    if (!files.length) return reply.code(400).send({ error: '没有收到文件' });
    return { files };
}

// 自定义工具页面：外壳页 + 沙箱 iframe。工具代码拿不到平台的 Cookie，也调不了平台接口。
const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';

export function registerCustomToolPages(app, phase2Html) {
    const identityOf = async (req) => {
        const identity = req.userIdentity;
        if (await resolveAdmin(identity)) identity.isAdmin = true;
        return identity;
    };
    app.get('/custom-tools/:slug/raw', async (req, reply) => {
        const tool = await getCustomTool(req.params.slug, await identityOf(req));
        if (!tool) return reply.code(404).type('text/plain; charset=utf-8').send('工具不存在');
        reply.header('Content-Security-Policy', `sandbox ${SANDBOX}`);
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Cache-Control', 'private, no-store');
        return reply.type('text/html; charset=utf-8').send(tool.html);
    });
    const page = async (req, reply) => {
        const tool = await getCustomTool(req.params.slug, await identityOf(req));
        reply.type('text/html; charset=utf-8').header('Cache-Control', 'private, no-store');
        if (!tool) return reply.code(404).send(phase2Html('自定义工具').replace(/Web 版暂未开放[^<]*/g, '这个工具不存在，或者你没有查看它的权限'));
        return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(tool.name)} · Dragon Claw</title>
<style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column;font:14px/1.4 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1c2430}
header{display:flex;align-items:center;gap:10px;padding:8px 14px;background:#fff;border-bottom:1px solid #e3e6eb}
header a{color:#1f6feb;text-decoration:none}header b{font-size:15px}header small{color:#6b7480;margin-left:auto}
iframe{flex:1;width:100%;border:0;background:#fff}</style></head>
<body><header><a href="../../">← 返回首页</a><span>${esc(tool.icon)}</span><b>${esc(tool.name)}</b><small>自定义工具 · 在隔离沙箱中运行</small></header>
<iframe src="raw" sandbox="${SANDBOX}" title="${esc(tool.name)}"></iframe></body></html>`;
    };
    // 服务端忽略末尾斜杠，两种地址是同一条路由；页面里用相对地址取 raw，所以没有斜杠时先补上
    app.get('/custom-tools/:slug', async (req, reply) => {
        if (!String(req.url).split('?')[0].endsWith('/')) return reply.redirect(302, `${encodeURIComponent(req.params.slug)}/`);
        return page(req, reply);
    });
}
