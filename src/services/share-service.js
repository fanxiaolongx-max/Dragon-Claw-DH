// 共享对话（基座版）：所有人在同一个应用库里，共享就是让成员直接进入同一个对话——没有副本、不需要同步。
// - 共享关系、成员、常用群组、最近共享、见过的账号都存在 biz_records（不新建表）。
// - 每条消息在 meta 里记 author（发消息的人；AI 回答记提问的人）；读消息时别人发的带 { type: 'shared_author' } 事件，
//   前端据此标注账号。没有 author 的旧消息算发起者的。
// - 新的提问按发送者本人的身份执行（工具权限、数据权限都按本人），同一时间只允许一个人在这段对话里提问。
// - 邀请时经基座通知接口给对方发一条应用消息（带跳转链接），失败不影响邀请本身。
// 接口与主线版 /api/shared-conversations 一致，前端共用同一份 shared-conversations.js。
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { BusinessError } from '../core/errors.js';
import { isSameUserId, listAdmins } from '../core/access.js';
import { kvGet, sendBaseNotify } from '../dao/scoped.js';
import { listRecords, getRecord, putRecord, deleteRecord } from './record-store.js';
import { getSession, saveSession, listMessages } from './ai-service.js';
import { appendQuestionContext } from './conversation-service.js';
import { listSkills } from './skill-service.js';
import { pushAlert } from './alert-service.js';
import { enabledTools } from './tool-catalog-service.js';
import { pushLog } from '../core/log-ring.js';

const K = { share: 'share', member: 'share_member', group: 'share_group', recent: 'share_recent', user: 'share_user', skillGrant: 'share_skill_grant' };
const SKILL_MENTION_RE = /(?<![A-Za-z0-9_.\/@-])@([a-z][a-z0-9-]{1,40})\b/g;
const ADMIN_ONLY_TOOLS = new Set([
    'insert_database_row', 'update_database_rows', 'delete_database_rows', 'send_notification',
    'move_uiv_script', 'delete_uiv_script', 'sla_update_metric_conditions', 'sla_revert_metric_rule_change',
]);
const MAX_MEMBERS = 200;
const TURN_TTL_MS = 5 * 60_000;
const fail = (message, code = 400) => { throw new BusinessError(message, code); };
const clean = (v, n = 120) => String(v || '').trim().slice(0, n);

/** 工号的规范形式：去掉可选的首字母（z00569258 与 00569258、dwx1545337 与 wx1545337 视为同一人），其余账号原样小写 */
export function userKey(u) {
    const s = String(u || '').trim().toLowerCase();
    const m = /^[a-z]?(wx\d{4,}|\d{4,})$/.exec(s);
    return m ? m[1] : s;
}
const same = (a, b) => userKey(a) === userKey(b) || isSameUserId(a, b);
const memberId = (shareId, user) => `${shareId}:${userKey(user)}`;
const cleanTitle = (raw) => String(raw || '').replace(/\[([^\]]*)\]\(<[^>]*>\)/g, '$1').replace(/\s*\[[^\]]*$/, '').replace(/\s+/g, ' ').trim().slice(0, 160);

// ── 账号目录：底座只告诉应用「当前是谁」，没有员工通讯录 —— 用过本应用的人 + 一键催办里用过的人 ──
const seen = new Map();
export async function rememberUser(identity) {
    if (!identity?.identified || !identity.username) return;
    const key = userKey(identity.username);
    const name = clean(identity.displayName) || identity.username;
    const last = seen.get(key);
    if (last && last.name === name && Date.now() - last.at < 3600_000) return;
    seen.set(key, { name, at: Date.now() });
    // 有的入口只带工号、不带姓名：不要用工号覆盖之前记下的真实姓名
    if (name === identity.username) {
        const existing = await getRecord(K.user, key).catch(() => null);
        if (existing?.payload?.name && existing.payload.name !== identity.username) { seen.set(key, { name: existing.payload.name, at: Date.now() }); return; }
    }
    await putRecord(K.user, { id: key, name, sortKey: String(Date.now()).padStart(15, '0'), payload: { username: identity.username, name }, updatedBy: identity.username }).catch(() => {});
}

async function directory() {
    const map = new Map();
    for (const rec of await listRecords(K.user, { withPayload: true, limit: 1000 })) {
        const p = rec.payload || {};
        const seenAt = Number(rec.sortKey) || (rec.updatedAt ? Date.parse(rec.updatedAt) : 0) || 0;
        if (p.username) map.set(userKey(p.username), { username: p.username, name: p.name || p.username, seenAt });
    }
    try {
        const dir = await kvGet('expedite_notify_directory', {});
        for (const item of Array.isArray(dir?.history) ? dir.history : []) {
            const id = clean(item?.id);
            if (id && !map.has(userKey(id))) map.set(userKey(id), { username: id, name: clean(item.name) || id, seenAt: 0 });
        }
    } catch { /* 催办名录读不到不影响 */ }
    return map;
}
async function nameOf(user, dir) {
    const d = dir || await directory();
    return d.get(userKey(user))?.name || user;
}

export async function listKnownUsers() {
    return [...(await directory()).values()];
}

export async function accounts(me, query = '') {
    const q = String(query || '').trim().toLowerCase().slice(0, 64);
    const list = [...(await directory()).values()].filter((u) => !same(u.username, me));
    // 拼音：桌面版前端的共享拼音库也随 static 发布，服务端直接复用（移动端没有拼音库）
    let pinyin = null;
    if (q) {
        try { pinyin = (await import('../../static/js/shared/pinyin-search.js')).default; } catch { pinyin = null; }
    }
    const hit = (u) => !q || u.username.toLowerCase().includes(q) || u.name.toLowerCase().includes(q)
        || Boolean(pinyin?.isPinyinQuery?.(q) && pinyin.pinyinMatches(u.name, q));
    return list.filter(hit).sort((a, b) => a.username.localeCompare(b.username, undefined, { numeric: true }));
}

// ── 共享与成员 ──
async function getShare(shareId) {
    const rec = await getRecord(K.share, shareId);
    return rec?.payload ? { ...rec.payload, id: rec.id } : null;
}
async function shareBySession(sessionId) {
    const rec = (await listRecords(K.share, { group: String(sessionId || ''), withPayload: true, limit: 1 }))[0];
    return rec?.payload ? { ...rec.payload, id: rec.id } : null;
}
async function saveShare(share) {
    await putRecord(K.share, { id: share.id, group: share.sessionId, name: share.title, hash: share.linkToken, sortKey: String(Date.now()).padStart(15, '0'), payload: share, updatedBy: share.owner });
    return share;
}
async function members(shareId) {
    const rows = await listRecords(K.member, { withPayload: true, limit: 1000, maxRows: 5000 });
    return rows.map((r) => r.payload).filter((m) => m && m.shareId === shareId);
}
async function getMember(shareId, user) {
    const rec = await getRecord(K.member, memberId(shareId, user));
    return rec?.payload || null;
}
async function saveMember(m) {
    await putRecord(K.member, { id: memberId(m.shareId, m.username), group: userKey(m.username), name: m.name, sortKey: String(m.invitedAt || Date.now()).padStart(15, '0'), payload: m, updatedBy: m.invitedBy || m.username });
    return m;
}
async function myMemberships(user) {
    return (await listRecords(K.member, { group: userKey(user), withPayload: true, limit: 500 })).map((r) => r.payload).filter(Boolean);
}

