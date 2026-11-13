// 奖励申报与评优（内置工具 reward-program）的接口。流程规则与主线版 routes/reward-program.js 一致：
// 申报人维护自己的草稿并发布 / 提交；管理员审批、撤销、归档、维护规则；公示期内任何人可提异议。
// 基座 Web 版没有「发布成静态页面」（主线版用它推到外部站点），对应接口返回明确提示。
import crypto from 'node:crypto';
import * as repo from '../services/business/reward-program-service.js';

const { CATEGORIES, money, label, normalizeApplication } = repo;
const PREFIX = 'reward-program';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const isAdmin = (req) => Boolean(req.userIdentity.isAdmin);
const me = (req) => req.userIdentity.username;
const owner = (req, record) => isAdmin(req) || record.applicant === me(req);
const revision = (body) => { const value = Number(body?.revision); if (!Number.isInteger(value) || value < 1) fail('记录版本无效'); return value; };
const revisionOr = (body, old) => revision(body?.revision ? body : { revision: old.revision });

const person = (item) => ({ name: label(item.name), staffId: label(item.staffId, 80), mode: item.mode, amountMinor: item.amountMinor, percentBp: item.percentBp });
const draft = (body) => ({
    category: label(body.category, 30), ruleId: label(body.ruleId, 100), title: label(body.title),
    period: label(body.period, 40), projectName: label(body.projectName), summary: label(body.summary, 3000),
    evidence: label(body.evidence, 2000), totalAmountMinor: body.totalAmountMinor,
    currency: body.currency === 'CNY' ? 'CNY' : 'EGP',
    attachments: Array.isArray(body.attachments) ? body.attachments.filter((u) => typeof u === 'string' && u.length <= 500).slice(0, 20) : (body.attachment ? [String(body.attachment)] : []),
    teams: Array.isArray(body.teams) ? body.teams.slice(0, 200).map((item) => ({
        name: label(item.name), mode: item.mode, amountMinor: item.amountMinor, percentBp: item.percentBp,
        members: Array.isArray(item.members) ? item.members.slice(0, 200).map(person) : [],
    })) : [],
    recipients: Array.isArray(body.recipients) ? body.recipients.slice(0, 200).map((item) => ({ ...person(item), team: label(item.team) })) : [],
});
async function validDraft(body) {
    const value = draft(body || {});
    if (!CATEGORIES.includes(value.category) || !(await repo.rules()).some((item) => item.id === value.ruleId && item.category === value.category && !item.archived)) fail('奖励规则无效');
    return value;
}

/** 从 multipart 请求里取出第一个文件（字段名 file） */
export async function firstUploadedFile(req) {
    if (typeof req.parts !== 'function') fail('当前安装包未包含文件上传组件（精简包），请改用完整包', 501);
    for await (const part of req.parts()) {
        if (part.type === 'file') return { buffer: await part.toBuffer(), filename: part.filename, mimeType: part.mimetype };
    }
    return null;
}

