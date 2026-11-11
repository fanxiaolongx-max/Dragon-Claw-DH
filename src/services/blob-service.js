import { selectTable, upsertRow, deleteRows, sqlVal, parseJsonCol } from '../dao/scoped.js';

export async function saveBlobAsset({ key, category = 'general', filename = '', mimeType = 'application/octet-stream', buffer, base64, meta = null }) {
    const b64 = base64 !== undefined ? String(base64) : (Buffer.isBuffer(buffer) ? buffer.toString('base64') : '');
    const now = Date.now();
    const sizeBytes = Buffer.byteLength(b64, 'base64');
    await upsertRow('dh_blob_assets', {
        asset_key: String(key),
        category: String(category || 'general'),
        filename: String(filename || key),
        mime_type: String(mimeType || 'application/octet-stream'),
        size_bytes: sizeBytes,
        data_base64: b64,
        meta_json: meta ? JSON.stringify(meta) : null,
        created_at: now,
        updated_at: now,
    }, ['asset_key'], ['category', 'filename', 'mime_type', 'size_bytes', 'data_base64', 'meta_json', 'updated_at']);
    return { key, category, filename, mimeType, sizeBytes };
}

export async function getBlobAsset(key) {
    const rows = await selectTable('dh_blob_assets', {
        whereSql: `\`asset_key\` = ${sqlVal(key)}`,
        limit: 1,
        memFilter: (r) => r.asset_key === key,
    });
    if (!rows.length) return null;
    const row = rows[0];
    return {
        key: row.asset_key,
        category: row.category,
        filename: row.filename,
        mimeType: row.mime_type || 'application/octet-stream',
        sizeBytes: Number(row.size_bytes) || 0,
        buffer: row.data_base64 ? Buffer.from(row.data_base64, 'base64') : Buffer.alloc(0),
        base64: row.data_base64 || '',
        meta: parseJsonCol(row.meta_json, null),
    };
}

export async function listBlobAssets(category = '') {
    const whereSql = category ? `\`category\` = ${sqlVal(category)}` : '';
    const rows = await selectTable('dh_blob_assets', {
        columns: ['asset_key', 'category', 'filename', 'mime_type', 'size_bytes', 'created_at', 'updated_at'],
        whereSql,
        orderBySql: '`updated_at` DESC',
        limit: 500,
        memFilter: category ? (r) => r.category === category : null,
        memSort: (a, b) => (b.updated_at || 0) - (a.updated_at || 0),
    });
    return rows;
}

export async function deleteBlobAsset(key) {
    return deleteRows('dh_blob_assets', {
        whereSql: `\`asset_key\` = ${sqlVal(key)}`,
        memFilter: (r) => r.asset_key === key,
    });
}