/** 我作为成员加入、仍有效的共享对话的会话号（不含自己发起的）：查自己的历史对话时用 */
export async function memberSessionIds(user) {
    const ids = [];
    for (const m of await myMemberships(user)) {
        if (m.status !== 'accepted') continue;
        const share = await getShare(m.shareId);
        if (share?.status === 'active' && share.sessionId) ids.push(String(share.sessionId));
    }
    return [...new Set(ids)];
}

/** 对话的访问权：发起者本人，或已接受邀请的成员（共享仍有效）。返回 { session, share, role } 或 null */
export async function sessionAccess(sessionId, user) {
    const session = await getSession(String(sessionId || ''));
    if (!session) return null;
    if (same(session.owner, user)) return { session, share: await shareBySession(session.id), role: 'owner' };
    const share = await shareBySession(session.id);
    if (!share || share.status !== 'active') return null;
    const m = await getMember(share.id, user);
    return m?.status === 'accepted' ? { session, share, role: 'member' } : null;
}

async function describe(share, me) {
    const dir = await directory();
    const list = (await members(share.id)).filter((m) => !['left', 'removed'].includes(m.status));
    const all = [{ username: share.owner, role: 'owner', status: 'accepted', via: 'owner' }, ...list.filter((m) => !same(m.username, share.owner))];
    const msgs = await listMessages(share.sessionId);
    return {
        id: share.id,
        title: share.title,
        status: share.status,
        owner: share.owner,
        ownerName: dir.get(userKey(share.owner))?.name || share.owner,
        isOwner: same(share.owner, me),
        link: `/?share=${encodeURIComponent(share.linkToken)}`,
        createdAt: new Date(share.createdAt).toISOString(),
        updatedAt: new Date(msgs.at(-1)?.created_at || share.createdAt).toISOString(),
        messageCount: msgs.length,
        sessionId: share.sessionId,
        role: same(share.owner, me) ? 'owner' : 'member',
        myStatus: same(share.owner, me) ? 'accepted' : (list.find((m) => same(m.username, me))?.status || ''),
        members: all.map((m) => ({ username: m.username, name: dir.get(userKey(m.username))?.name || m.name || m.username, role: m.role, status: m.status, via: m.via })),
    };
}

export async function ensureShare({ user, sessionId, title }) {
    const access = await sessionAccess(sessionId, user);
    if (!access) fail('对话不存在', 404);
    let share = access.share;
    const t = cleanTitle(title) || cleanTitle(access.session.title) || '共享对话';
    if (!share || share.status !== 'active') {
        // Each sharing period has its own members, invitations and link.
        share = await saveShare({ id: `shr_${crypto.randomBytes(9).toString('base64url')}`, sessionId: access.session.id, owner: access.session.owner, title: t, linkToken: crypto.randomBytes(18).toString('base64url'), status: 'active', createdAt: Date.now() });
    }
    if (access.role === 'owner' && t !== share.title) share = await saveShare({ ...share, title: t });
    return share;
}

export async function shareForSession({ user, sessionId, identity = null }) {
    const access = await sessionAccess(sessionId, user);
    if (access?.share?.status !== 'active') return null;
    const base = await describe(access.share, user);
    const idObj = identity || { username: user, isAdmin: false, isSuper: false };
    const caps = await sessionCapabilities({ identity: idObj, sessionId, _access: access }).catch(() => ({ skills: [], tools: [], aliases: {}, pendingForMe: [] }));
    return {
        ...base,
        missingCapabilities: { skills: caps.skills, tools: caps.tools },
        skillAliases: caps.aliases,
        pendingSkillRequests: caps.pendingForMe,
    };
}

export async function invite({ user, sessionId, title, usernames = [], groupIds = [], linkBase = '' }) {
    const share = await ensureShare({ user, sessionId, title });
    const dir = await directory();
    const targets = new Map();
    for (const raw of Array.isArray(usernames) ? usernames : []) {
        const u = clean(raw, 64);
        if (u && /^[A-Za-z0-9_.@-]{2,64}$/.test(u)) targets.set(userKey(u), dir.get(userKey(u))?.username || u);
        else if (u) fail(`账号格式不对：${u}`);
    }
    const groups = [];
    for (const gid of (Array.isArray(groupIds) ? groupIds : []).slice(0, 20)) {
        const rec = await getRecord(K.group, String(gid));
        if (!rec?.payload || !same(rec.payload.owner, user)) continue;
        groups.push(rec);
        for (const m of rec.payload.members || []) targets.set(userKey(m), dir.get(userKey(m))?.username || m);
    }
    for (const key of [...targets.keys()]) if (same(targets.get(key), user) || same(targets.get(key), share.owner)) targets.delete(key);
    const existing = await members(share.id);
    if (existing.filter((m) => ['accepted', 'pending'].includes(m.status)).length + targets.size > MAX_MEMBERS) fail(`一个共享对话最多 ${MAX_MEMBERS} 人`);
    const invited = [];
    const already = [];
    const inviterName = await nameOf(user, dir);
    for (const target of targets.values()) {
        const prev = existing.find((m) => same(m.username, target));
        if (prev && ['accepted', 'pending'].includes(prev.status)) { already.push(target); continue; }
        await saveMember({ shareId: share.id, username: target, name: dir.get(userKey(target))?.name || '', role: 'member', status: 'pending', invitedBy: user, via: 'invite', invitedAt: Date.now(), respondedAt: 0, lastReadAt: 0 });
        invited.push(target);
    }
    await touchRecent(user, 'user', [...targets.values()]);
    if (groups.length) await touchRecent(user, 'group', groups.map((g) => g.id));
    // 经基座通知接口给被邀请的人发应用消息（带跳转链接）；本地内存模式下接口自动模拟
    const jump = /^https?:\/\//i.test(String(linkBase || '')) ? `${String(linkBase).replace(/\/+$/, '')}/?share=${encodeURIComponent(share.linkToken)}` : '';
    const notified = [];
    for (const target of invited) {
        try {
            const res = await sendBaseNotify({
                module_type: 'digitalHumanOperations',
                sub_module_type: 'writeReport',
                msg_type: '2',
                app_msg_params: {
                    title: `【Dragon Claw】${inviterName} 邀请你加入共享对话`,
                    content: `「${share.title}」——打开应用即可接受，之后可以接着这段对话继续提问。`,
                    to_user_account: target,
                    type: '1',
                    ...(jump ? { jump_url: jump } : {}),
                },
            });
            if (res?.code === 0 || res?.data?.success) notified.push(target);
        } catch (error) {
            pushLog({ level: 'WARN', category: 'SHARE', message: `共享邀请通知发送失败（${target}）：${error.message}`, userId: user });
        }
    }
    return { share: await describe(share, user), invited, already, notified };
}

