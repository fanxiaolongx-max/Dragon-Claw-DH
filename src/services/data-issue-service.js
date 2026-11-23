// 数据源问题跟踪（数据探索 → 数据治理 → 数据源问题）。
//
// 跟踪范围：需求 #769 清单里的 NetCare / DataFab 表，以及看板 SQL 引用的源表（即页面上带来源标识的表）。
// 每轮行数巡检后对一遍：空表（0 行）、库里没有、查询失败都记成「未解决」，开始时间 = 第一次发现的时间；
// 之后哪一轮查到有数据了就记为「已解决」，记下解决时间和用时；再出问题就重新开一条。
// 未解决超过设定天数的标「超期」，方便催数据源那边；对话里的查库工具默认不使用这些表回答（restrictChat）。
// 存在键值表 dw_issues（团队隔离）：{ config, open: { 表名: 问题 }, closed: [问题], lastRunId, syncedAt }。
import { kvGet, kvSet } from '../dao/scoped.js';
import * as watch from './data-watch-service.js';
import { chatTableIndex, ORIGIN_LABEL } from './data-dictionary-service.js';

const KEY = 'dw_issues';
const KEEP_CLOSED = 300;
const DAY = 86_400_000;
export const ISSUE_KIND = { empty: '空表（0 行）', missing: '库里没有这张表', error: '查询失败' };
const DEFAULT_CONFIG = { alertDays: 3, restrictChat: true };

const normConfig = (c = {}) => ({
    alertDays: Math.min(90, Math.max(1, Math.round(Number(c.alertDays) || DEFAULT_CONFIG.alertDays))),
    restrictChat: c.restrictChat !== false,
});

async function load() {
    const raw = await kvGet(KEY, null);
    return {
        config: normConfig(raw?.config),
        open: raw?.open && typeof raw.open === 'object' ? raw.open : {},
        closed: Array.isArray(raw?.closed) ? raw.closed : [],
        lastRunId: raw?.lastRunId || '',
        syncedAt: raw?.syncedAt || '',
    };
}
const save = (data) => kvSet(KEY, data);

/** 按一轮巡检结果更新问题清单。now 可传入，方便测试 */
export async function syncWithRun(run, { now = Date.now() } = {}) {
    const results = Array.isArray(run?.results) ? run.results : [];
    if (!run?.id || !results.length) return null;
    const data = await load();
    if (data.lastRunId === run.id) return data;
    const index = await chatTableIndex();
    const tracked = [...index.entries()].filter(([, info]) => info.origin);
    const byKey = new Map(results.map((r) => [String(r.key).toLowerCase(), r]));
    const at = new Date(now).toISOString();
    const open = { ...data.open };
    const closed = [...data.closed];
    const trackedKeys = new Set();
    for (const [key, info] of tracked) {
        trackedKeys.add(key);
        const r = byKey.get(key);
        const kind = !r ? 'missing' : r.count == null ? 'error' : r.count === 0 ? 'empty' : '';
        const prev = open[key];
        if (kind) {
            open[key] = {
                key, table: r?.key || info.entry?.key || prev?.table || key,
                kind, detail: kind === 'error' ? String(r?.error || '').slice(0, 300) : '',
                origin: info.origin, reprocess: info.reprocess,
                board: info.entry?.category || '', nameCn: info.entry?.nameCn || '',
                openedAt: prev?.openedAt || at, lastSeenAt: at, checks: (prev?.checks || 0) + 1,
                notifiedAt: prev?.notifiedAt || '', note: prev?.note || '',
            };
        } else if (prev) {
            closed.unshift({ ...prev, resolvedAt: at, resolvedCount: r.count, durationMs: now - Date.parse(prev.openedAt) });
            delete open[key];
        }
    }
    // 不再跟踪的表（清单里删了 / 改了名）：直接移出未解决
    for (const key of Object.keys(open)) if (!trackedKeys.has(key)) delete open[key];
    const next = { ...data, open, closed: closed.slice(0, KEEP_CLOSED), lastRunId: run.id, syncedAt: at };
    await save(next);
    return next;
}