export async function rewardProgramRoutes(fastify) {
    fastify.addHook('onSend', async (_req, reply, payload) => { if (!reply.getHeader('Cache-Control')) reply.header('Cache-Control', 'no-store'); return payload; });

    fastify.post('/evidence', async (req) => {
        const file = await firstUploadedFile(req);
        if (!file) fail('请选择证据文件');
        return repo.saveEvidence({ prefix: PREFIX, originalName: file.filename, mimeType: file.mimeType, buffer: file.buffer, owner: me(req) });
    });
    fastify.get('/evidence/:filename', async (req, reply) => {
        const file = await repo.readEvidence(PREFIX, req.params.filename);
        reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
        // 只有图片和 PDF 允许在浏览器里直接打开，其余一律下载
        if (!/^(?:image\/|application\/pdf)/.test(file.mimeType)) reply.header('Content-Disposition', 'attachment');
        return reply.type(file.mimeType).send(file.buffer);
    });

    fastify.get('/', async (req) => ({ rules: await repo.rules(), applications: await repo.listApplications(me(req), isAdmin(req)), username: me(req), isAdmin: isAdmin(req) }));

    fastify.get('/applications/:id/events', async (req) => {
        const record = await repo.application(req.params.id);
        if (!record || !owner(req, record)) fail('申请不存在或无权查看', 404);
        return repo.events(record.id);
    });
    fastify.get('/applications/:id/objections', async (req) => {
        const record = await repo.application(req.params.id);
        if (!record || (record.status !== 'publicity' && !owner(req, record))) fail('申请不存在或无权查看', 404);
        return repo.objections(record.id, me(req), isAdmin(req));
    });
    fastify.post('/applications/:id/objections', async (req, reply) => {
        const note = label(req.body?.note, 1000);
        if (!note) fail('请填写异议内容');
        return reply.code(201).send(await repo.addObjection(req.params.id, me(req), note));
    });
    fastify.post('/applications/:id/objections/:objectionId/resolve', async (req) => {
        if (!isAdmin(req)) fail('仅管理员可处理公示异议', 403);
        const resolution = label(req.body?.resolution, 1000);
        if (!resolution) fail('请填写处理结论');
        return repo.resolveObjection(req.params.id, req.params.objectionId, me(req), resolution);
    });

    fastify.post('/applications', async (req, reply) => reply.code(201).send(await repo.insert(await validDraft(req.body), me(req))));
    fastify.post('/applications/:id/save', async (req) => {
        const old = await repo.application(req.params.id);
        if (!old || !owner(req, old)) fail('申请不存在或无权编辑', 404);
        if (!['draft', 'returned', 'published'].includes(old.status)) fail('当前状态不能修改', 409);
        if (old.status === 'published' && !isAdmin(req)) fail('仅管理员可修改已发布记录', 403);
        const value = await validDraft(req.body);
        const published = old.status === 'published';
        return repo.update(old.id, revision(req.body), me(req), { category: value.category, ruleId: value.ruleId, status: published ? 'published' : 'draft', payload: value }, published ? 'force_edit' : 'save');
    });
    fastify.post('/applications/:id/publish', async (req) => {
        const old = await repo.application(req.params.id);
        if (!old || !owner(req, old)) fail('申请不存在或无权发布', 404);
        if (old.status !== 'draft' && old.status !== 'returned') fail('只有草稿可以发布', 409);
        const value = normalizeApplication(draft(req.body?.title ? req.body : old), await repo.rules());
        return repo.update(old.id, revisionOr(req.body, old), me(req), { category: value.category, ruleId: value.ruleId, status: 'published', payload: value }, 'publish', '发布奖励记录');
    });
    fastify.post('/applications/:id/submit', async (req) => {
        const old = await repo.application(req.params.id);
        if (!old || !owner(req, old)) fail('申请不存在或无权提交', 404);
        if (!['draft', 'returned'].includes(old.status)) fail('当前状态不能提交', 409);
        const value = normalizeApplication(draft(req.body || {}), await repo.rules());
        return repo.update(old.id, revision(req.body), me(req), { category: value.category, ruleId: value.ruleId, status: 'submitted', payload: value }, 'submit');
    });

    // 管理员动作：撤销 / 归档 / 恢复归档，都是「旧记录 + 几个标记字段」换一个状态
    const adminMove = (path, { deny, allowed, wrongState, build }) => fastify.post(path, async (req) => {
        if (!isAdmin(req)) fail(deny, 403);
        const old = await repo.application(req.params.id);
        if (!old) fail('申请不存在', 404);
        if (!allowed.includes(old.status)) fail(wrongState, 409);
        const { status, extra, action, note } = build(req, old);
        return repo.update(old.id, revisionOr(req.body, old), me(req), { category: old.category, ruleId: old.ruleId, status, payload: { ...old, ...extra } }, action, note);
    });
    adminMove('/applications/:id/revoke', {
        deny: '仅管理员可撤销记录', allowed: ['published', 'completed', 'publicity'], wrongState: '只有已发布的记录可以撤销',
        build(req) {
            const reason = label(req.body?.reason, 1000);
            if (!reason) fail('请填写撤销原因');
            return { status: 'revoked', extra: { revokeReason: reason, revokedAt: new Date().toISOString(), revokedBy: me(req) }, action: 'revoke', note: reason };
        },
    });
    adminMove('/applications/:id/archive', {
        deny: '仅管理员可归档记录', allowed: ['published', 'revoked', 'completed'], wrongState: '当前状态不能归档（已归档的记录不能再次归档）',
        build: (req, old) => ({ status: 'archived', extra: { previousStatus: old.status, archivedAt: new Date().toISOString(), archivedBy: me(req) }, action: 'archive', note: '归档记录' }),
    });
    adminMove('/applications/:id/unarchive', {
        deny: '仅管理员可恢复归档记录', allowed: ['archived', 'completed'], wrongState: '只有已归档记录可以恢复',
        build(req, old) {
            const status = old.previousStatus === 'revoked' ? 'revoked' : 'published';
            return { status, extra: { unarchivedAt: new Date().toISOString(), unarchivedBy: me(req) }, action: 'unarchive', note: `恢复为${status === 'published' ? '已发布' : '已撤销'}` };
        },
    });

    const clearArchived = async (req) => {
        if (!isAdmin(req)) fail('仅管理员可彻底删除已归档记录', 403);
        const result = await repo.clearArchived(req.query?.category || req.body?.category);
        for (const item of result.items) await repo.deleteEvidenceFiles(PREFIX, item.attachments);
        return { success: true, count: result.count };
    };
    fastify.delete('/applications/archived', clearArchived);
    fastify.delete('/archived', clearArchived);
    fastify.delete('/applications/:id', async (req) => {
        const old = await repo.application(req.params.id);
        if (!old) fail('申请不存在', 404);
        if (old.status === 'draft') {
            if (!owner(req, old)) fail('申请不存在或无权删除', 403);
        } else if (old.status === 'archived' || old.status === 'completed') {
            if (!isAdmin(req)) fail('仅管理员可彻底删除已归档记录', 403);
        } else {
            fail('只能删除草稿或已归档记录', 409);
        }
        await repo.deleteEvidenceFiles(PREFIX, old.attachments);
        return repo.remove(old.id);
    });

    fastify.post('/applications/:id/decision', async (req) => {
        if (!isAdmin(req)) fail('仅管理员可记录审批结果', 403);
        const old = await repo.application(req.params.id);
        if (!old) fail('申请不存在', 404);
        const action = label(req.body?.action, 30);
        const note = label(req.body?.note, 1000);
        const flow = old.ruleSnapshot?.approvalFlow || ['department', 'at', 'publicity'];
        const stages = ['submitted', ...flow.map((step) => (step === 'publicity' ? 'publicity' : `${step}_approved`)), 'completed'];
        const move = (status, verb) => repo.update(old.id, revision(req.body), me(req), { category: old.category, ruleId: old.ruleId, status, payload: old }, verb, note);
        if (action === 'return' || action === 'reject') {
            if (['draft', 'returned', 'rejected', 'completed'].includes(old.status)) fail('当前状态不能退回或驳回', 409);
            if (!note) fail('退回或驳回必须填写原因');
            return move(action === 'return' ? 'returned' : 'rejected', action);
        }
        if (action !== 'approve') fail('审批动作无效');
        const index = stages.indexOf(old.status);
        if (index < 0 || index >= stages.length - 1) fail('当前状态不能推进审批', 409);
        if (stages[index + 1] === 'at_approved' && !note) fail('请记录 AT 评议结论或会议依据');
        return move(stages[index + 1], 'approve');
    });

    fastify.put('/rules/:id', async (req) => {
        if (!isAdmin(req)) fail('仅管理员可维护奖励规则', 403);
        const body = req.body || {};
        const previous = (await repo.rules()).find((item) => item.id === req.params.id);
        const category = label(body.category || previous?.category, 30);
        if (!CATEGORIES.includes(category)) fail('奖励类别无效');
        const name = label(body.name);
        if (!name) fail('奖项名称不能为空');
        const amount = (value, message) => {
            const parsed = value === '' || value == null ? null : Number(value);
            if (parsed !== null && !money(parsed)) fail(message);
            return parsed;
        };
        const referenceBudgetMinor = amount(body.referenceBudgetMinor, '参考预算无效');
        const unitAmountMinor = amount(body.unitAmountMinor, '单人金额无效');
        const approvalFlow = Array.isArray(body.approvalFlow) ? body.approvalFlow : previous?.approvalFlow || ['department', 'at', 'publicity'];
        if (!approvalFlow.length || approvalFlow[0] !== 'department' || approvalFlow.join(',') !== ['department', 'at', 'publicity'].filter((step) => approvalFlow.includes(step)).join(',')) fail('审批流程无效');
        return repo.saveRule({
            id: previous?.id || req.params.id || crypto.randomUUID(), category, name, cycle: label(body.cycle, 80),
            recipientType: body.recipientType === 'team' ? 'team' : 'person', positionName: label(body.positionName), criteria: label(body.criteria, 1000),
            unitAmountMinor, referenceBudgetMinor, currency: body.currency === 'CNY' ? 'CNY' : 'EGP', approvalFlow, archived: Boolean(body.archived),
        }, me(req));
    });
    fastify.delete('/rules/:id', async (req) => {
        if (!isAdmin(req)) fail('仅管理员可维护奖励规则', 403);
        return repo.deleteRule(req.params.id, me(req));
    });

    fastify.all('/snapshot/*', async (_req, reply) => reply.code(404).send({ error: '基座 Web 版不提供「发布成静态页面」，请直接在平台里查看' }));
}