export async function inbox(user) {
    const dir = await directory();
    const items = [];
    for (const m of await myMemberships(user)) {
        if (m.status !== 'pending') continue;
        const share = await getShare(m.shareId);
        if (!share || share.status !== 'active') continue;
        const all = await members(share.id);
        items.push({
            shareId: share.id, title: share.title, owner: share.owner, ownerName: dir.get(userKey(share.owner))?.name || share.owner,
            invitedBy: m.invitedBy, invitedByName: dir.get(userKey(m.invitedBy))?.name || m.invitedBy,
            invitedAt: new Date(m.invitedAt).toISOString(), via: m.via,
            messageCount: (await listMessages(share.sessionId)).length,
            memberCount: 1 + all.filter((x) => x.status === 'accepted').length,
        });
    }
    return items.sort((a, b) => String(b.invitedAt).localeCompare(String(a.invitedAt)));
}

export async function respond({ user, shareId, action }) {
    if (!['accept', 'decline', 'ignore'].includes(action)) fail('无效的操作');
    const share = await getShare(shareId);
    const m = share && await getMember(share.id, user);
    if (!share || !m || ['left', 'removed'].includes(m.status)) fail('邀请不存在或已失效', 404);
    if (share.status !== 'active') fail('发起者已停止共享这个对话', 409);
    if (action === 'accept') {
        await saveMember({ ...m, status: 'accepted', respondedAt: Date.now(), lastReadAt: Date.now() });
        return { status: 'accepted', sessionId: share.sessionId, share: await describe(share, user) };
    }
    if (m.status === 'accepted') return { status: 'accepted', sessionId: share.sessionId };
    await saveMember({ ...m, status: action === 'decline' ? 'declined' : 'ignored', respondedAt: Date.now() });
    if (action === 'decline') {
        const dir = await directory().catch(() => new Map());
        const actorName = dir.get(userKey(user))?.name || user;
        const targets = [...new Set([share.owner, m.invitedBy].filter((u) => u && !same(u, user)))];
        if (targets.length) {
            await pushAlert(targets, {
                type: 'user_action',
                severity: 'warn',
                title: `【Dragon Claw】${actorName} 拒绝了共享对话邀请`,
                message: `${actorName}（${user}）已拒绝加入共享对话「${share.title}」。`,
                source: 'shared-conversation',
                actor: user,
                objectType: 'shared_conversation',
                objectId: share.id,
                detail: { shareId: share.id, sessionId: share.sessionId, title: share.title, action: 'decline' },
            }, { allowDuplicate: true }).catch(() => {});
        }
    }
    return { status: action === 'decline' ? 'declined' : 'ignored' };
}

export async function joinByLink({ user, token }) {
    const rec = (await listRecords(K.share, { withPayload: true, limit: 1000 })).find((r) => r.payload?.linkToken === String(token || ''));
    const share = rec ? { ...rec.payload, id: rec.id } : null;
    if (!share) fail('共享链接无效或已失效', 404);
    if (share.status !== 'active') fail('发起者已停止共享这个对话', 409);
    if (same(share.owner, user)) return { status: 'accepted', shareId: share.id, sessionId: share.sessionId };
    const m = await getMember(share.id, user);
    if (m?.status === 'accepted') return { status: 'accepted', shareId: share.id, sessionId: share.sessionId };
    await saveMember({ shareId: share.id, username: user, name: '', role: 'member', status: 'pending', invitedBy: m?.invitedBy || share.owner, via: 'link', invitedAt: Date.now(), respondedAt: 0, lastReadAt: m?.lastReadAt || 0 });
    return { status: 'pending', shareId: share.id, invite: (await inbox(user)).find((i) => i.shareId === share.id) };
}

/** 我参与的共享对话（发起者没邀请到任何人时不算）；unread = 上次打开之后别人发的消息数 */
export async function listMine(user) {
    const out = [];
    const seenShares = new Set();
    const collect = async (share, lastReadAt) => {
        if (!share || share.status !== 'active' || seenShares.has(share.id) || !(await getSession(share.sessionId))) return;
        seenShares.add(share.id);
        const d = await describe(share, user);
        if (d.isOwner && !d.members.some((m) => !same(m.username, user) && ['accepted', 'pending'].includes(m.status))) return;
        const msgs = await listMessages(share.sessionId);
        const unread = msgs.filter((x) => Number(x.created_at) > Number(lastReadAt || 0) && !same(x.author || share.owner, user)).length;
        out.push({ ...d, unread });
    };
    for (const m of await myMemberships(user)) {
        if (m.status !== 'accepted') continue;
        await collect(await getShare(m.shareId), m.lastReadAt);
    }
    for (const rec of await listRecords(K.share, { withPayload: true, limit: 1000 })) {
        if (rec.payload && same(rec.payload.owner, user)) {
            const readKey = await getRecord(K.member, memberId(rec.id, user));
            await collect({ ...rec.payload, id: rec.id }, readKey?.payload?.lastReadAt || 0);
        }
    }
    return out;
}

/** 打开 / 轮询：返回上次之后别人发的新消息数，并记为已读（基座版没有副本，不需要真正同步） */
export async function markRead({ user, sessionId }) {
    const access = await sessionAccess(sessionId, user);
    if (!access?.share) return null;
    const share = access.share;
    const prev = await getMember(share.id, user);
    const msgs = await listMessages(share.sessionId);
    const since = Number(prev?.lastReadAt || 0);
    const pulled = msgs.filter((x) => Number(x.created_at) > since && !same(x.author || share.owner, user)).length;
    const base = prev || { shareId: share.id, username: user, name: '', role: 'owner', status: 'accepted', invitedBy: user, via: 'owner', invitedAt: share.createdAt };
    if (pulled || !prev) await saveMember({ ...base, lastReadAt: Date.now() });
    const live = getLiveStream(sessionId);
    const activeTurn = live ? { by: live.by, name: live.name, question: live.question } : null;
    return { shareId: share.id, pushed: 0, pulled, closed: share.status !== 'active', revoked: share.status !== 'active' && !same(share.owner, user), activeTurn };
}

export async function leave({ user, sessionId }) {
    const access = await sessionAccess(sessionId, user);
    if (!access?.share) fail('这个对话没有共享', 404);
    const share = access.share;
    if (access.role === 'owner') {
        await saveShare({ ...share, status: 'closed' });
        kickLiveViewers(sessionId);
        return { closed: true };
    }
    const m = await getMember(share.id, user);
    await saveMember({ ...m, status: 'left', respondedAt: Date.now() });
    kickLiveViewers(sessionId, user);
    return { left: true };
}

