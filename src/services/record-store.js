// 业务页面的统一记录存取：专题分析快照、值班表、FRT 核算快照、PR 稽查模板都是「一条带 JSON 内容的记录」，
// 共用一张表 biz_records，用 kind 区分。各页面的服务只管自己的校验和计算，不再各建各的表。
import { selectTable, upsertRow, deleteRows, sqlVal, parseJsonCol } from '../dao/scoped.js';

const TABLE = 'biz_records';
const META_COLS = ['kind', 'id', 'group_key', 'name', 'period', 'sort_key', 'content_hash', 'summary_json', 'payload_bytes', 'updated_by', 'created_at', 'updated_at'];
const iso = (ms) => (Number(ms) ? new Date(Number(ms)).toISOString() : '');

const toRecord = (row) => ({
    kind: row.kind,
    id: row.id,
    group: row.group_key || '',
    name: row.name || '',
    period: row.period || '',
    sortKey: row.sort_key || '',
    hash: row.content_hash || '',
    summary: parseJsonCol(row.summary_json, {}) || {},
    payloadBytes: Number(row.payload_bytes) || 0,
    updatedBy: row.updated_by || '',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.payload_json !== undefined ? { payload: parseJsonCol(row.payload_json, null) } : {}),
});

function scope(kind, { group = '', id = '', hash = '' } = {}) {
    const parts = [`\`kind\` = ${sqlVal(kind)}`];
    if (group) parts.push(`\`group_key\` = ${sqlVal(group)}`);
    if (id) parts.push(`\`id\` = ${sqlVal(id)}`);
    if (hash) parts.push(`\`content_hash\` = ${sqlVal(hash)}`);
    return {
        whereSql: parts.join(' AND '),
        memFilter: (r) => r.kind === kind && (!group || r.group_key === group) && (!id || r.id === id) && (!hash || r.content_hash === hash),
    };
}
// 新的在前：先按排序键，再按标识
const newestFirst = (a, b) => String(b.sort_key || '').localeCompare(String(a.sort_key || '')) || String(b.id).localeCompare(String(a.id));

/** 列出某类记录（默认不带正文，新的在前） */
export async function listRecords(kind, { group = '', withPayload = false, limit = 200, offset = 0 } = {}) {
    const rows = await selectTable(TABLE, {
        columns: withPayload ? ['*'] : META_COLS,
        ...scope(kind, { group }),
        orderBySql: '`sort_key` DESC, `id` DESC',
        limit: Math.min(1000, Number(offset) + Number(limit)) || 200,
        memSort: newestFirst,
    });
    return rows.slice(Number(offset) || 0).map(toRecord);
}

export async function countRecords(kind, { group = '' } = {}) {
    return (await selectTable(TABLE, { columns: ['id'], ...scope(kind, { group }), limit: 5000 })).length;
}

export async function getRecord(kind, id) {
    const key = String(id || '');
    if (!key) return null;
    const rows = await selectTable(TABLE, { ...scope(kind, { id: key }), limit: 1 });
    return rows.length ? toRecord(rows[0]) : null;
}

export async function findRecordByHash(kind, group, hash) {
    const rows = await selectTable(TABLE, { columns: META_COLS, ...scope(kind, { group, hash }), limit: 1 });
    return rows.length ? toRecord(rows[0]) : null;
}

/** 新增或覆盖一条记录；返回不带正文的记录 */
export async function putRecord(kind, { id, group = '', name = '', period = '', sortKey = '', hash = '', summary = null, payload, updatedBy = '', createdAt = 0 }) {
    const payloadJson = JSON.stringify(payload ?? null);
    const now = Date.now();
    await upsertRow(TABLE, {
        kind,
        id: String(id),
        group_key: String(group || ''),
        name: String(name || '').slice(0, 255),
        period: String(period || '').slice(0, 32),
        sort_key: String(sortKey || '').slice(0, 64),
        content_hash: String(hash || '').slice(0, 64),
        summary_json: summary ? JSON.stringify(summary) : null,
        payload_json: payloadJson,
        payload_bytes: Buffer.byteLength(payloadJson, 'utf8'),
        updated_by: String(updatedBy || '').slice(0, 128),
        created_at: Number(createdAt) || now,
        updated_at: now,
    }, ['kind', 'id'], ['group_key', 'name', 'period', 'sort_key', 'content_hash', 'summary_json', 'payload_json', 'payload_bytes', 'updated_by', 'updated_at']);
    const rows = await selectTable(TABLE, { columns: META_COLS, ...scope(kind, { id: String(id) }), limit: 1 });
    return rows.length ? toRecord(rows[0]) : null;
}

export async function deleteRecord(kind, id) {
    const key = String(id || '');
    if (!key) return false;
    const existing = await selectTable(TABLE, { columns: ['id'], ...scope(kind, { id: key }), limit: 1 });
    if (!existing.length) return false;
    await deleteRows(TABLE, scope(kind, { id: key }));
    return true;
}

/** 只保留最新的 keep 条，多出的删掉 */
export async function trimRecords(kind, keep) {
    const rows = await selectTable(TABLE, { columns: ['id', 'sort_key'], ...scope(kind), orderBySql: '`sort_key` DESC, `id` DESC', limit: 5000, memSort: newestFirst });
    for (const row of rows.slice(keep)) await deleteRows(TABLE, scope(kind, { id: row.id }));
    return Math.max(0, rows.length - keep);
}
