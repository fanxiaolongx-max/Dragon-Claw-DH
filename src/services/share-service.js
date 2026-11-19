// 共享对话（基座版）：所有人在同一个应用库里，共享就是让成员直接进入同一个对话——没有副本、不需要同步。
// - 共享关系、成员、常用群组、最近共享、见过的账号都存在 biz_records（不新建表，上基座不需要 DBA 改表）。
// - 每条消息在 meta 里记 author（发消息的人；AI 回答记提问的人）；读消息时别人发的带 { type: 'shared_author' } 事件，
//   前端据此标注账号。没有 author 的旧消息算发起者的。
// - 新的提问按发送者本人的身份执行（工具权限、数据权限都按本人），同一时间只允许一个人在这段对话里提问。
// - 邀请时经基座通知接口给对方发一条应用消息（带跳转链接），失败不影响邀请本身。
// 接口与主线版 /api/shared-conversations 一致，前端共用同一份 shared-conversations.js。
import crypto from 'node:crypto';
import { BusinessError } from '../core/errors.js';
import { isSameUserId } from '../core/access.js';
import { kvGet, sendBaseNotify } from '../dao/scoped.js';
import { listRecords, getRecord, putRecord, deleteRecord } from './record-store.js';
import { getSession, saveSession, listMessages } from './ai-service.js';
import { pushLog } from '../core/log-ring.js';

const K = { share: 'share', member: 'share_member', group: 'share_group', recent: 'share_recent', user: 'share_user' };
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
        if (p.username) map.set(userKey(p.username), { username: p.username, name: p.name || p.username });
    }
    try {
        const dir = await kvGet('expedite_notify_directory', {});
        for (const item of Array.isArray(dir?.history) ? dir.history : []) {
            const id = clean(item?.id);
            if (id && !map.has(userKey(id))) map.set(userKey(id), { username: id, name: clean(item.name) || id });
        }
    } catch { /* 催办名录读不到不影响 */ }
    return map;
}
async function nameOf(user, dir) {
    const d = dir || await directory();
    return d.get(userKey(user))?.name || user;
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
    if (!share) {
        share = await saveShare({ id: `shr_${crypto.randomBytes(9).toString('base64url')}`, sessionId: access.session.id, owner: access.session.owner, title: t, linkToken: crypto.randomBytes(18).toString('base64url'), status: 'active', createdAt: Date.now() });
    } else if (share.status !== 'active') {
        if (access.role !== 'owner') fail('发起者已停止共享这个对话', 409);
        share = await saveShare({ ...share, status: 'active' });
    }
    if (access.role === 'owner' && t !== share.title) share = await saveShare({ ...share, title: t });
    return share;
}

export async function shareForSession({ user, sessionId }) {
    const access = await sessionAccess(sessionId, user);
    return access?.share ? describe(access.share, user) : null;
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
        if (!share || seenShares.has(share.id) || !(await getSession(share.sessionId))) return;
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
    return { shareId: share.id, pushed: 0, pulled, closed: share.status !== 'active' };
}

export async function leave({ user, sessionId }) {
    const access = await sessionAccess(sessionId, user);
    if (!access?.share) fail('这个对话没有共享', 404);
    const share = access.share;
    if (access.role === 'owner') {
        await saveShare({ ...share, status: 'closed' });
        return { closed: true };
    }
    const m = await getMember(share.id, user);
    await saveMember({ ...m, status: 'left', respondedAt: Date.now() });
    return { left: true };
}

export async function removeMember({ user, sessionId, target }) {
    const access = await sessionAccess(sessionId, user);
    if (!access?.share || access.role !== 'owner') fail('只有发起者可以移除成员', 403);
    if (same(target, user)) fail('不能移除自己，请使用「停止共享」');
    const m = await getMember(access.share.id, target);
    if (m) await saveMember({ ...m, status: 'removed', respondedAt: Date.now() });
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

/** 共享对话同一时间只让一个人提问：记在会话 metadata 里（多实例也能看到），5 分钟没结束视为已失效 */
export async function claimTurn(session, user, name) {
    const fresh = await getSession(session.id);
    const turn = fresh?.metadata?.activeTurn;
    if (turn && !same(turn.by, user) && Date.now() - Number(turn.at || 0) < TURN_TTL_MS) {
        fail(`${turn.name || turn.by} 正在这段共享对话里提问，请等这一轮回答完成后再发送`, 409);
    }
    await saveSession({ id: session.id, title: fresh.title, summary: fresh.summary, archived: fresh.archived, pinned: fresh.pinned, metadata: { activeTurn: { by: user, name: name || user, at: Date.now() } } });
}
export async function releaseTurn(sessionId, user) {
    const fresh = await getSession(sessionId);
    const turn = fresh?.metadata?.activeTurn;
    if (!turn || !same(turn.by, user)) return;
    await saveSession({ id: sessionId, title: fresh.title, summary: fresh.summary, archived: fresh.archived, pinned: fresh.pinned, metadata: { activeTurn: null } });
}

/** 给模型的历史：取库里最近的消息（成员之间不一定都在页面上看到了最新的），别人的提问前标注账号 */
export async function sharedHistory(sessionId, { ownerId, viewer, limit = 30 }) {
    const dir = await directory();
    return (await listMessages(sessionId)).slice(-limit).map((m) => {
        const author = m.author || ownerId;
        const role = m.role === 'user' ? 'user' : 'assistant';
        const content = String(m.content || '');
        return { role, content: role === 'user' && !same(author, viewer) ? `【共享对话成员 ${dir.get(userKey(author))?.name || author} 的提问】\n${content}` : content };
    }).filter((m) => m.content.trim());
}

/** 别人的对话附件：出现在 viewer 能访问的共享对话的消息里时才可读（共享的是上下文，含历史里的附件） */
export async function uploadSharedWith(uploadId, uploaderId, viewer) {
    const needle = `uploads/${uploadId}/`;
    const shares = [];
    for (const m of await myMemberships(viewer)) {
        if (m.status === 'accepted') shares.push(await getShare(m.shareId));
    }
    for (const rec of await listRecords(K.share, { withPayload: true, limit: 1000 })) {
        if (rec.payload && same(rec.payload.owner, viewer)) shares.push({ ...rec.payload, id: rec.id });
    }
    for (const share of shares) {
        if (!share || share.status !== 'active') continue;
        if (!same(share.owner, uploaderId) && !(await getMember(share.id, uploaderId))) continue;
        if ((await listMessages(share.sessionId)).some((m) => String(m.content || '').includes(needle))) return true;
    }
    return false;
}

export { same as sameUser };
