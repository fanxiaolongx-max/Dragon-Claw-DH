// 技能、自定义 HTML 工具、对话附件的接口。
import { BusinessError } from '../core/errors.js';
import { resolveAdmin } from '../core/access.js';
import {
    listSkills, getSkill, saveSkill, previewSkill, renameSkill, removeSkill, exportSkillZip, skillMarkdownFromArchive,
    listSkillBackups, getSkillBackup, rollbackSkill,
} from '../services/skill-service.js';
import { listCustomTools, getCustomTool, saveCustomTool, deleteCustomTool } from '../services/custom-tool-service.js';
import { saveChatUpload, readChatUpload } from '../services/chat-upload-service.js';
import { decideApproval } from '../agent/approvals.js';
import { runSelect, toolByName } from '../agent/tools.js';

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
    // 版本历史：覆盖、回退、删除前自动留一份
    fastify.get('/:id/backups', async (req) => ({ backups: await listSkillBackups(req.params.id) }));
    fastify.get('/:id/backups/:backupId', async (req, reply) => {
        const backup = await getSkillBackup(req.params.id, req.params.backupId);
        if (!backup) return reply.code(404).send({ error: '这个历史版本不存在' });
        return { backup };
    });
    fastify.post('/:id/rollback/:backupId', async (req) => ({ skill: await rollbackSkill(req.params.id, req.params.backupId, { createdBy: req.userIdentity.username }) }));
    fastify.post('/:id/reset', async () => { throw new BusinessError('内置技能在 Web 版里不能修改，无需恢复默认'); });
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

// 写操作审批：对话里确认卡上的「允许 / 拒绝」
export async function agentWorkspaceRoutes(fastify) {
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
    const identityOf = async (req) => {
        const identity = req.userIdentity;
        if (await resolveAdmin(identity)) identity.isAdmin = true;
        return identity;
    };
    app.get('/custom-tools/:slug/raw', async (req, reply) => {
        const tool = await getCustomTool(req.params.slug, await identityOf(req));
        if (!tool) return reply.code(404).type('text/plain; charset=utf-8').send('工具不存在');
        reply.header('Content-Security-Policy', TOOL_CSP);
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Cache-Control', 'private, no-store');
        return reply.type('text/html; charset=utf-8').send(withBridge(tool.html));
    });
    app.post('/custom-tools/:slug/bridge', async (req, reply) => {
        const identity = await identityOf(req);
        const tool = await getCustomTool(req.params.slug, identity);
        if (!tool) return reply.code(404).send({ error: '工具不存在' });
        const method = String(req.body?.method || '');
        const params = req.body?.params && typeof req.body.params === 'object' ? req.body.params : {};
        reply.header('Cache-Control', 'no-store');
        if (method === 'me') return { username: identity.username, displayName: identity.displayName, isAdmin: Boolean(identity.isAdmin) };
        if (method === 'query') {
            const out = await runSelect({ sql: String(params.sql || ''), limit: params.limit });
            if (!out.ok) return reply.code(400).send({ error: out.content });
            return JSON.parse(out.content);
        }
        if (method === 'report') {
            const out = await toolByName.get('get_report_overview').run({ snapshot_id: params.snapshot_id }, { identity });
            if (!out.ok) return reply.code(400).send({ error: out.content });
            try { return JSON.parse(out.content); } catch { return { message: out.content }; }
        }
        return reply.code(400).send({ error: `不支持的方法：${method}（可用：query、report、me）` });
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
<iframe src="raw" sandbox="${SANDBOX}" title="${esc(tool.name)}"></iframe>${BRIDGE_SHELL}</body></html>`;
    };
    // 服务端忽略末尾斜杠，两种地址是同一条路由；页面里用相对地址取 raw，所以没有斜杠时先补上
    app.get('/custom-tools/:slug', async (req, reply) => {
        if (!String(req.url).split('?')[0].endsWith('/')) return reply.redirect(302, `${encodeURIComponent(req.params.slug)}/`);
        return page(req, reply);
    });
}
