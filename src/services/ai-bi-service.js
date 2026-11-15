// AI BI 看板：一张自由画布上的若干 AI 格子（格子 = AI 月报格子 + 位置）。
// 存在统一记录表 biz_records（kind=ai_bi_board），正文是整张看板（含各格子的配方和最近一次的展示结果）。
// 看板对所有已识别用户共享（与 AI 月报一致）；删除仅管理员。
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { BusinessError } from '../core/errors.js';
import { listRecords, getRecord, putRecord, deleteRecord } from './record-store.js';

const Board = createRequire(import.meta.url)('../../static/js/ai-bi/model.js');
const KIND = 'ai_bi_board';

export async function listBoards() {
    const rows = await listRecords(KIND, { limit: 200 });
    return rows.map((r) => ({ id: r.id, name: r.name, month: r.period, updatedAt: r.updatedAt, updatedBy: r.updatedBy, canvas: r.summary.canvas || null, items: r.summary.items || 0 }));
}

export async function readBoard(id) {
    const record = await getRecord(KIND, String(id || ''));
    if (!record?.payload) throw new BusinessError('看板不存在', 404);
    return { ...record.payload, id: record.id, updatedAt: record.updatedAt };
}

export async function saveBoard(input, user = '') {
    const board = Board.normalize(input || {});
    board.id ||= `board-${crypto.randomUUID()}`;
    board.updatedAt = new Date().toISOString();
    if (Buffer.byteLength(JSON.stringify(board)) > Board.LIMITS.payload) throw new BusinessError('看板内容太大，无法保存：请减少格子数量或明细行数', 413);
    await putRecord(KIND, {
        id: board.id, name: board.name, period: board.month, sortKey: String(Date.now()).padStart(15, '0'), updatedBy: user,
        summary: { canvas: board.canvas, items: board.items.length }, payload: board,
    });
    return board;
}

export async function removeBoard(id) {
    if (!(await deleteRecord(KIND, String(id || '')))) throw new BusinessError('看板不存在', 404);
    return { success: true };
}
