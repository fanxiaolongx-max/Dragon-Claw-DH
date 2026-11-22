// 技能、自定义 HTML 工具、对话附件的接口。
import crypto from 'node:crypto';
import { BusinessError, NotFoundError } from '../core/errors.js';
import { resolveRequestIdentity } from '../core/identity.js';
import { resolveAdmin } from '../core/access.js';
import {
    listSkills, getSkill, saveSkill, previewSkill, renameSkill, removeSkill, exportSkillZip, skillPackageFromArchive, publicFiles,
    listSkillBackups, getSkillBackup, rollbackSkill,
} from '../services/skill-service.js';
import { listCustomTools, getCustomTool, saveCustomTool, deleteCustomTool, renameCustomTool } from '../services/custom-tool-service.js';
import { listBookmarks, updateBookmark } from '../services/browser-bookmark-service.js';
import { saveChatUpload, readChatUpload } from '../services/chat-upload-service.js';
import { decideApproval } from '../agent/approvals.js';
import { runSelect, toolByName } from '../agent/tools.js';
import {
    setShared, setToolShared, isShared, canAccessSkill, filterSkillsForUser, isSuperUser,
} from '../services/distribution-service.js';

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

// 列表、详情与下载按「全员开放」权限隔离：未开放前仅超级管理员可用，创建/导入/改名/删除仅管理员
export async function agentSkillsRoutes(fastify) {
    fastify.addHook('onSend', async (_req, reply, payload) => { reply.header('Cache-Control', 'private, no-store'); return payload; });

    async function requireReadableSkill(req) {
        const skill = await getSkill(req.params.id);
        if (!skill) throw new NotFoundError('技能不存在');
        if (!(await canAccessSkill(skill, resolveRequestIdentity(req)))) {
            throw new BusinessError('该技能尚未向全员开放，仅超级管理员可用', 403);
        }
        return skill;
    }

    fastify.get('/', async (req) => ({ items: await filterSkillsForUser(await listSkills(), resolveRequestIdentity(req)) }));

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
        return { skill: { ...skill, files: publicFiles(skill.files) } };
    });

    fastify.post('/preview', async (req) => {
        if (typeof req.body?.skillMd === 'string') return { skill: previewSkill(req.body.skillMd, { fileName: req.body?.archiveName }) };
        const { markdown, fallbackId, files, skipped } = await skillPackageFromArchive(decodeArchive(req.body));
        return { skill: previewSkill(markdown, { fileName: fallbackId || req.body?.archiveName, files, skipped }) };
    });

    fastify.post('/import', async (req) => {
        const { markdown, fallbackId, files, skipped } = await skillPackageFromArchive(decodeArchive(req.body));
        const skill = await saveSkill(markdown, {
            files,
            createdBy: req.userIdentity.username,
            source: 'import',
            overwrite: req.body?.overwrite === true,
            fileName: fallbackId || req.body?.archiveName,
            overrides: overridesFrom(req.body),
        });
        return { skill: { ...skill, files: publicFiles(skill.files), skippedFiles: skipped } };
    });

    fastify.post('/restore-builtins', async () => ({ restored: 0 }));

    fastify.get('/:id', async (req) => {
        const skill = await requireReadableSkill(req);
        return { skill: { ...skill, sharedAccess: await isShared('skill', skill.id), files: publicFiles(skill.files) } };
    });
    // 版本历史：覆盖、回退、删除前自动留一份（仅对可见成员开放）
    fastify.get('/:id/backups', async (req) => {
        const skill = await requireReadableSkill(req);
        return { backups: await listSkillBackups(skill.id) };
    });
    fastify.get('/:id/backups/:backupId', async (req, reply) => {
        const skill = await requireReadableSkill(req);
        const backup = await getSkillBackup(skill.id, req.params.backupId);
        if (!backup) return reply.code(404).send({ error: '这个历史版本不存在' });
        return { backup: { ...backup, files: publicFiles(backup.files) } };
    });
    fastify.post('/:id/rollback/:backupId', async (req) => {
        const skill = await rollbackSkill(req.params.id, req.params.backupId, { createdBy: req.userIdentity.username });
        return { skill: { ...skill, files: publicFiles(skill.files) } };
    });
    fastify.post('/:id/reset', async () => { throw new BusinessError('内置技能在 Web 版里不能修改，无需恢复默认'); });
    fastify.patch('/:id/name', async (req) => renameSkill(req.params.id, req.body?.name));
    fastify.delete('/:id', async (req) => removeSkill(req.params.id));
    fastify.get('/:id/export', async (req, reply) => {
        const skill = await requireReadableSkill(req);
        const archive = await exportSkillZip(skill.id);
        if (!archive) return reply.code(404).send({ error: '技能不存在' });
        reply.header('Content-Type', 'application/zip');
        reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(archive.filename)}"`);
        reply.header('X-Skill-Export-Filename', encodeURIComponent(archive.filename));
        return reply.send(archive.buffer);
    });
}

