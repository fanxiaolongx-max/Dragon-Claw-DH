// 模型用量统计：按天、按模型方案累计 token 与请求数，供设置页的趋势图使用。
// 存键值表 ai_usage_stats；读改写不是原子的，并发下可能少记几次，只用于看趋势。
import { kvGet, kvSet } from '../dao/scoped.js';

const USAGE_KEY = 'ai_usage_stats';
const KEEP_DAYS = 400;
const POINTS = { day: 30, week: 12, month: 12, year: 5 };
const EMPTY = () => ({ v: 2, days: {}, meta: {}, legacy: { promptTokens: 0, completionTokens: 0, requests: 0 } });

const dayOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const keyOf = (m) => `${m.id || ''}|${m.provider || ''}|${m.model || ''}`;

async function load() {
    const raw = await kvGet(USAGE_KEY, null);
    if (raw && raw.v === 2 && raw.days) return { ...EMPTY(), ...raw };
    // 1.5.0 及以前只有总数：保留为“未归类”
    const store = EMPTY();
    if (raw && typeof raw === 'object') {
        store.legacy = { promptTokens: Number(raw.promptTokens) || 0, completionTokens: Number(raw.completionTokens) || 0, requests: Number(raw.requests) || 0 };
    }
    return store;
}

export async function addUsage({ inputTokens = 0, outputTokens = 0 } = {}, model = null) {
    try {
        const input = Number(inputTokens) || 0;
        const output = Number(outputTokens) || 0;
        const store = await load();
        const day = dayOf(new Date());
        const key = model ? keyOf(model) : 'unknown||';
        const bucket = (store.days[day] ||= {});
        const cell = (bucket[key] ||= { i: 0, o: 0, r: 0 });
        cell.i += input; cell.o += output; cell.r += 1;
        if (model) {
            store.meta[key] = {
                profileId: model.id || '', provider: model.provider || '', model: model.model || '', profileName: model.name || '',
                inCost: Number(model.inputCostPerMillionUsd) || 0, outCost: Number(model.outputCostPerMillionUsd) || 0,
            };
        }
        const days = Object.keys(store.days).sort();
        for (const old of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete store.days[old];
        await kvSet(USAGE_KEY, store);
    } catch { /* 用量统计失败不影响对话 */ }
}

function periodOf(day, dimension) {
    const [y, m, d] = day.split('-').map(Number);
    if (dimension === 'year') return { id: String(y), label: String(y) };
    if (dimension === 'month') return { id: `${y}-${String(m).padStart(2, '0')}`, label: `${y}-${String(m).padStart(2, '0')}` };
    if (dimension === 'week') {
        const date = new Date(y, m - 1, d);
        date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); // 周一为一周的开始
        const id = dayOf(date);
        return { id, label: id.slice(5) };
    }
    return { id: day, label: day.slice(5) };
}

const USD_TO_CNY = 7.2;
function measure(cell, meta) {
    const costUsd = ((cell.i * (meta?.inCost || 0)) + (cell.o * (meta?.outCost || 0))) / 1e6;
    return { tokens: cell.i + cell.o, promptTokens: cell.i, completionTokens: cell.o, requests: cell.r, costUsd, costCny: costUsd * USD_TO_CNY };
}
const plus = (a, b) => {
    for (const k of ['tokens', 'promptTokens', 'completionTokens', 'requests', 'costUsd', 'costCny']) a[k] = (a[k] || 0) + (b[k] || 0);
    return a;
};
const zero = () => ({ tokens: 0, promptTokens: 0, completionTokens: 0, requests: 0, costUsd: 0, costCny: 0 });

export async function getUsage(dimension = 'day') {
    const dim = POINTS[dimension] ? dimension : 'day';
    const store = await load();
    const totals = zero();
    const models = new Map();
    const periods = new Map(); // id → { label, all, byKey }
    for (const day of Object.keys(store.days).sort()) {
        const period = periodOf(day, dim);
        const slot = periods.get(period.id) || { label: period.label, all: zero(), byKey: new Map() };
        periods.set(period.id, slot);
        for (const [key, cell] of Object.entries(store.days[day])) {
            const meta = store.meta[key];
            const m = measure(cell, meta);
            plus(totals, m);
            plus(slot.all, m);
            plus(slot.byKey.get(key) || slot.byKey.set(key, zero()).get(key), m);
            if (!models.has(key)) models.set(key, { key, profileId: meta?.profileId || '', provider: meta?.provider || '', model: meta?.model || '未知模型', profileName: meta?.profileName || '', totals: zero() });
            plus(models.get(key).totals, m);
        }
    }
    const ids = [...periods.keys()].sort().slice(-POINTS[dim]);
    const series = ids.map((id) => ({ label: periods.get(id).label, ...periods.get(id).all }));
    const legacyTokens = store.legacy.promptTokens + store.legacy.completionTokens;
    return {
        dimension: dim,
        totals,
        series,
        models: [...models.values()].sort((a, b) => b.totals.tokens - a.totals.tokens).map((item) => ({
            ...item,
            series: ids.map((id) => ({ label: periods.get(id).label, ...(periods.get(id).byKey.get(item.key) || zero()) })),
        })),
        unclassified: { tokens: legacyTokens, requests: store.legacy.requests },
        // 旧字段：保持与 1.5.0 的返回兼容
        promptTokens: totals.promptTokens + store.legacy.promptTokens,
        completionTokens: totals.completionTokens + store.legacy.completionTokens,
        requests: totals.requests + store.legacy.requests,
        totalCostUsd: totals.costUsd,
    };
}

/** 清空全部，或只清某个“方案|厂商|模型”的记录 */
export async function clearUsage(key = '') {
    if (!key) {
        await kvSet(USAGE_KEY, EMPTY());
        return getUsage();
    }
    const store = await load();
    for (const bucket of Object.values(store.days)) delete bucket[key];
    delete store.meta[key];
    await kvSet(USAGE_KEY, store);
    return getUsage();
}
