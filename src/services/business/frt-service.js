// FRT 核算：历史快照（最多保留 50 份）
import { BusinessError } from '../../core/errors.js';
import { listRecords, putRecord, deleteRecord, trimRecords } from '../record-store.js';

const KIND = 'frt_snapshot';
const MAX_SNAPSHOTS = 50;

export async function listFrtSnapshots() {
    return (await listRecords(KIND, { withPayload: true, limit: MAX_SNAPSHOTS })).map((r) => r.payload).filter(Boolean);
}

export async function addFrtSnapshot(payload, updatedBy = '') {
    if (!payload || typeof payload !== 'object' || !payload.month) throw new BusinessError('缺少月份（month）');
    const item = { id: Date.now().toString(36), timestamp: new Date().toISOString(), ...payload };
    await putRecord(KIND, { id: item.id, name: String(payload.name || ''), period: String(item.month), sortKey: item.timestamp, payload: item, updatedBy });
    await trimRecords(KIND, MAX_SNAPSHOTS);
    return item;
}

export const deleteFrtSnapshot = (id) => deleteRecord(KIND, id);