// 每轮巡检结束自动对一遍
watch.onRunFinished(({ run, results }) => syncWithRun({ ...run, results }));

/** 页面打开时：最近一轮巡检还没对过就补一次（第一次启用时，开始时间从现在算） */
async function ensureSynced() {
    const data = await load();
    const run = await watch.latestRun().catch(() => null);
    // 只补「上次同步之后才跑完」的那轮（正常情况下巡检一结束就已经同步过了）
    const finished = Date.parse(run?.summary?.finishedAt || run?.finishedAt || '') || 0;
    if (run && run.id !== data.lastRunId && (!data.syncedAt || finished > Date.parse(data.syncedAt))) return (await syncWithRun(run)) || data;
    return data;
}

const ageOf = (issue, now) => now - Date.parse(issue.openedAt);

/** 问题清单 + 统计：解决率、未解决、超期（超过 alertDays 天）、最长未解决 */
export async function issuesView({ now = Date.now() } = {}) {
    const data = await ensureSynced();
    const index = await chatTableIndex().catch(() => new Map());
    const limit = data.config.alertDays * DAY;
    const decorate = (i) => {
        const info = index.get(i.key);
        return { ...i, originLabel: ORIGIN_LABEL[i.origin] || '', kindLabel: ISSUE_KIND[i.kind] || i.kind, boards: info?.boards || [], alternative: info?.alternative || null };
    };
    const open = Object.values(data.open).map((i) => ({ ...decorate(i), ageMs: ageOf(i, now), overdue: ageOf(i, now) >= limit }))
        .sort((a, b) => b.ageMs - a.ageMs || a.key.localeCompare(b.key));
    const closed = data.closed.slice(0, 100).map(decorate);
    const total = open.length + data.closed.length;
    return {
        config: data.config, syncedAt: data.syncedAt, lastRunId: data.lastRunId,
        stats: {
            open: open.length, resolved: data.closed.length, total,
            rate: total ? Math.round((data.closed.length / total) * 1000) / 10 : null,
            overdue: open.filter((i) => i.overdue).length,
            longestMs: open.length ? open[0].ageMs : 0,
            notified: open.filter((i) => i.notifiedAt).length,
            byKind: open.reduce((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] || 0) + 1 }), {}),
            byOrigin: open.reduce((acc, i) => ({ ...acc, [i.origin]: (acc[i.origin] || 0) + 1 }), {}),
        },
        open, closed,
    };
}

export async function saveConfig(input = {}) {
    const data = await load();
    const config = normConfig({ ...data.config, ...input });
    await save({ ...data, config });
    return config;
}

/** 记一下已提醒数据源 / 备注 */
export async function updateIssue(key, patch = {}) {
    const data = await load();
    const k = String(key || '').toLowerCase();
    const issue = data.open[k];
    if (!issue) return null;
    const next = { ...issue };
    if ('notified' in patch) next.notifiedAt = patch.notified ? new Date().toISOString() : '';
    if ('note' in patch) next.note = String(patch.note || '').slice(0, 500);
    await save({ ...data, open: { ...data.open, [k]: next } });
    return next;
}

/**
 * 对话里的查库工具用：表名（小写）→ 未解决问题。restrictChat 关掉时返回空表，工具照常查。
 * annotate=true 时不管开关都返回（只用来提示）。
 */
export async function chatIssueMap({ annotate = false } = {}) {
    const data = await load().catch(() => null);
    if (!data || (!annotate && !data.config.restrictChat)) return new Map();
    return new Map(Object.entries(data.open));
}

export function issueSentence(issue, now = Date.now()) {
    const days = Math.max(0, Math.floor(ageOf(issue, now) / DAY));
    const hours = Math.max(0, Math.floor(ageOf(issue, now) / 3_600_000));
    return `${ISSUE_KIND[issue.kind] || issue.kind}，自 ${issue.openedAt.slice(0, 10)} 起未解决（${days ? `${days} 天` : `${hours} 小时`}）`;
}