export async function removeMember({ user, sessionId, target }) {
    const access = await sessionAccess(sessionId, user);
    if (!access?.share || access.role !== 'owner') fail('只有发起者可以移除成员', 403);
    if (same(target, user)) fail('不能移除自己，请使用「停止共享」');
    const m = await getMember(access.share.id, target);
    if (m) await saveMember({ ...m, status: 'removed', respondedAt: Date.now() });
    kickLiveViewers(sessionId, target);
    return describe(access.share, user);
}

// ── 常用群组与最近使用 ──
export async function listGroups(user) {
    return (await listRecords(K.group, { group: userKey(user), withPayload: true, limit: 100 }))
        .map((r) => ({ id: r.id, name: r.payload?.name || r.name, members: r.payload?.members || [], usedAt: r.payload?.usedAt || null, createdAt: r.createdAt }));
}
export async function saveGroup(user, { id, name, members: list }) {
    const n = clean(name, 40);
    if (!n) fail('请填写群组名称');
    const dir = await directory();
    const ms = [...new Set((Array.isArray(list) ? list : []).map((x) => clean(x, 64)).filter((x) => x && !same(x, user)))]
        .map((x) => dir.get(userKey(x))?.username || x).slice(0, MAX_MEMBERS);
    if (!ms.length) fail('群组至少需要一位成员');
    if (!id && (await listGroups(user)).length >= 100) fail('最多保存 100 个常用群组');
    const gid = id || `grp_${crypto.randomBytes(9).toString('base64url')}`;
    if (id) {
        const rec = await getRecord(K.group, id);
        if (!rec?.payload || !same(rec.payload.owner, user)) fail('群组不存在', 404);
    }
    await putRecord(K.group, { id: gid, group: userKey(user), name: n, sortKey: String(Date.now()).padStart(15, '0'), payload: { owner: user, name: n, members: ms }, updatedBy: user });
    return (await listGroups(user)).find((g) => g.id === gid);
}
export async function deleteGroup(user, id) {
    const rec = await getRecord(K.group, String(id));
    if (rec?.payload && same(rec.payload.owner, user)) await deleteRecord(K.group, rec.id);
}
async function touchRecent(user, kind, targets) {
    if (!targets.length) return;
    const rec = await getRecord(K.recent, userKey(user));
    const data = rec?.payload || { users: {}, groups: {} };
    const bucket = kind === 'group' ? (data.groups ||= {}) : (data.users ||= {});
    for (const t of targets) {
        const k = kind === 'group' ? t : userKey(t);
        bucket[k] = { id: t, uses: (bucket[k]?.uses || 0) + 1, at: Date.now() };
    }
    await putRecord(K.recent, { id: userKey(user), payload: data, updatedBy: user });
    if (kind === 'group') {
        for (const gid of targets) {
            const g = await getRecord(K.group, gid);
            if (g?.payload) await putRecord(K.group, { id: g.id, group: g.group, name: g.name, sortKey: String(Date.now()).padStart(15, '0'), payload: { ...g.payload, usedAt: new Date().toISOString() }, updatedBy: user });
        }
    }
}
/** 智能提示：用过的次数 + 最近 30 天内的新近程度 */
export async function recent(user) {
    const rec = await getRecord(K.recent, userKey(user));
    const data = rec?.payload || { users: {}, groups: {} };
    const score = (x) => (x.uses || 0) + Math.max(0, 30 - (Date.now() - (x.at || 0)) / 86400000) / 3;
    const dir = await directory();
    const groups = await listGroups(user);
    return {
        users: Object.values(data.users || {}).sort((a, b) => score(b) - score(a)).slice(0, 8)
            .map((x) => ({ username: dir.get(userKey(x.id))?.username || x.id, name: dir.get(userKey(x.id))?.name || x.id, uses: x.uses })),
        groups: Object.values(data.groups || {}).sort((a, b) => score(b) - score(a)).map((x) => groups.find((g) => g.id === x.id)).filter(Boolean).slice(0, 5),
    };
}

// ── 对话里的配套：署名、同一时间一个人提问、给模型的历史 ──

/** 读消息：别人发的（含别人提问得到的 AI 回答）带 shared_author 事件 */
export async function decorateMessages(items, { share, ownerId, viewer }) {
    if (!share) return items;
    const dir = await directory();
    return items.map((m) => {
        const author = m.author || ownerId;
        if (same(author, viewer)) return m;
        const events = Array.isArray(m.events) ? m.events : [];
        return { ...m, events: [...events, { type: 'shared_author', author, name: dir.get(userKey(author))?.name || author }] };
    });
}

// ── 共享对话实时流广播（多端同步围观正在生成的回答） ──
// 只存在本进程内存：提问者与围观者需连到同一个应用实例（当前单实例部署）。
// 多实例时退化为：输入框仍按 metadata.activeTurn 锁定，回答完成后靠 /sync 拉取落库消息。
const LIVE_MAX_EVENTS = 200;          // 追流时补发的过程事件上限（只留最近的）
const LIVE_FIELD_MAX = 4000;          // 补发事件里单个字段的最大长度
const TURN_HEARTBEAT_MS = 60_000;     // 长任务期间每分钟续期一次 activeTurn，免得 5 分钟后被别人插队
const liveHub = new Map();
const liveEmitter = new EventEmitter();
liveEmitter.setMaxListeners(500);
const emitLive = (sid, event) => liveEmitter.emit(`live:${sid}`, event);

function compactLiveEvent(event) {
    const out = {};
    for (const [k, v] of Object.entries(event || {})) {
        if (typeof v === 'string') out[k] = v.length > LIVE_FIELD_MAX ? `${v.slice(0, LIVE_FIELD_MAX)}…` : v;
        else if (v && typeof v === 'object') {
            let json = '';
            try { json = JSON.stringify(v); } catch { json = ''; }
            out[k] = json.length > LIVE_FIELD_MAX ? `${json.slice(0, LIVE_FIELD_MAX)}…` : v;
        } else out[k] = v;
    }
    return out;
}

function touchLive(stream) {
    const now = Date.now();
    stream.touchedAt = now;
    if (now - stream.heartbeatAt < TURN_HEARTBEAT_MS) return;
    stream.heartbeatAt = now;
    (async () => {
        const fresh = await getSession(stream.sessionId);
        const turn = fresh?.metadata?.activeTurn;
        if (!turn || !same(turn.by, stream.by) || liveHub.get(stream.sessionId) !== stream) return;
        await saveSession({ id: stream.sessionId, title: fresh.title, summary: fresh.summary, archived: fresh.archived, pinned: fresh.pinned, metadata: { activeTurn: { ...turn, at: now } } });
    })().catch(() => {});
}

