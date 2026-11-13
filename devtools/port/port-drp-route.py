#!/usr/bin/env python3
"""把主线版 routes/department-reward-penalty.js 转成基座 Web 版的 Fastify 路由（经 core/express-compat.js 适配，处理函数原样保留）。
用法：port-drp-route.py <主线版 tools-platform 目录>"""
import os, re, sys
root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
lines = open(os.path.join(sys.argv[1], 'backend/routes/department-reward-penalty.js'), encoding='utf8').read().split('\n')
def index(prefix, start=0):
    for i in range(start, len(lines)):
        if lines[i].startswith(prefix): return i
    raise SystemExit('marker not found: ' + prefix)
def cut(a, b, replacement=()):
    lines[a:b] = list(replacement)
# 静态页面发布（推到外部站点）在基座上不可用：整段去掉，统一返回提示
cut(index("router.get('/snapshot/html'"), index("router.get('/backup/export'"), [
    "router.get('/snapshot/*', respond(async () => fail('基座 Web 版不提供「发布成静态页面」，请直接在平台里查看', 404)));",
    "router.put('/snapshot/*', respond(async () => fail('基座 Web 版不提供「发布成静态页面」，请直接在平台里查看', 404)));",
    "router.post('/snapshot/*', respond(async () => fail('基座 Web 版不提供「发布成静态页面」，请直接在平台里查看', 404)));",
    '',
])
# 证据附件：主线版写本地目录，这里存应用库的文件表
cut(index('const getEvidenceDir'), index("router.delete('/records/:id'"), '''router.post('/evidence', UPLOAD, respond(async (req, res) => {
    if (!req.file) fail('请选择证据文件');
    if (req.file.size > 10 * 1024 * 1024) fail('证据文件不能超过 10 MB', 413);
    const originalExt = path.extname(req.file.originalname || '').toLowerCase();
    let extension = MIME_TO_EXT.get(req.file.mimetype);
    if (!extension && EVIDENCE_EXTENSIONS.has(originalExt)) extension = originalExt === '.jpeg' ? '.jpg' : originalExt;
    if (!extension || !EVIDENCE_EXTENSIONS.has(extension)) fail('仅支持 PDF、PNG、JPG、TXT、压缩包(ZIP/RAR/7Z/TAR/GZ) 及邮件(EML/MSG) 格式');
    const filename = crypto.randomUUID() + extension;
    await repo.saveEvidenceFile(filename, req.file.buffer, { originalName: req.file.originalname, owner: req.user.username });
    await repo.audit(req.user.username, '上传证据', 'evidence', filename, null, { filename, size: req.file.size }, '');
    res.json({ path: '/api/department-reward-penalty/evidence/' + filename, filename: req.file.originalname, size: req.file.size });
}));
router.get('/evidence/:filename', respond(async (req, res) => {
    const filename = req.params.filename;
    if (!EVIDENCE_FILENAME_REGEX.test(filename)) fail('文件名无效');
    const file = await repo.readEvidenceFile(filename);
    const ext = path.extname(filename).toLowerCase();
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (file.mimeType) res.setHeader('Content-Type', file.mimeType);
    const isInline = req.query.download !== '1' && new Set(['.pdf', '.png', '.jpg', '.txt']).has(ext);
    res.setHeader('Content-Disposition', `${isInline ? 'inline' : 'attachment'}; filename="evidence${ext}"`);
    res.send(file.buffer);
}));'''.split('\n'))
body = []
for line in lines:
    if re.match(r'^const .*=\s*require\(', line) or line.startswith('const router = express.Router()') or re.match(r'^const (evidenceUpload|backupUpload) = multer', line) or line.startswith('module.exports'):
        continue
    line = re.sub(r'(evidenceUpload|backupUpload)\.single\(\'file\'\)', 'UPLOAD', line)
    line = line.replace('`${getDbPath()}:${req.user.username}`', '`drp:${req.user.username}`')
    body.append(line)
text = '\n'.join(body)
for leftover in ('getDbPath', 'getDataDir', 'multer', 'snapshotPublish', 'buildSnapshot', 'JSZip', 'fs.', 'sendFile'):
    if leftover in text: raise SystemExit('leftover reference: ' + leftover)
head = '''// 负向事件管理（内置工具 department-reward-penalty）的接口。
// 本文件由 devtools/port/port-drp-route.py 从主线版 routes/department-reward-penalty.js 生成：
// 处理函数原样保留（经 core/express-compat.js 适配到 Fastify），只换掉了证据附件的存放方式，并去掉「发布成静态页面」。
// 需要改业务规则时请改主线版后重新生成，或直接改这里并在生成脚本里同步。
import crypto from 'node:crypto';
import path from 'node:path';
import { expressCompat, UPLOAD } from '../core/express-compat.js';
import * as repo from '../services/business/department-reward-penalty-service.js';

const MIME_TO_EXT = new Map([
    ['application/pdf', '.pdf'], ['image/png', '.png'], ['image/jpeg', '.jpg'], ['text/plain', '.txt'], ['application/zip', '.zip'], ['application/x-zip-compressed', '.zip'],
    ['application/vnd.rar', '.rar'], ['application/x-rar-compressed', '.rar'], ['application/x-7z-compressed', '.7z'], ['application/x-tar', '.tar'],
    ['application/gzip', '.gz'], ['application/x-gzip', '.gz'], ['message/rfc822', '.eml'], ['application/vnd.ms-outlook', '.msg'], ['application/x-msg', '.msg'],
]);

export async function departmentRewardPenaltyRoutes(fastify) {
    const router = expressCompat(fastify);
'''
indented = '\n'.join(('    ' + l) if l.strip() else '' for l in text.strip('\n').split('\n'))
out = os.path.join(root, 'src/routes/department-reward-penalty.js')
open(out, 'w', encoding='utf8').write(head + indented + '\n}\n')
print(out, len(indented.split('\n')), 'lines')
