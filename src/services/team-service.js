// 账号绑定团队（仅超级管理员操作）。
// 没有绑定的账号都在「默认团队」，看到的就是上线前那一份数据；超级管理员可以新建团队、把账号移进去，
// 同一团队的账号共用抓取脚本、数据导入、报表看板、月报等工具页面数据，不同团队互相隔离（见 dao/team-scope.js）。
// 管理员（超级管理员）始终在默认团队：他们管的是平台级设置。
// 团队与归属存在全局键 dh_teams：{ teams: [{ id, name, createdAt, createdBy }], members: { 工号: 团队 } }。
import crypto from 'node:crypto';
import { BusinessError } from '../core/errors.js';
import { kvGet, kvSet, runInTeam } from '../dao/scoped.js';
import { listAdmins, hasAdminMatch, stripFirstLetter } from '../core/access.js';
import { TEAM_ID_RE } from '../dao/team-scope.js';

const KEY = 'dh_teams';
const CACHE_MS = 15_000;
let cache = null;

const norm = (u) => String(u || '').trim().toLowerCase();

async function load({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
    const raw = await kvGet(KEY, null);
    const data = {
        teams: Array.isArray(raw?.teams) ? raw.teams.filter((t) => t && TEAM_ID_RE.test(String(t.id))) : [],
        members: raw?.members && typeof raw.members === 'object' ? raw.members : {},
    };
    cache = { at: Date.now(), data };
    return data;
}

async function save(data) {
    await kvSet(KEY, data);
    cache = { at: Date.now(), data };
    return data;
}

export function invalidateTeamCache() { cache = null; }

/** 账号所在团队：空字符串 = 默认团队。工号大小写、首字母差异都能对上 */
export async function teamOf(username) {
    const u = norm(username);
    if (!u || u === 'default' || u === 'anonymous') return '';
    const { teams, members } = await load();
    const team = members[u] ?? members[stripFirstLetter(u)] ?? '';
    return team && teams.some((t) => t.id === team) ? team : '';
}

/** 在某个账号所在的团队里执行（定时任务等后台代码用） */
export async function runAsUserTeam(username, fn) {
    return runInTeam(await teamOf(username).catch(() => ''), fn);
}

async function isAdminUser(username) {
    const { env, stored } = await listAdmins();
    return hasAdminMatch([...(env || []), ...(stored || [])], norm(username));
}

export async function listTeams() {
    const { teams, members } = await load({ fresh: true });
    const counts = {};
    for (const team of Object.values(members)) counts[team] = (counts[team] || 0) + 1;
    return {
        teams: [{ id: '', name: '默认团队', isDefault: true }, ...teams].map((t) => ({ ...t, members: Object.entries(members).filter(([, team]) => (team || '') === t.id).map(([u]) => u), memberCount: t.id ? counts[t.id] || 0 : null })),
        members,
    };
}

export async function createTeam({ id = '', name = '' } = {}, actor = '') {
    const label = String(name || '').trim().slice(0, 40);
    if (!label) throw new BusinessError('请填写团队名称', 400);
    const data = await load({ fresh: true });
    if (data.teams.some((t) => t.name === label)) throw new BusinessError(`已有团队「${label}」`, 409);
    let teamId = String(id || '').trim().toLowerCase();
    if (teamId && !TEAM_ID_RE.test(teamId)) throw new BusinessError('团队标识只能用小写字母、数字、- _，1~40 位', 400);
    if (!teamId) teamId = `t${crypto.randomBytes(4).toString('hex')}`;
    if (data.teams.some((t) => t.id === teamId)) throw new BusinessError(`团队标识 ${teamId} 已存在`, 409);
    const team = { id: teamId, name: label, createdAt: new Date().toISOString(), createdBy: norm(actor) };
    await save({ ...data, teams: [...data.teams, team] });
    return team;
}

export async function renameTeam(teamId, name) {
    const label = String(name || '').trim().slice(0, 40);
    if (!label) throw new BusinessError('请填写团队名称', 400);
    const data = await load({ fresh: true });
    const team = data.teams.find((t) => t.id === teamId);
    if (!team) throw new BusinessError('团队不存在', 404);
    if (data.teams.some((t) => t.id !== teamId && t.name === label)) throw new BusinessError(`已有团队「${label}」`, 409);
    team.name = label;
    await save(data);
    return team;
}

/** 删除团队：要先把成员移走；团队数据保留在团队版表里（重建同标识的团队可找回） */
export async function deleteTeam(teamId) {
    const data = await load({ fresh: true });
    if (!data.teams.some((t) => t.id === teamId)) throw new BusinessError('团队不存在', 404);
    const members = Object.entries(data.members).filter(([, t]) => t === teamId).map(([u]) => u);
    if (members.length) throw new BusinessError(`团队里还有成员（${members.join('、')}），先把他们移到其他团队`, 409);
    await save({ ...data, teams: data.teams.filter((t) => t.id !== teamId) });
    return { success: true };
}

/** 把账号放进团队；teamId 为空 = 回到默认团队 */
export async function setMemberTeam(username, teamId = '') {
    const u = norm(username);
    if (!u || u.length > 120) throw new BusinessError('工号无效', 400);
    const target = String(teamId || '').trim().toLowerCase();
    const data = await load({ fresh: true });
    if (target && !data.teams.some((t) => t.id === target)) throw new BusinessError('团队不存在', 404);
    if (target && await isAdminUser(u)) throw new BusinessError('超级管理员始终在默认团队，不能移到其他团队', 403);
    const members = { ...data.members };
    const from = members[u] || '';
    if (target) members[u] = target; else delete members[u];
    await save({ ...data, members });
    return { username: u, from, to: target };
}
