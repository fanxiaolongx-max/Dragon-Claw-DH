// 「按期保存的快照」的通用存取：会议考勤、操作激励这类工具都是一份带标题、日期、摘要和完整数据的快照。
// 存统一记录表；返回的字段同时带驼峰和下划线两种写法（主线版前端两种都在用）。
import { listRecords, getRecord, putRecord, deleteRecord } from '../record-store.js';

/**
 * @param {{ kind: string, dateKey: string, dateSnake: string, withSourceFile?: boolean }} options
 *   dateKey / dateSnake：日期字段在返回对象里的名字（如 meetingDate / meeting_date）
 */
export function createSnapshotStore({ kind, dateKey, dateSnake, withSourceFile = false }) {
    const toItem = (record, withPayload) => {
        const item = {
            id: record.id,
            title: record.name,
            [dateKey]: record.period,
            ...(dateSnake !== dateKey ? { [dateSnake]: record.period } : {}),
            ...(withSourceFile ? { sourceFile: record.summary?.sourceFile || '', source_file: record.summary?.sourceFile || '' } : {}),
            createdAt: record.createdAt,
            created_at: record.createdAt,
            updatedAt: record.updatedAt,
            updated_at: record.updatedAt,
            summary: record.summary?.summary || {},
        };
        if (withPayload) item.payload = record.payload ?? null;
        return item;
    };
    const newest = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(b.id).localeCompare(String(a.id));

    return {
        /** search 匹配标题 / 日期 / 来源文件 / 标识；startDate、endDate 按日期字符串比较；since 只要此后更新过的 */
        async list({ search = '', period = '', startDate = '', endDate = '', since = '', includePayload = false, latestPerMonth = false } = {}) {
            const q = String(search || '').trim().toLowerCase();
            const p = String(period || '').trim().toLowerCase();
            const sinceMs = since ? Date.parse(since) : NaN;
            let records = (await listRecords(kind, { withPayload: Boolean(includePayload), limit: 1000 })).filter((r) => {
                const date = String(r.period || '');
                if (q && ![r.name, date, r.summary?.sourceFile, r.id].some((v) => String(v || '').toLowerCase().includes(q))) return false;
                if (p && !date.toLowerCase().includes(p)) return false;
                if (startDate && date < String(startDate).trim()) return false;
                if (endDate && date > String(endDate).trim()) return false;
                if (Number.isFinite(sinceMs) && Date.parse(r.updatedAt || r.createdAt) < sinceMs) return false;
                return true;
            });
            if (latestPerMonth) {
                // 每个自然月只取最后保存的那一版；没有日期的旧快照各算各的
                const seen = new Set();
                records = records.sort(newest).filter((r) => {
                    const month = /^(\d{4}-(?:0[1-9]|1[0-2]))(?:-|$)/.exec(String(r.period || '').trim())?.[1];
                    if (!month) return true;
                    if (seen.has(month)) return false;
                    seen.add(month);
                    return true;
                });
            } else {
                records.sort((a, b) => String(b.period).localeCompare(String(a.period)) || newest(a, b));
            }
            return records.map((r) => toItem(r, Boolean(includePayload)));
        },
        async get(id) {
            const key = String(id || '').trim();
            const record = key ? await getRecord(kind, key) : null;
            return record ? toItem(record, true) : null;
        },
        async save({ id, title, date, sourceFile = '', summary = {}, payload = {} }, updatedBy = '') {
            const existing = await getRecord(kind, String(id));
            await putRecord(kind, {
                id: String(id), name: String(title), period: String(date), sortKey: String(date),
                summary: { summary: summary || {}, ...(withSourceFile ? { sourceFile: String(sourceFile || '') } : {}) },
                payload: payload || {}, updatedBy, createdAt: existing ? Date.parse(existing.createdAt) : 0,
            });
            return this.get(id);
        },
        async rename(id, title, updatedBy = '') {
            const record = await getRecord(kind, String(id || '').trim());
            if (!record) return null;
            await putRecord(kind, { id: record.id, name: String(title), period: record.period, sortKey: record.sortKey, summary: record.summary, payload: record.payload, updatedBy, createdAt: Date.parse(record.createdAt) });
            return this.get(record.id);
        },
        remove: (id) => deleteRecord(kind, String(id || '').trim()),
    };
}