export function startLiveStream(sessionId, { by, name, question }) {
    if (!sessionId) return;
    const sid = String(sessionId);
    const now = Date.now();
    const stream = { sessionId: sid, by, name: name || by, question: String(question || '').trim(), startedAt: now, touchedAt: now, heartbeatAt: now, fullText: '', events: [] };
    liveHub.set(sid, stream);
    emitLive(sid, { type: 'stream_start', sessionId: sid, by: stream.by, name: stream.name, question: stream.question });
}

export function pushLiveDelta(sessionId, delta) {
    if (!sessionId || !delta) return;
    const sid = String(sessionId);
    const stream = liveHub.get(sid);
    if (!stream) return;
    stream.fullText += delta;
    touchLive(stream);
    emitLive(sid, { type: 'delta', delta });
}

export function pushLiveEvent(sessionId, event) {
    if (!sessionId || !event?.type || ['ping', 'delta', 'done'].includes(event.type)) return;
    const sid = String(sessionId);
    const stream = liveHub.get(sid);
    if (!stream) return;
    stream.events.push(compactLiveEvent(event));
    if (stream.events.length > LIVE_MAX_EVENTS) stream.events.splice(0, stream.events.length - LIVE_MAX_EVENTS);
    touchLive(stream);
    emitLive(sid, event);
}

/** 结束这一轮实时流；给了 by 时只结束这个人发起的那一轮（别人的请求收尾不能把正在进行的流掐掉） */
export function endLiveStream(sessionId, { error = '' } = {}, by = null) {
    if (!sessionId) return;
    const sid = String(sessionId);
    const stream = liveHub.get(sid);
    if (!stream || (by && !same(stream.by, by))) return;
    liveHub.delete(sid);
    emitLive(sid, { type: 'stream_finish', ...(error ? { error } : {}), text: stream.fullText });
    emitLive(sid, { type: 'turn_ended', sessionId: sid });
}

export function getLiveStream(sessionId) {
    if (!sessionId) return null;
    const sid = String(sessionId);
    const stream = liveHub.get(sid);
    if (!stream) return null;
    // 按最后一次输出判断失联，长任务只要还在出事件就一直有效
    if (Date.now() - stream.touchedAt > TURN_TTL_MS) {
        liveHub.delete(sid);
        emitLive(sid, { type: 'turn_ended', sessionId: sid, stale: true });
        return null;
    }
    return stream;
}

/** 订阅一段共享对话的实时事件；成员被移除、退出或共享被停止时收到 { type: 'revoked' } */
export function subscribeSharedEvents(sessionId, listener, user = null) {
    if (!sessionId) return () => {};
    const sid = String(sessionId);
    const onKick = (target) => { if (!target || (user && same(target, user))) listener({ type: 'revoked' }); };
    liveEmitter.on(`live:${sid}`, listener);
    liveEmitter.on(`kick:${sid}`, onKick);
    return () => { liveEmitter.off(`live:${sid}`, listener); liveEmitter.off(`kick:${sid}`, onKick); };
}
const kickLiveViewers = (sessionId, target = null) => liveEmitter.emit(`kick:${String(sessionId)}`, target);

/** 共享对话同一时间只让一个人提问：记在会话 metadata 里（多实例也能看到），5 分钟没有任何进展视为已失效 */
export async function claimTurn(session, user, name, question = '') {
    const live = getLiveStream(session.id);
    if (live && !same(live.by, user)) {
        fail(`${live.name || live.by} 正在这段共享对话里提问，请等这一轮回答完成后再发送`, 409);
    }
    const fresh = await getSession(session.id);
    const turn = fresh?.metadata?.activeTurn;
    if (turn && !same(turn.by, user) && Date.now() - Number(turn.at || 0) < TURN_TTL_MS) {
        fail(`${turn.name || turn.by} 正在这段共享对话里提问，请等这一轮回答完成后再发送`, 409);
    }
    await saveSession({ id: session.id, title: fresh.title, summary: fresh.summary, archived: fresh.archived, pinned: fresh.pinned, metadata: { activeTurn: { by: user, name: name || user, at: Date.now(), question: clean(question, 400) } } });
}
export async function releaseTurn(sessionId, user) {
    endLiveStream(sessionId, {}, user);
    const fresh = await getSession(sessionId);
    const turn = fresh?.metadata?.activeTurn;
    if (!turn || !same(turn.by, user)) return;
    await saveSession({ id: sessionId, title: fresh.title, summary: fresh.summary, archived: fresh.archived, pinned: fresh.pinned, metadata: { activeTurn: null } });
}

const sharedToolLabel = (dir, author) => {
    const name = dir.get(userKey(author))?.name || '';
    return name && !same(name, author) ? `${name} (${author})` : (name || author);
};

function messageMentions(msg, patterns = []) {
    const hay = `${String(msg?.content || '')}\n${Array.isArray(msg?.events) ? JSON.stringify(msg.events) : String(msg?.events || '')}`;
    return patterns.some((p) => hay.includes(p));
}

