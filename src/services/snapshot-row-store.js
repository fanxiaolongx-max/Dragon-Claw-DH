// 快照明细行的去重存储（与桌面版 tools-platform/backend/models/snapshot-row-store.js 同一思路）。
//
// sla_snapshots 每份都内嵌全部源表行、保留最近 50 份，而每天导入时大多数表内容没有变化。
// 这里把 sourceSections[].rows 按内容（JSON 的 SHA-256）gzip 压缩后单独存一份，快照里只留
// { rowsRef, rowCount }：相同内容只存一次，经基座 REST 写入的数据量也随之大幅减少。
//
// 存放位置用已有的 sys_kv_store（键 snapshot_rows:<hash>，大字段由数据层自动分片），
// 不新增数据表。另存一份索引（snapshot_rows_index）用于回收。
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { kvGet, kvSet, selectTable, deleteRows, sqlVal, parseJsonCol, teamScopedKey } from '../dao/scoped.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const KEY_PREFIX = 'snapshot_rows:';
const INDEX_KEY = 'snapshot_rows_index';
const GC_GRACE_MS = 60 * 60 * 1000; // 刚写入、还没写进快照引用的数据块不回收
const DELETE_BATCH = 100;

const hashOf = (text) => crypto.createHash('sha256').update(text).digest('hex');
const hasInlineRows = (section) => section && Array.isArray(section.rows) && section.rows.length > 0;
const sectionsOf = (payload) => (payload && Array.isArray(payload.sourceSections) ? payload.sourceSections : []);

// 应用是单进程（WORKERS=1）：索引的读改写串行执行，避免并发保存互相覆盖
let indexQueue = Promise.resolve();
function withIndex(fn) {
    const next = indexQueue.catch(() => null).then(async () => {
        const index = (await kvGet(INDEX_KEY, {})) || {};
        const result = await fn(index);
        await kvSet(INDEX_KEY, index);
        return result;
    });
    indexQueue = next;
    return next;
}

/** 把明细行存进去重存储，返回只带引用的新快照（不改传入对象） */
export async function dehydrate(payload) {
    const sections = sectionsOf(payload);
    if (!sections.some(hasInlineRows)) return payload;
    const next = [];
    const added = [];
    for (const section of sections) {
        if (!hasInlineRows(section)) { next.push(section); continue; }
        const text = JSON.stringify(section.rows);
        const hash = hashOf(text);
        if (!(await kvGet(KEY_PREFIX + hash, null))) {
            const data = (await gzip(Buffer.from(text, 'utf8'))).toString('base64');
            const rawBytes = Buffer.byteLength(text, 'utf8');
            await kvSet(KEY_PREFIX + hash, { encoding: 'gzip-base64', data, rowCount: section.rows.length, rawBytes });
            added.push([hash, rawBytes]);
        }
        const { rows: _rows, ...rest } = section;
        next.push({ ...rest, rowsRef: hash, rowCount: section.rows.length });
    }
    if (added.length) {
        await withIndex((index) => {
            for (const [hash, rawBytes] of added) if (!index[hash]) index[hash] = { createdAt: Date.now(), rawBytes };
        });
    }
    return { ...payload, sourceSections: next };
}

/** 还原明细行；memo 在一次请求内复用。数据块缺失时 rows 为空并标记 rowsMissing，不拖垮整个列表 */
export async function hydrate(payload, memo = new Map()) {
    const sections = sectionsOf(payload);
    if (!sections.some((s) => s && s.rowsRef && !Array.isArray(s.rows))) return payload;
    const out = [];
    for (const section of sections) {
        if (!section || !section.rowsRef || Array.isArray(section.rows)) { out.push(section); continue; }
        if (!memo.has(section.rowsRef)) {
            const stored = await kvGet(KEY_PREFIX + section.rowsRef, null);
            memo.set(section.rowsRef, stored?.data ? (await gunzip(Buffer.from(stored.data, 'base64'))).toString('utf8') : null);
        }
        const text = memo.get(section.rowsRef);
        if (text === null) {
            out.push({ ...section, rows: [], rowsMissing: true });
            continue;
        }
        const { rowsRef: _ref, rowCount: _count, ...rest } = section;
        out.push({ ...rest, rows: JSON.parse(text) });
    }
    return { ...payload, sourceSections: out };
}

export async function hydrateAll(payloads) {
    const memo = new Map();
    const out = [];
    for (const payload of payloads) out.push(await hydrate(payload, memo));
    return out;
}

/** 回收没有任何快照引用、且写入超过一小时的数据块 */
export async function collectGarbage({ graceMs = GC_GRACE_MS } = {}) {
    const rows = await selectTable('sla_snapshots', { columns: ['id', 'payload_json'], limit: 1000 });
    const refs = new Set();
    for (const row of rows) for (const section of sectionsOf(parseJsonCol(row.payload_json, {}))) if (section?.rowsRef) refs.add(section.rowsRef);
    const cutoff = Date.now() - graceMs;
    return withIndex(async (index) => {
        const stale = Object.entries(index).filter(([hash, meta]) => !refs.has(hash) && Number(meta?.createdAt || 0) < cutoff).map(([hash]) => hash);
        for (let i = 0; i < stale.length; i += DELETE_BATCH) {
            // 实际键名带团队前缀（非默认团队），和 kvGet / kvSet 写进去的一致
            const keys = stale.slice(i, i + DELETE_BATCH).map((hash) => teamScopedKey(KEY_PREFIX + hash));
            await deleteRows('sys_kv_store', { whereSql: `\`kv_key\` IN (${keys.map((key) => sqlVal(key)).join(', ')})`, memFilter: (r) => keys.includes(r.kv_key) });
        }
        for (const hash of stale) delete index[hash];
        return stale.length;
    });
}

let gcTimer = null;
/** 快照裁剪、删除后稍后回收（合并短时间内的多次触发） */
export function scheduleGarbageCollection(delayMs = 30_000) {
    if (gcTimer) return;
    gcTimer = setTimeout(() => {
        gcTimer = null;
        collectGarbage().catch((error) => console.warn('[snapshot-rows] 回收失败：', error.message));
    }, delayMs);
    gcTimer.unref?.();
}

/**
 * 把旧快照里内嵌的明细行逐条转成引用：先写数据块并校验能完整还原（哈希一致）再写回，
 * 出错只跳过这一条。由调用方传入「读一份」与「写一份」，便于和快照表的列对应。
 */
export async function compact({ listIds, read, write, pauseMs = 50 }) {
    const summary = { converted: 0, skipped: 0, failed: 0 };
    for (const id of await listIds()) {
        try {
            const original = await read(id);
            if (!original || !sectionsOf(original).some(hasInlineRows)) { summary.skipped++; continue; }
            const compacted = await dehydrate(original);
            const restored = await hydrate(compacted);
            const same = sectionsOf(original).every((section, i) => !hasInlineRows(section)
                || hashOf(JSON.stringify(restored.sourceSections[i].rows)) === hashOf(JSON.stringify(section.rows)));
            if (!same) { summary.failed++; continue; }
            await write(id, compacted);
            summary.converted++;
        } catch (error) {
            summary.failed++;
            console.warn(`[snapshot-rows] 转换快照 ${id} 失败：`, error.message);
        }
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    return summary;
}