const identityOf = async (req) => {
    const identity = resolveRequestIdentity(req);
    if (await resolveAdmin(identity)) {
        identity.isAdmin = true;
        identity.isSuper = true;
    }
    return identity;
};

async function sendCustomToolRaw(req, reply) {
    const tool = await getCustomTool(req.params.slug, await identityOf(req));
    if (!tool) return reply.code(404).type('text/plain; charset=utf-8').send('工具不存在');
    if (tool.builtIn) return reply.code(404).type('text/plain; charset=utf-8').send('内置工具请从工具页面打开');
    reply.header('Content-Security-Policy', TOOL_CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, no-store');
    return reply.type('text/html; charset=utf-8').send(withBridge(tool.html));
}

async function handleCustomToolBridge(req, reply) {
    const identity = await identityOf(req);
    const tool = await getCustomTool(req.params.slug, identity);
    if (!tool) return reply.code(404).send({ error: '工具不存在' });
    const method = String(req.body?.method || '');
    const params = req.body?.params && typeof req.body.params === 'object' ? req.body.params : {};
    reply.header('Cache-Control', 'no-store');
    if (method === 'me') return { username: identity.username, displayName: identity.displayName, isAdmin: Boolean(identity.isAdmin) };
    if (method === 'query') {
        const out = await runSelect({ sql: String(params.sql || ''), limit: params.limit, identity });
        if (!out.ok) return reply.code(400).send({ error: out.content });
        return JSON.parse(out.content);
    }
    if (method === 'report') {
        const out = await toolByName.get('get_report_overview').run({ snapshot_id: params.snapshot_id }, { identity });
        if (!out.ok) return reply.code(400).send({ error: out.content });
        try { return JSON.parse(out.content); } catch { return { message: out.content }; }
    }
    return reply.code(400).send({ error: `不支持的方法：${method}（可用：query、report、me）` });
}

export async function customToolsRoutes(fastify) {
    fastify.get('/', async (req) => listCustomTools(resolveRequestIdentity(req)));
    // 「全员开放 / 关闭开放」（与主线版同接口）：仅超级管理员
    fastify.patch('/:slug/distribution', async (req, reply) => {
        if (!isSuperUser(resolveRequestIdentity(req))) return reply.code(403).send({ error: '只有超级管理员可以设置全员开放' });
        if (typeof req.body?.sharedAccess !== 'boolean') return reply.code(400).send({ error: '工具分发设置无效' });
        const tool = await getCustomTool(req.params.slug, req.userIdentity);
        if (!tool) return reply.code(404).send({ error: '工具不存在' });
        return { sharedAccess: await setToolShared(tool.slug, req.body.sharedAccess, { builtIn: Boolean(tool.builtIn) }) };
    });
    fastify.post('/', async (req, reply) => reply.code(201).send(await saveCustomTool(req.body || {}, req.userIdentity)));
    fastify.patch('/:slug/name', async (req) => renameCustomTool(req.params.slug, { name: req.body?.name, nameEn: req.body?.nameEn }, req.userIdentity));
    fastify.delete('/:slug', async (req) => deleteCustomTool(req.params.slug, req.userIdentity));
    fastify.get('/:slug/meta', async (req, reply) => {
        const tool = await getCustomTool(req.params.slug, await identityOf(req));
        if (!tool) return reply.code(404).send({ error: '这个工具不存在，或者你没有查看它的权限' });
        return { slug: tool.slug, name: tool.name, nameEn: tool.nameEn, icon: tool.icon, description: tool.description, descriptionEn: tool.descriptionEn || '', ...(tool.builtIn ? { builtIn: true, entry: tool.entry } : {}) };
    });
    fastify.get('/:slug/raw', sendCustomToolRaw);
    fastify.post('/:slug/bridge', handleCustomToolBridge);
    fastify.get('/:slug/export', async (req, reply) => {
        const tool = await getCustomTool(req.params.slug, req.userIdentity);
        if (!tool || tool.builtIn) return reply.code(404).send({ error: tool ? '内置工具依赖平台接口，不能导出成单个文件' : '工具不存在' });
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

const MAX_CHAT_UPLOAD_BYTES = 20 * 1024 * 1024;
const CHAT_UPLOAD_CHUNK_TTL_MS = 15 * 60_000;
const pendingChatUploads = new Map();

function pruneChatUploads(now = Date.now()) {
    for (const [id, item] of pendingChatUploads.entries()) {
        if (now - item.updatedAt > CHAT_UPLOAD_CHUNK_TTL_MS) pendingChatUploads.delete(id);
    }
}

function getPendingChatUpload(uploadId, ownerId) {
    pruneChatUploads();
    const id = String(uploadId || '').trim();
    const record = pendingChatUploads.get(id);
    if (!record || record.ownerId !== ownerId) {
        throw new NotFoundError('上传会话不存在或已过期，请重新上传');
    }
    return { id, record };
}

/** POST /api/ai/uploads（支持 JSON base64 或 multipart）；精简包没有上传组件且传 multipart 时返回 501 */
export async function handleChatUpload(req, reply) {
    const ownerId = req.userIdentity.username;
    const isMultipart = typeof req.isMultipart === 'function' ? req.isMultipart() : /^multipart\/form-data/i.test(String(req.headers['content-type'] || ''));
    if (!isMultipart && req.body && typeof req.body === 'object') {
        const list = Array.isArray(req.body.files)
            ? req.body.files
            : (typeof req.body.dataBase64 === 'string' ? [req.body] : []);
        if (!list.length) return reply.code(400).send({ error: '没有收到文件' });
        const files = [];
        for (const item of list.slice(0, 5)) {
            const b64 = String(item?.dataBase64 || '').trim();
            if (!b64) continue;
            const buffer = Buffer.from(b64, 'base64');
            files.push(await saveChatUpload({ filename: item?.name || 'file', mimeType: item?.mimeType || '', buffer, ownerId }));
        }
        if (!files.length) return reply.code(400).send({ error: '没有收到有效文件' });
        return { files };
    }
    if (typeof req.parts !== 'function') return reply.code(501).send({ error: '当前安装包未包含文件上传组件（精简包），请改用完整包' });
    const files = [];
    for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        const buffer = await part.toBuffer();
        files.push(await saveChatUpload({ filename: part.filename, mimeType: part.mimetype, buffer, ownerId }));
        if (files.length >= 5) break;
    }
    if (!files.length) return reply.code(400).send({ error: '没有收到文件' });
    return { files };
}

export async function handleChatUploadStart(req) {
    pruneChatUploads();
    const ownerId = req.userIdentity.username;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const totalChunks = Number(body.totalChunks);
    const totalBytes = Number(body.totalBytes);
    if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 120) {
        throw new BusinessError('分块数量无效');
    }
    if (!Number.isFinite(totalBytes) || totalBytes <= 0 || totalBytes > MAX_CHAT_UPLOAD_BYTES * 1.45) {
        throw new BusinessError('单个附件不能超过 20 MB');
    }
    const uploadId = crypto.randomBytes(16).toString('hex');
    pendingChatUploads.set(uploadId, {
        ownerId,
        name: String(body.name || 'file').slice(0, 200),
        mimeType: String(body.mimeType || '').slice(0, 120),
        totalChunks,
        chunks: new Array(totalChunks).fill(null),
        received: 0,
        updatedAt: Date.now(),
    });
    return { uploadId };
}

export async function handleChatUploadChunk(req) {
    const { record } = getPendingChatUpload(req.params.uploadId, req.userIdentity.username);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const index = Number(body.index);
    const data = typeof body.data === 'string' ? body.data : '';
    if (!Number.isInteger(index) || index < 0 || index >= record.totalChunks || !data) {
        throw new BusinessError('分块参数无效');
    }
    if (record.chunks[index] === null) record.received += 1;
    record.chunks[index] = data;
    record.updatedAt = Date.now();
    return { receivedChunks: record.received, totalChunks: record.totalChunks };
}

export async function handleChatUploadComplete(req) {
    const { id, record } = getPendingChatUpload(req.params.uploadId, req.userIdentity.username);
    if (record.chunks.some((c) => c === null)) {
        throw new BusinessError('仍有分块未上传完成', 409);
    }
    const buffer = Buffer.from(record.chunks.join(''), 'base64');
    pendingChatUploads.delete(id);
    const saved = await saveChatUpload({
        filename: record.name,
        mimeType: record.mimeType,
        buffer,
        ownerId: record.ownerId,
    });
    return { files: [saved] };
}

export async function handleChatUploadCancel(req) {
    const id = String(req.params.uploadId || '').trim();
    const record = pendingChatUploads.get(id);
    if (record && record.ownerId === req.userIdentity.username) pendingChatUploads.delete(id);
    return { success: true };
}

// 写操作审批：对话里确认卡上的「允许 / 拒绝」
export async function agentWorkspaceRoutes(fastify) {
    // 内置浏览器收藏（与主线版同接口）：每人一份；基座版内置浏览器和终端只给超级管理员，所以只有超级管理员能改
    fastify.get('/browser/bookmarks', async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        return { items: await listBookmarks(req.userIdentity.username) };
    });
    fastify.post('/browser/bookmarks', async (req, reply) => {
        if (!isSuperUser(req.userIdentity)) return reply.code(403).send({ code: 'ADMIN_REQUIRED', error: '仅超级管理员可维护浏览器收藏' });
        return { items: await updateBookmark(req.userIdentity.username, req.body || {}) };
    });
    fastify.post('/approvals/:id', async (req, reply) => {
        const ok = decideApproval(req.params.id, req.userIdentity.username, req.body?.decision);
        if (!ok) return reply.code(404).send({ error: '这个确认已经失效（超时、已处理，或不是你发起的）' });
        return { success: true };
    });
}

// 自定义工具页面：外壳页 + 沙箱 iframe。
//   - iframe 不带 allow-same-origin：拿不到平台的 Cookie 和本地存储；
//   - CSP 禁止一切网络请求和弹窗：工具无法把数据发到外面；
//   - 需要平台数据时经外壳页的只读数据桥（DH.query / DH.report / DH.me），权限与当前查看者相同。
const SANDBOX = 'allow-scripts allow-forms allow-modals allow-downloads';
const TOOL_CSP = `sandbox ${SANDBOX}; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'`;
// 注入到工具页面最前面的数据桥客户端
const BRIDGE_CLIENT = `<script>(function(){var seq=0,wait={};window.addEventListener('message',function(e){var d=e.data;if(!d||d.__dh!==1||!wait[d.id])return;var w=wait[d.id];delete wait[d.id];if(d.ok)w[0](d.data);else w[1](new Error(d.error||'请求失败'));});function call(m,p){return new Promise(function(res,rej){var id=++seq;wait[id]=[res,rej];parent.postMessage({__dh:1,id:id,method:m,params:p||{}},'*');setTimeout(function(){if(wait[id]){delete wait[id];rej(new Error('平台没有响应'));}},60000);});}window.DH={query:function(sql,limit){return call('query',{sql:sql,limit:limit});},report:function(snapshotId){return call('report',{snapshot_id:snapshotId});},me:function(){return call('me');}};})();</script>`;
function withBridge(html) {
    const m = /<head[^>]*>/i.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + BRIDGE_CLIENT + html.slice(m.index + m[0].length);
    return BRIDGE_CLIENT + html;
}
// 外壳页里的数据桥服务端：只转发白名单方法
const BRIDGE_SHELL = `<script>(function(){var f=document.querySelector('iframe');window.addEventListener('message',function(e){if(e.source!==f.contentWindow)return;var d=e.data;if(!d||d.__dh!==1)return;fetch('bridge',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:d.method,params:d.params})}).then(function(r){return r.json().then(function(j){return r.ok?{ok:true,data:j}:{ok:false,error:j.error||('HTTP '+r.status)};});}).catch(function(err){return{ok:false,error:err.message};}).then(function(reply){reply.__dh=1;reply.id=d.id;f.contentWindow.postMessage(reply,'*');});});})();</script>`;

export function registerCustomToolPages(app, phase2Html) {
    app.get('/custom-tools/:slug/raw', sendCustomToolRaw);
    app.post('/custom-tools/:slug/bridge', handleCustomToolBridge);
    const page = async (req, reply) => {
        const tool = await getCustomTool(req.params.slug, await identityOf(req));
        reply.type('text/html; charset=utf-8').header('Cache-Control', 'private, no-store');
        if (!tool) return reply.code(404).send(phase2Html('自定义工具').replace(/Web 版暂未开放[^<]*/g, '这个工具不存在，或者你没有查看它的权限'));
        // 内置工具是平台自己的页面：用统一的外壳页打开（不进沙箱）
        if (tool.builtIn) return reply.redirect(`../../custom-tool.html?slug=${encodeURIComponent(tool.slug)}`, 302);
        return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(tool.name)} · Dragon Claw</title>
<style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column;font:14px/1.4 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1c2430}
header{display:flex;align-items:center;gap:10px;padding:8px 14px;background:#fff;border-bottom:1px solid #e3e6eb}
header a{color:#1f6feb;text-decoration:none}header b{font-size:15px}header small{color:#6b7480;margin-left:auto}
iframe{flex:1;width:100%;border:0;background:#fff}</style></head>
<body><header><a href="../../">← 返回首页</a><span>${esc(tool.icon)}</span><b>${esc(tool.name)}</b><small>自定义工具 · 在隔离沙箱中运行</small></header>
<iframe src="raw" sandbox="${SANDBOX}" title="${esc(tool.name)}"></iframe>${BRIDGE_SHELL}</body></html>`;
    };
    // 服务端忽略末尾斜杠，两种地址是同一条路由；页面里用相对地址取 raw，所以没有斜杠时先补上
    app.get('/custom-tools/:slug', async (req, reply) => {
        if (!String(req.url).split('?')[0].endsWith('/')) return reply.redirect(`${encodeURIComponent(req.params.slug)}/`, 302);
        return page(req, reply);
    });
}