function summarizeMessageResources(msg) {
    const text = String(msg?.content || '');
    const events = Array.isArray(msg?.events) ? msg.events : [];
    const attachments = new Set();
    const tools = new Set();
    for (const m of text.matchAll(/\(<?(uploads\/[a-z0-9]{8,40}\/[^)>\s]+)>?\)/gi)) attachments.add(m[1]);
    for (const m of text.matchAll(/\/custom-tools\/([a-z0-9-]+)\//gi)) tools.add(m[1]);
    for (const ev of events) {
        if (!ev || typeof ev !== 'object') continue;
        if (ev.type === 'tool_start' && ev.args) {
            if (typeof ev.args.path === 'string' && /^uploads\//i.test(ev.args.path)) attachments.add(ev.args.path);
            if (ev.tool === 'publish_html_tool' && ev.args.slug) tools.add(String(ev.args.slug));
        }
        if (ev.type === 'tool_result' && ev.tool === 'publish_html_tool' && ev.ok && ev.summary) {
            // 保留已发布工具的说明，便于后续成员继续优化
            const sum = String(ev.summary).trim();
            if (sum) tools.add(sum);
        }
    }
    const notes = [];
    if (attachments.size) notes.push(`[本条消息可用附件：${[...attachments].join('、')}]`);
    if (tools.size) notes.push(`[本条消息关联自定义工具：${[...tools].join('、')}]`);
    return notes.join('\n');
}

/** 给模型的历史：取库里最近的消息（成员之间不一定都在页面上看到了最新的），别人发言与回复均标注账号并附共享文件/工具索引 */
export async function sharedHistory(sessionId, { ownerId, viewer, limit = 30 }) {
    const dir = await directory();
    return (await listMessages(sessionId)).slice(-limit).map((m) => {
        const author = m.author || ownerId;
        const role = m.role === 'user' ? 'user' : 'assistant';
        let content = String(m.content || '')
            .replace(/\n{0,2}（\s*本轮调用工具\s*\d+\s*次：[^）\n]*）\s*$/u, '')
            .trimEnd();
        if (role === 'assistant') content = appendQuestionContext(content, m.events);
        const extra = summarizeMessageResources(m);
        if (extra) content = `${content}${content ? '\n' : ''}${extra}`;
        if (!same(author, viewer)) {
            const who = sharedToolLabel(dir, author);
            content = `【共享对话成员 ${who}${role === 'assistant' ? ' 收到的 AI 回复' : ' 的提问'}】\n${content}`;
        }
        return { role, content };
    }).filter((m) => m.content.trim());
}

async function activeSharesForViewer(viewer, uploaderId) {
    const shares = [];
    const seenIds = new Set();
    for (const m of await myMemberships(viewer)) {
        if (m.status !== 'accepted') continue;
        const s = await getShare(m.shareId);
        if (s && s.status === 'active' && !seenIds.has(s.id)) { seenIds.add(s.id); shares.push(s); }
    }
    for (const rec of await listRecords(K.share, { withPayload: true, limit: 1000 })) {
        if (rec.payload && rec.payload.status === 'active' && same(rec.payload.owner, viewer) && !seenIds.has(rec.id)) {
            seenIds.add(rec.id);
            shares.push({ ...rec.payload, id: rec.id });
        }
    }
    const matched = [];
    for (const share of shares) {
        if (same(share.owner, uploaderId)) { matched.push(share); continue; }
        const up = await getMember(share.id, uploaderId);
        if (up?.status === 'accepted') matched.push(share);
    }
    return matched;
}

/** 别人的对话附件：出现在 viewer 能访问的共享对话的消息正文或工具事件里时才可读（共享的是上下文，含历史里的附件） */
export async function uploadSharedWith(uploadId, uploaderId, viewer) {
    const needle = `uploads/${uploadId}/`;
    const encodedNeedle = `uploads%2F${uploadId}%2F`;
    for (const share of await activeSharesForViewer(viewer, uploaderId)) {
        if ((await listMessages(share.sessionId)).some((m) => messageMentions(m, [needle, encodedNeedle]))) return true;
    }
    return false;
}

/** 别人的私有自定义 HTML 工具：出现在 viewer 参与的共享对话里时才可读 */
export async function customToolSharedWith(slug, ownerId, viewer) {
    const cleanSlug = String(slug || '').toLowerCase();
    if (!cleanSlug || !viewer) return false;
    const patterns = [`/custom-tools/${cleanSlug}/`, `/custom-tools/${cleanSlug}`, `"slug":"${cleanSlug}"`];
    for (const share of await activeSharesForViewer(viewer, ownerId)) {
        if ((await listMessages(share.sessionId)).some((m) => messageMentions(m, patterns))) return true;
    }
    return false;
}

export { same as sameUser };

// ── 共享对话外部能力感知（缺失 Skill / 工具）与私有 Skill 临时授权审批 ──
function historyCapabilitiesIn(msgs = []) {
    const skillIds = new Set();
    const tools = new Set();
    for (const m of Array.isArray(msgs) ? msgs : []) {
        const text = String(m?.content || '');
        if (m?.role === 'user') {
            for (const hit of text.matchAll(SKILL_MENTION_RE)) skillIds.add(String(hit[1] || '').toLowerCase());
        }
        for (const ev of Array.isArray(m?.events) ? m.events : []) {
            if (!ev || typeof ev !== 'object') continue;
            if (ev.type === 'skills' && Array.isArray(ev.skills)) {
                ev.skills.forEach((id) => { const s = String(id || '').toLowerCase(); if (s) skillIds.add(s); });
            }
            if ((ev.type === 'tool_start' || ev.type === 'tool_result') && ev.tool) {
                const t = String(ev.tool).trim();
                if (t) tools.add(t);
                if (t === 'read_skill' && ev.args && (ev.args.id || ev.args.skillId)) {
                    const s = String(ev.args.id || ev.args.skillId).toLowerCase();
                    if (s) skillIds.add(s);
                }
            }
        }
    }
    return { skillIds: [...skillIds], tools: [...tools] };
}

async function sharedSkillSet() {
    const raw = await kvGet('distribution_shared', []).catch(() => []);
    return new Set(Array.isArray(raw) ? raw.map((x) => String(x || '').toLowerCase()) : []);
}

async function listSkillGrants(shareId = '') {
    const rows = await listRecords(K.skillGrant, { ...(shareId ? { group: shareId } : {}), withPayload: true, limit: 1000 });
    return rows.map((r) => (r?.payload ? { ...r.payload, id: r.id } : null)).filter(Boolean);
}

/** 当前用户通过「已同意的共享对话临时授权」可访问的非全员 Skill ID 集合 */
export async function grantedSkillIdsForUser(identity) {
    const username = clean(identity?.username || identity, 80);
    if (!username) return new Set();
    const grants = (await listSkillGrants()).filter((g) => g.status === 'approved' && g.skillId && g.shareId);
    if (!grants.length) return new Set();
    const activeShares = new Set();
    for (const m of await myMemberships(username)) {
        if (m.status !== 'accepted') continue;
        const s = await getShare(m.shareId);
        if (s && s.status === 'active') activeShares.add(s.id);
    }
    for (const g of grants) {
        if (activeShares.has(g.shareId)) continue;
        const s = await getShare(g.shareId);
        if (s && s.status === 'active' && same(s.owner, username)) activeShares.add(s.id);
    }
    const out = new Set();
    for (const g of grants) {
        if (activeShares.has(g.shareId)) out.add(String(g.skillId).toLowerCase());
    }
    return out;
}

function canApproveSkillRequest(grant, identity) {
    if (!grant || !identity?.username) return false;
    if (identity.isSuper) return true;
    if (grant.approver && same(grant.approver, identity.username)) return true;
    if (Array.isArray(grant.approvers) && grant.approvers.some((u) => same(u, identity.username))) return true;
    return false;
}

function formatSkillRequest(grant, dir) {
    return {
        id: grant.id,
        shareId: grant.shareId,
        sessionId: grant.sessionId,
        title: grant.title,
        skillId: grant.skillId,
        skillName: grant.skillName || grant.skillId,
        isBuiltin: Boolean(grant.isBuiltin),
        requestedBy: grant.requestedBy,
        requestedByName: dir.get(userKey(grant.requestedBy))?.name || grant.requestedByName || grant.requestedBy,
        approver: grant.approver || '',
        approverName: dir.get(userKey(grant.approver))?.name || grant.approverName || grant.approver || '平台管理员',
        status: grant.status,
        note: grant.note || '',
        createdAt: new Date(grant.createdAt || Date.now()).toISOString(),
        resolvedAt: grant.resolvedAt ? new Date(grant.resolvedAt).toISOString() : null,
        resolvedBy: grant.resolvedBy || '',
    };
}

/** 识别共享对话中历史调用过、但当前成员缺失或受限的 Skill / 工具 */
export async function sessionCapabilities({ identity, sessionId, _access = null }) {
    const username = clean(identity?.username, 80);
    if (!username || !sessionId) return { skills: [], tools: [], aliases: {}, pendingForMe: [] };
    const access = _access || await sessionAccess(sessionId, username);
    if (!access?.share || access.share.status !== 'active') return { skills: [], tools: [], aliases: {}, pendingForMe: [] };

    const share = access.share;
    const [msgs, allSkills, sharedSet, grantedIds, grants, enabledList, dir] = await Promise.all([
        listMessages(sessionId),
        listSkills().catch(() => []),
        sharedSkillSet(),
        grantedSkillIdsForUser(identity),
        listSkillGrants(share.id),
        enabledTools().catch(() => []),
        directory(),
    ]);
    const hist = historyCapabilitiesIn(msgs);
    const byId = new Map(allSkills.map((s) => [String(s.id).toLowerCase(), s]));
    const isSuper = Boolean(identity?.isSuper);
    const isAdmin = Boolean(identity?.isAdmin || identity?.isSuper);

    const missingSkills = [];
    for (const rawId of hist.skillIds) {
        const id = String(rawId || '').toLowerCase();
        const skill = byId.get(id);
        const isOwn = Boolean(skill && !skill.builtIn && skill.createdBy && same(skill.createdBy, username));
        const isVisible = isSuper || sharedSet.has(`skill:${id}`) || isOwn || grantedIds.has(id);
        if (isVisible) continue;
        const latestReq = grants
            .filter((g) => String(g.skillId || '').toLowerCase() === id)
            .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0] || null;
        if (!skill) {
            missingSkills.push({ id, name: id, owner: '', ownerName: '', isBuiltin: false, canRequest: false, status: 'deleted', requestId: '', reason: '该技能已不存在或已从平台移除' });
            continue;
        }
        const owner = skill.builtIn ? '' : (skill.createdBy || share.owner || '');
        const ownerName = skill.builtIn ? '平台管理员' : (dir.get(userKey(owner))?.name || owner);
        missingSkills.push({
            id,
            name: skill.name || id,
            owner,
            ownerName,
            isBuiltin: Boolean(skill.builtIn),
            canRequest: Boolean(skill.builtIn || owner),
            status: latestReq?.status || 'none',
            requestId: latestReq?.id || '',
            reason: skill.builtIn ? '内置技能未向当前账号开放，可向管理员申请授权给本共享对话' : '私有技能仅归属人可用，可向归属人申请授权给本共享对话成员',
        });
    }

    const enabledNames = new Set(enabledList.map((t) => t.name));
    const missingTools = [];
    for (const toolName of hist.tools) {
        if (!enabledNames.has(toolName)) {
            missingTools.push({ name: toolName, reason: '该工具当前已在平台停用或未开放' });
        } else if (ADMIN_ONLY_TOOLS.has(toolName) && !isAdmin) {
            missingTools.push({ name: toolName, reason: '仅管理员可使用该工具' });
        }
    }

    const pendingForMe = grants
        .filter((g) => g.status === 'pending' && canApproveSkillRequest(g, identity))
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
        .map((g) => formatSkillRequest(g, dir));

    return { skills: missingSkills, tools: missingTools, aliases: {}, pendingForMe };
}

async function notifySkillApprovers({ targets, title, content, actor, share, requestId, skillId, skillName, linkBase }) {
    const cleanTargets = [...new Set((targets || []).map((u) => clean(u, 80)).filter(Boolean))];
    if (!cleanTargets.length) return { inAppAlert: 0, appMsg: 0, email: 0 };

    const inAppAlert = await pushAlert(cleanTargets, {
        type: 'user_action',
        severity: 'warn',
        title,
        message: content,
        source: 'shared-conversation',
        actor,
        objectType: 'shared_skill_request',
        objectId: requestId,
        detail: { shareId: share.id, sessionId: share.sessionId, skillId, skillName },
    }, { allowDuplicate: true }).catch(() => 0);

    const jump = /^https?:\/\//i.test(String(linkBase || ''))
        ? `${String(linkBase).replace(/\/+$/, '')}/?share=${encodeURIComponent(share.linkToken)}`
        : '';
    let appMsg = 0;
    let email = 0;
    for (const target of cleanTargets) {
        try {
            const res = await sendBaseNotify({
                module_type: 'digitalHumanOperations',
                sub_module_type: 'writeReport',
                msg_type: '2',
                app_msg_params: {
                    title,
                    content,
                    to_user_account: target,
                    type: '1',
                    ...(jump ? { jump_url: jump } : {}),
                },
            });
            if (res?.code === 0 || res?.data?.success) appMsg += 1;
        } catch (err) {
            pushLog({ level: 'WARN', category: 'SHARE', message: `Skill 授权应用消息发送失败（${target}）：${err.message}`, userId: actor });
        }
        try {
            const res = await sendBaseNotify({
                module_type: 'digitalHumanOperations',
                sub_module_type: 'writeReport',
                msg_type: '1',
                email_params: {
                    title,
                    content,
                    email_to: target,
                    email_cc: '',
                },
            });
            if (res?.code === 0 || res?.data?.success) email += 1;
        } catch (err) {
            pushLog({ level: 'WARN', category: 'SHARE', message: `Skill 授权邮件通知发送失败（${target}）：${err.message}`, userId: actor });
        }
    }
    return { inAppAlert, appMsg, email };
}

/** 共享对话成员发起私有 Skill 授权申请：多通道通知归属人（站内消息中心 + 应用号消息 + 邮件） */
export async function requestSkillShare({ identity, sessionId, skillId, linkBase = '' }) {
    const username = clean(identity?.username, 80);
    if (!username) fail('未识别当前用户', 401);
    const cleanSkillId = clean(skillId, 64).toLowerCase();
    if (!cleanSkillId) fail('缺少技能标识');

    const access = await sessionAccess(sessionId, username);
    if (!access?.share || access.share.status !== 'active') fail('仅活跃的共享对话可申请技能授权', 404);
    const share = access.share;

    const [allSkills, sharedSet, grantedIds, grants, dir] = await Promise.all([
        listSkills(),
        sharedSkillSet(),
        grantedSkillIdsForUser(identity),
        listSkillGrants(share.id),
        directory(),
    ]);
    const skill = allSkills.find((s) => String(s.id).toLowerCase() === cleanSkillId);
    if (!skill) fail('该技能已不存在或已从平台移除', 404);

    const isOwn = !skill.builtIn && skill.createdBy && same(skill.createdBy, username);
    if (identity?.isSuper || sharedSet.has(`skill:${cleanSkillId}`) || isOwn || grantedIds.has(cleanSkillId)) {
        return { alreadyAvailable: true, share: await shareForSession({ user: username, sessionId, identity }) };
    }

    const existingPending = grants.find((g) => String(g.skillId).toLowerCase() === cleanSkillId && g.status === 'pending');
    if (existingPending) {
        return {
            deduplicated: true,
            request: formatSkillRequest(existingPending, dir),
            share: await shareForSession({ user: username, sessionId, identity }),
        };
    }

    const admins = await listAdmins().catch(() => ({ env: [], stored: [] }));
    const adminList = [...new Set([...(admins.env || []), ...(admins.stored || [])].filter(Boolean))];
    const ownerAccount = skill.builtIn ? '' : (skill.createdBy || share.owner || '');
    const approvers = skill.builtIn
        ? (adminList.length ? adminList : [share.owner].filter(Boolean))
        : [ownerAccount, ...adminList].filter(Boolean);
    const notifyTargets = skill.builtIn ? approvers : [ownerAccount].filter(Boolean);
    if (!notifyTargets.length) fail('未找到可审批的技能归属人', 400);

    const requesterName = dir.get(userKey(username))?.name || identity?.displayName || username;
    const approverName = skill.builtIn ? '平台管理员' : (dir.get(userKey(ownerAccount))?.name || ownerAccount);
    const rec = {
        id: `sg_${crypto.randomBytes(9).toString('base64url')}`,
        shareId: share.id,
        sessionId: share.sessionId,
        title: share.title,
        skillId: cleanSkillId,
        skillName: skill.name || cleanSkillId,
        isBuiltin: Boolean(skill.builtIn),
        requestedBy: username,
        requestedByName: requesterName,
        approver: ownerAccount,
        approverName,
        approvers: [...new Set(approvers)],
        status: 'pending',
        resolvedBy: '',
        resolvedByName: '',
        resolvedAt: 0,
        note: '',
        linkBase: clean(linkBase, 240),
        createdAt: Date.now(),
    };
    await putRecord(K.skillGrant, {
        id: rec.id,
        group: share.id,
        name: rec.skillName,
        sortKey: String(rec.createdAt).padStart(15, '0'),
        payload: rec,
        updatedBy: username,
    });

    const title = `【Dragon Claw】${requesterName} 申请在共享对话中使用技能「${rec.skillName}」`;
    const content = `成员 ${requesterName}（${username}）在共享对话「${share.title}」中申请临时授权使用你的私有技能 @${rec.skillId}（${rec.skillName}）。同意后将授权给当前共享对话的全部成员使用（不开启全员开放）。`;
    const notificationSummary = await notifySkillApprovers({
        targets: notifyTargets,
        title,
        content,
        actor: username,
        share,
        requestId: rec.id,
        skillId: rec.skillId,
        skillName: rec.skillName,
        linkBase,
    });

    return {
        request: formatSkillRequest(rec, dir),
        share: await shareForSession({ user: username, sessionId, identity }),
        notificationSummary,
    };
}

/** 当前用户待审批的私有 Skill 共享申请 */
export async function inboxSkillRequests(identity) {
    const username = clean(identity?.username, 80);
    if (!username) return [];
    const [grants, dir] = await Promise.all([listSkillGrants(), directory()]);
    const out = [];
    for (const g of grants) {
        if (g.status !== 'pending' || !canApproveSkillRequest(g, identity)) continue;
        const share = await getShare(g.shareId);
        if (!share || share.status !== 'active') continue;
        out.push(formatSkillRequest(g, dir));
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** 审批共享对话内的私有 Skill 授权申请；同意后自动开放给本共享对话内所有当前及后续加入成员 */
export async function respondSkillRequest({ identity, requestId, action, note = '' }) {
    const username = clean(identity?.username, 80);
    if (!username) fail('未识别当前用户', 401);
    if (!['approve', 'reject'].includes(action)) fail('无效的审批操作');

    const stored = await getRecord(K.skillGrant, clean(requestId, 120));
    const rec = stored?.payload ? { ...stored.payload, id: stored.id } : null;
    if (!rec) fail('审批申请不存在或已失效', 404);
    if (!canApproveSkillRequest(rec, identity)) fail('只有技能归属人或超级管理员可以审批此申请', 403);
    const share = await getShare(rec.shareId);
    if (!share || share.status !== 'active') fail('对应的共享对话已停止或失效', 409);

    const dir = await directory();
    const resolverName = dir.get(userKey(username))?.name || identity?.displayName || username;
    if (rec.status !== 'pending') {
        const currentMembers = (await members(share.id)).filter((m) => m.status === 'accepted');
        return { status: rec.status, request: formatSkillRequest(rec, dir), grantedCount: 1 + currentMembers.length };
    }

    const nextStatus = action === 'approve' ? 'approved' : 'rejected';
    const updated = {
        ...rec,
        status: nextStatus,
        resolvedBy: username,
        resolvedByName: resolverName,
        resolvedAt: Date.now(),
        note: clean(note, 200),
    };
    await putRecord(K.skillGrant, {
        id: updated.id,
        group: share.id,
        name: updated.skillName,
        sortKey: String(updated.createdAt || Date.now()).padStart(15, '0'),
        payload: updated,
        updatedBy: username,
    });

    const acceptedMembers = (await members(share.id)).filter((m) => m.status === 'accepted');
    const approved = nextStatus === 'approved';
    const jump = /^https?:\/\//i.test(String(updated.linkBase || ''))
        ? `${String(updated.linkBase).replace(/\/+$/, '')}/?share=${encodeURIComponent(share.linkToken)}`
        : '';
    const decisionTitle = approved
        ? `【Dragon Claw】技能「${updated.skillName}」授权申请已通过`
        : `【Dragon Claw】技能「${updated.skillName}」授权申请未通过`;
    const decisionMsg = approved
        ? `${resolverName} 已同意在共享对话「${share.title}」中使用技能 @${updated.skillId}（${updated.skillName}），当前对话成员现可直接使用。`
        : `${resolverName} 暂未同意在共享对话「${share.title}」中使用技能 @${updated.skillId}（${updated.skillName}）${updated.note ? `：${updated.note}` : ''}。`;

    await pushAlert([updated.requestedBy], {
        type: 'user_action',
        severity: approved ? 'info' : 'warn',
        title: decisionTitle,
        message: decisionMsg,
        source: 'shared-conversation',
        actor: username,
        objectType: 'shared_skill_request',
        objectId: updated.id,
        detail: { shareId: share.id, sessionId: share.sessionId, skillId: updated.skillId, action },
    }, { allowDuplicate: true }).catch(() => {});

    try {
        await sendBaseNotify({
            module_type: 'digitalHumanOperations',
            sub_module_type: 'writeReport',
            msg_type: '2',
            app_msg_params: {
                title: decisionTitle,
                content: decisionMsg,
                to_user_account: updated.requestedBy,
                type: '1',
                ...(jump ? { jump_url: jump } : {}),
            },
        });
    } catch { /* 结果通知失败不影响审批结论 */ }

    return {
        status: nextStatus,
        request: formatSkillRequest(updated, dir),
        grantedCount: approved ? (1 + acceptedMembers.length) : 0,
    };
}
