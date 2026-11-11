// 对话附件：保存原文件，并尽量提取成文本供模型阅读（read_file 工具）。
import crypto from 'node:crypto';
import { BusinessError } from '../core/errors.js';
import { selectTable, insertRow, deleteRows, sqlVal } from '../dao/scoped.js';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 400_000; // 提取文本的保存上限（字符）
const KEEP_PER_USER = 60;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|xml|ya?ml|html?|js|mjs|ts|py|java|go|sql|sh|css|ini|conf|toml)$/i;

const stripXml = (xml) => xml.replace(/<\/(?:w:p|a:p|row|p)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");

async function tryImport(name) {
    try { return await import(name); } catch { return null; }
}

function cellText(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
    if (typeof value === 'object') {
        if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
        if (value.result !== undefined) return cellText(value.result);
        if (value.text !== undefined) return String(value.text);
        if (value.error) return String(value.error);
        return JSON.stringify(value);
    }
    return String(value);
}

/** 把文件内容提取成文本；提取不了时返回空字符串和原因 */
async function extractText(filename, buffer) {
    const name = String(filename || '').toLowerCase();
    if (TEXT_EXT.test(name)) return { text: buffer.toString('utf8') };
    if (/\.(xlsx|xlsm)$/.test(name)) {
        const mod = await tryImport('exceljs');
        if (!mod) return { text: '', note: '当前安装包（精简包）不含 Excel 解析组件，无法读取表格内容' };
        const wb = new (mod.default || mod).Workbook();
        await wb.xlsx.load(buffer);
        const parts = [];
        for (const ws of wb.worksheets) {
            parts.push(`## 工作表：${ws.name}（${ws.rowCount} 行 × ${ws.columnCount} 列）`);
            ws.eachRow({ includeEmpty: false }, (row) => {
                const cells = [];
                for (let c = 1; c <= ws.columnCount; c++) cells.push(cellText(row.getCell(c).value).replace(/[\t\r\n]+/g, ' '));
                parts.push(cells.join('\t').replace(/\t+$/, ''));
            });
            if (parts.join('\n').length > MAX_TEXT) break;
        }
        return { text: parts.join('\n') };
    }
    if (/\.(docx|pptx)$/.test(name)) {
        const mod = await tryImport('jszip');
        if (!mod) return { text: '', note: '当前安装包（精简包）不含文档解析组件' };
        const zip = await (mod.default || mod).loadAsync(buffer);
        const files = Object.keys(zip.files).filter((f) => (name.endsWith('.docx') ? /^word\/document\.xml$/.test(f) : /^ppt\/slides\/slide\d+\.xml$/.test(f)))
            .sort((a, b) => Number(/\d+/.exec(a)?.[0] || 0) - Number(/\d+/.exec(b)?.[0] || 0));
        const parts = [];
        for (const [i, f] of files.entries()) {
            if (name.endsWith('.pptx')) parts.push(`## 第 ${i + 1} 页`);
            parts.push(stripXml(await zip.files[f].async('string')).replace(/\n{3,}/g, '\n\n').trim());
        }
        return { text: parts.join('\n\n') };
    }
    return { text: '', note: '这种文件类型暂不支持提取文字内容' };
}

export async function saveChatUpload({ filename, mimeType = '', buffer, ownerId }) {
    if (!buffer?.length) throw new BusinessError('文件内容为空');
    if (buffer.length > MAX_BYTES) throw new BusinessError('单个附件不能超过 20 MB');
    const name = String(filename || 'file').replace(/[\\/\0]/g, '_').slice(0, 200);
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    let extracted = { text: '', note: '' };
    try { extracted = await extractText(name, buffer); } catch (error) { extracted = { text: '', note: `解析失败：${error.message}` }; }
    const text = String(extracted.text || '');
    await insertRow('ai_chat_uploads', {
        id,
        owner_id: ownerId,
        filename: name,
        mime_type: String(mimeType || '').slice(0, 120),
        size_bytes: buffer.length,
        text_content: text ? text.slice(0, MAX_TEXT) : (extracted.note ? `【${extracted.note}】` : ''),
        data_base64: buffer.toString('base64'),
        created_at: Date.now(),
    });
    // 每人只保留最近的若干个附件
    const mine = await selectTable('ai_chat_uploads', {
        columns: ['id', 'created_at'],
        whereSql: `\`owner_id\` = ${sqlVal(ownerId)}`,
        orderBySql: '`created_at` DESC',
        limit: 500,
        memFilter: (r) => r.owner_id === ownerId,
        memSort: (a, b) => (b.created_at || 0) - (a.created_at || 0),
    });
    for (const old of mine.slice(KEEP_PER_USER)) {
        await deleteRows('ai_chat_uploads', { whereSql: `\`id\` = ${sqlVal(old.id)}`, memFilter: (r) => r.id === old.id }).catch(() => {});
    }
    return { id, path: `uploads/${id}/${name}`, name, size: buffer.length, readable: Boolean(text), note: extracted.note || '' };
}

/** path 形如 uploads/<id>/<文件名>；只能读自己的附件 */
export async function readChatUpload(filePath, ownerId, { withData = false } = {}) {
    const id = /(?:^|\/)uploads\/([a-z0-9]{8,40})(?:\/|$)/i.exec(String(filePath || ''))?.[1];
    if (!id) return null;
    const rows = await selectTable('ai_chat_uploads', {
        columns: withData ? ['*'] : ['id', 'owner_id', 'filename', 'mime_type', 'size_bytes', 'text_content', 'created_at'],
        whereSql: `\`id\` = ${sqlVal(id)}`,
        limit: 1,
        memFilter: (r) => r.id === id,
    });
    const row = rows[0];
    if (!row || row.owner_id !== ownerId) return null;
    return {
        id: row.id,
        name: row.filename,
        mimeType: row.mime_type,
        size: Number(row.size_bytes) || 0,
        text: row.text_content || '',
        buffer: withData && row.data_base64 ? Buffer.from(row.data_base64, 'base64') : null,
    };
}
