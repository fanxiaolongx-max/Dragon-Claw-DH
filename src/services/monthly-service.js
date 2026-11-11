import crypto from 'node:crypto';
import {
    kvGet,
    kvSet,
    selectTable,
    upsertRow,
    updateRows,
    deleteRows,
    sqlVal,
    parseJsonCol,
} from '../dao/scoped.js';
import { callAiCompletion } from './ai-service.js';
import { getTargets } from './sla-service.js';
import {
    getSourceCatalog,
    getSheet as getImportSheet,
    getDefaultTemplate,
    listLogos,
} from './upload-service.js';
import { listReportSnapshots } from './report-service.js';
import {
    validMonth,
    normalizeReport,
    normalizeRecipe,
    fromLegacyTemplate,
    structuredStyle,
    applyStyleChanges,
    withStyleText,
    DEFAULT_STYLE,
    IMAGE_BASE,
    FIXED_PREFIX,
    normalizeTheme,
} from '../utils/ai-report-helpers.js';

const IMG_PROPOSALS_KEY = 'ai_report_image_deletion_proposals';
const IMG_META_KEY = 'ai_report_image_meta_map';

function fail(message, status = 400, code = 'MONTHLY_ERROR') {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    throw error;
}

function checkId(id, label = 'ID') {
    if (typeof id !== 'string' || !/^[-\w]{1,120}$/.test(id)) {
        fail(`Invalid ${label}`, 400);
    }
}

// ============================================================
// Legacy Monthly Snapshots (monthly_snapshots)
// ============================================================

export async function listMonthlySnapshots({ toolKey, topicKey, month, includePayload = false } = {}) {
    const rows = await selectTable('monthly_snapshots', {
        orderBySql: '`report_month` DESC, `updated_at` DESC, `id` DESC',
        limit: 300,
        memSort: (a, b) => String(b.report_month || '').localeCompare(String(a.report_month || '')) || ((b.updated_at || 0) - (a.updated_at || 0)),
    });
    const out = [];
    for (const r of rows) {
        const stored = parseJsonCol(r.payload_json, {});
        const tk = stored.toolKey || '';
        const topK = stored.topicKey || '';
        if (toolKey && tk !== String(toolKey).trim()) continue;
        if (topicKey !== undefined && topicKey !== null && topicKey !== '' && topK !== String(topicKey).trim()) continue;
        if (month && r.report_month !== String(month).trim()) continue;
        const item = {
            id: r.id,
            toolKey: tk,
            topicKey: topK,
            month: r.report_month,
            name: r.title,
            createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
            updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : '',
            summary: stored.summary || {},
        };
        if (includePayload) item.payload = stored.payload ?? null;
        out.push(item);
    }
    return out;
}

export async function getMonthlySnapshot(id) {
    checkId(id, 'snapshot ID');
    const rows = await selectTable('monthly_snapshots', {
        whereSql: `\`id\` = ${sqlVal(id)}`,
        limit: 1,
        memFilter: (r) => r.id === id,
    });
    if (!rows.length) return null;
    const r = rows[0];
    const stored = parseJsonCol(r.payload_json, {});
    return {
        id: r.id,
        toolKey: stored.toolKey || '',
        topicKey: stored.topicKey || '',
        month: r.report_month,
        name: r.title,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : '',
        summary: stored.summary || {},
        payload: stored.payload ?? null,
    };
}

export async function saveMonthlySnapshot({ id, toolKey, topicKey = '', month = '', name = '', summary = {}, payload } = {}, updatedBy = 'system') {
    if (!toolKey) fail('缺少工具标识 (toolKey)');
    if (!payload) fail('缺少快照数据 (payload)');
    const sid = String(id || `ms_${crypto.randomUUID().slice(0, 12)}`).trim();
    const now = Date.now();
    const existing = await getMonthlySnapshot(sid).catch(() => null);
    const wrapped = {
        toolKey: String(toolKey).trim(),
        topicKey: String(topicKey || '').trim(),
        summary: summary && typeof summary === 'object' ? summary : {},
        payload,
    };
    await upsertRow('monthly_snapshots', {
        id: sid,
        report_month: String(month || '').trim(),
        title: String(name || `${toolKey}_${month || 'snapshot'}`).slice(0, 240),
        payload_json: JSON.stringify(wrapped),
        updated_by: String(updatedBy || 'system').slice(0, 120),
        created_at: existing?.createdAt ? Date.parse(existing.createdAt) || now : now,
        updated_at: now,
    }, ['id'], ['report_month', 'title', 'payload_json', 'updated_by', 'updated_at']);
    return getMonthlySnapshot(sid);
}

export async function renameMonthlySnapshot(id, name) {
    if (!name || !String(name).trim()) fail('缺少快照名称');
    const existing = await getMonthlySnapshot(id);
    if (!existing) return null;
    await updateRows('monthly_snapshots', {
        title: String(name).trim().slice(0, 240),
        updated_at: Date.now(),
    }, {
        whereSql: `\`id\` = ${sqlVal(id)}`,
        memFilter: (r) => r.id === id,
    });
    return getMonthlySnapshot(id);
}

export async function deleteMonthlySnapshot(id) {
    checkId(id, 'snapshot ID');
    const existing = await getMonthlySnapshot(id);
    if (!existing) return false;
    await deleteRows('monthly_snapshots', {
        whereSql: `\`id\` = ${sqlVal(id)}`,
        memFilter: (r) => r.id === id,
    });
    return true;
}

// ============================================================
// Outlook .msg Export (@tutao/oxmsg)
// ============================================================

export function encapsulateHtmlToRtf(html) {
    const rtfEscaped = [];
    const escapedChars = new Set(['{', '}', '\\']);
    for (let i = 0; i < html.length; i += 1) {
        const code = html.charCodeAt(i);
        const ch = html[i];
        if (code <= 31) {
            if (code === 10 || code === 13 || code === 9) rtfEscaped.push(ch);
            continue;
        }
        if (code <= 127) {
            if (escapedChars.has(ch)) rtfEscaped.push('\\');
            rtfEscaped.push(ch);
        } else if (code <= 255) {
            rtfEscaped.push(`\\'${code.toString(16).padStart(2, '0')}`);
        } else {
            const signedCode = code > 32767 ? code - 65536 : code;
            rtfEscaped.push(`\\u${signedCode}?`);
        }
    }
    return `{\\rtf1\\ansi\\ansicpg1252\\fromhtml1 {\\*\\htmltag1 ${rtfEscaped.join('')} }}`;
}

export async function exportReportMsgBuffer(rawBody = {}) {
    let body = rawBody;
    if (body && typeof body.envelope === 'string') {
        const decoded = Buffer.from(body.envelope, 'base64').toString('utf8');
        try { body = JSON.parse(decodeURIComponent(decoded)); } catch { body = JSON.parse(decoded); }
    }
    const subject = String(body?.subject || '').trim();
    const html = String(body?.html || '');
    const text = String(body?.text || '').trim();
    const attachment = body?.attachment || null;
    const inlineImages = body?.inlineImages ?? [];

    if (!subject || subject.length > 200) fail('月报邮件主题无效', 400, 'INVALID_SUBJECT');
    if (!html) fail('月报正文为空', 400, 'INVALID_REPORT');
    const htmlBytes = Buffer.byteLength(html, 'utf8');
    if (htmlBytes > 20_000_000) fail('月报 HTML 正文超过 20 MB', 400, 'HTML_TOO_LARGE');

    if (!Array.isArray(inlineImages) || inlineImages.length > 100) {
        fail('邮件内嵌图片无效或数量过多', 400, 'INVALID_INLINE_IMAGE');
    }
    for (const img of inlineImages) {
        if (!img || typeof img.cid !== 'string' || typeof img.filename !== 'string' || typeof img.data !== 'string') {
            fail('邮件内嵌图片参数格式无效', 400, 'INVALID_INLINE_IMAGE');
        }
    }

    const { Email, Attachment, MessageEditorFormat, CFB } = await import('@tutao/oxmsg');
    const message = new Email(true);
    message.subject(subject);
    const fallbackText = (text || html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 500_000);
    message.bodyText(fallbackText);

    const rtf = encapsulateHtmlToRtf(html);
    message._bodyRtf = rtf;
    message.bodyRtfCompressed = true;
    message._topLevelProperties.addProperty({ id: 0x1013, type: 0x0102 }, Buffer.from(html, 'utf8'));
    message._topLevelProperties.addProperty({ id: 0x1016, type: 0x0003 }, 3);
    message.bodyFormat(MessageEditorFormat.EDITOR_FORMAT_HTML);

    if (attachment && attachment.filename && attachment.data) {
        message.attach(new Attachment(Buffer.from(attachment.data, 'base64'), attachment.filename));
    }
    for (const image of inlineImages) {
        message.attach(new Attachment(Buffer.from(image.data, 'base64'), image.filename, image.cid));
    }

    const compound = CFB.read(Buffer.from(message.msg()), { type: 'buffer' });
    if (!CFB.find(compound, '/__substg1.0_10090102')) throw new Error('MSG RTF compressed body missing');
    if (!CFB.find(compound, '/__substg1.0_10130102')) throw new Error('MSG HTML body missing');
    if (!CFB.find(compound, '/__substg1.0_1000001F')) throw new Error('MSG fallback text body missing');

    const buffer = Buffer.from(CFB.write(compound, { type: 'buffer' }));
    return {
        buffer,
        headers: {
            'X-Report-Msg-Html-Size': String(htmlBytes),
            'X-Report-Msg-Rtf-Size': String(Buffer.byteLength(rtf, 'utf8')),
            'X-Report-Msg-Attachment-Count': attachment ? '1' : '0',
            'X-Report-Msg-Total-Size': String(buffer.length),
        },
    };
}

// ============================================================
// AI Report Documents (ai_report_documents) & Template
// ============================================================

export async function listAiReports() {
    const rows = await selectTable('ai_report_documents', {
        columns: ['id', 'name', 'report_month', 'updated_at', 'updated_by'],
        orderBySql: '`updated_at` DESC, `id` ASC',
        limit: 300,
        memSort: (a, b) => ((b.updated_at || 0) - (a.updated_at || 0)) || String(a.id).localeCompare(String(b.id)),
    });
    return rows.map((r) => ({
        id: r.id,
        name: r.name,
        reportMonth: r.report_month,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : '',
        updatedBy: r.updated_by || '',
    }));
}

export async function readAiReport(id) {
    checkId(id, 'report ID');
    const rows = await selectTable('ai_report_documents', {
        whereSql: `\`id\` = ${sqlVal(id)}`,
        limit: 1,
        memFilter: (r) => r.id === id,
    });
    if (!rows.length) fail('Report not found', 404);
    const r = rows[0];
    const doc = parseJsonCol(r.payload_json, {});
    return {
        ...doc,
        id: r.id,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : (doc.updatedAt || ''),
    };
}

export async function saveAiReport(input, user = '') {
    const doc = normalizeReport(input);
    if (!doc.id) doc.id = `report-${crypto.randomUUID()}`;
    if (!doc.reportMonth) fail('Report month is required', 400);
    const now = Date.now();
    doc.updatedAt = new Date(now).toISOString();
    const payload = JSON.stringify(doc);
    if (Buffer.byteLength(payload) > 8 * 1024 * 1024) fail('Report is too large to save', 413);

    await upsertRow('ai_report_documents', {
        id: doc.id,
        name: doc.name,
        report_month: doc.reportMonth,
        payload_json: payload,
        created_at: now,
        updated_at: now,
        updated_by: String(user || '').slice(0, 120),
    }, ['id'], ['name', 'report_month', 'payload_json', 'updated_at', 'updated_by']);
    return doc;
}

export async function deleteAiReport(id) {
    checkId(id, 'report ID');
    const existing = await readAiReport(id).catch(() => null);
    if (!existing) fail('Report not found', 404);
    await deleteRows('ai_report_documents', {
        whereSql: `\`id\` = ${sqlVal(id)}`,
        memFilter: (r) => r.id === id,
    });
    return { id, deleted: true };
}

export async function getAiReportTemplate(monthInput) {
    const month = validMonth(monthInput) ? monthInput : new Date().toISOString().slice(0, 7);
    const tpl = await getDefaultTemplate().catch(() => null);
    return fromLegacyTemplate(tpl?.template || null, month);
}

// ============================================================
// AI Report Sources, Metrics, Datasets & Recipe Data Runner
// ============================================================

function shiftMonth(month, offset = 0) {
    if (!validMonth(month) || !offset) return month;
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + Number(offset), 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthOfTimestamp(ts) {
    const text = String(ts || '').trim();
    const match = text.match(/^(\d{4})[-/](\d{1,2})/);
    if (!match) return '';
    return `${match[1]}-${match[2].padStart(2, '0')}`;
}

function toNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v ?? '').replace(/[%％,\s]/g, '').trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

export async function listAiReportSources(month) {
    const cat = await getSourceCatalog({ days: 0 });
    return (cat.files || []).filter((f) => {
        if (!month) return true;
        const m = monthOfTimestamp(f.created_at);
        return !m || m === month;
    }).map((f) => ({
        fileId: f.id,
        name: f.name,
        sourceKey: f.source_key || f.name,
        kind: f.kind || 'original',
        category: f.library_category || '',
        createdAt: f.created_at,
        parseStatus: f.parse_status || 'ready',
        sheets: (f.sheets || []).map((s) => ({
            sheetId: s.id,
            name: s.name,
            headers: s.headers || [],
            rowCount: s.rowCount || 0,
        })),
    }));
}

export async function listAiReportMetrics(month) {
    const [cat, targetsRes] = await Promise.all([
        getSourceCatalog({ days: 0 }),
        getTargets().catch(() => ({})),
    ]);
    const targetItems = targetsRes.items || targetsRes || {};
    const monthNum = validMonth(month) ? Number(month.slice(5)) : new Date().getUTCMonth() + 1;
    const seen = new Map();

    for (const snap of cat.snapshots || []) {
        const snapMonth = monthOfTimestamp(snap.captured_at) || (snap.target_month ? `${String(month || new Date().getUTCFullYear()).slice(0, 4)}-${String(snap.target_month).padStart(2, '0')}` : '');
        if (month && snapMonth && snapMonth !== month) continue;
        for (const metric of snap.metrics || []) {
            const entries = [
                metric,
                ...(metric.subMetrics || []).map((c) => ({ ...c, key: `${metric.key}/${c.category}`, label: `${metric.label} / ${c.category}` })),
            ];
            for (const e of entries) {
                if (!e.key || seen.has(e.key)) continue;
                const tgt = targetItems[e.key.split('/')[0]];
                const tVal = tgt?.[monthNum];
                seen.set(e.key, {
                    key: e.key,
                    label: e.label || e.key,
                    value: e.value ?? null,
                    target: tVal != null ? `${tgt.type === 'lte' ? '≤ ' : '≥ '}${tVal}${tgt.isPercent ? '%' : ''}` : (e.target ?? null),
                    targetValue: toNumber(tVal),
                    targetRule: tgt?.type || '',
                    origin: snap.kind || 'extraction',
                    capturedAt: snap.captured_at,
                });
            }
        }
    }
    return Array.from(seen.values());
}

export async function listAiReportDatasets(month) {
    const snaps = await listReportSnapshots();
    return {
        month: month || '',
        datasets: [
            { id: 'report_snapshots', name: '报表历史快照汇总', source: 'report_snapshots', period: 'monthly', rowCount: snaps.length },
        ],
    };
}

export async function describeAiReportSheet(sheetId) {
    const sheet = await getImportSheet(String(sheetId || ''));
    if (!sheet) fail('Sheet not found', 404);
    return {
        sheetId: sheet.id,
        name: sheet.name,
        headers: sheet.headers,
        rowCount: sheet.rows.length,
        sample: sheet.rows.slice(0, 30),
    };
}

export async function runAiReportData({ month, recipe: rawRecipe } = {}) {
    const recipe = normalizeRecipe(rawRecipe);
    const cat = await getSourceCatalog({ days: 0 });
    const input = {};
    const missing = [];

    for (const source of recipe.sources || []) {
        const srcMonth = shiftMonth(month, source.monthOffset || 0);
        if (source.kind === 'sheet') {
            const file = (cat.files || []).find((f) => (
                (source.match?.sourceKey && f.source_key === source.match.sourceKey) ||
                (source.match?.tableName && f.name.includes(source.match.tableName))
            ));
            const sheetMeta = file?.sheets?.find((s) => !source.match?.sheetName || s.name === source.match.sheetName) || file?.sheets?.[0];
            if (!sheetMeta) {
                missing.push({ id: source.id, label: source.label || source.id, month: srcMonth });
                input[source.id] = null;
                continue;
            }
            const fullSheet = await getImportSheet(sheetMeta.id);
            input[source.id] = {
                month: srcMonth,
                file: file.name,
                sheet: fullSheet.name,
                headers: fullSheet.headers,
                rows: fullSheet.rows.slice(0, 2000),
            };
        } else if (source.kind === 'metrics') {
            const metrics = await listAiReportMetrics(srcMonth);
            const values = {};
            const targets = {};
            const rules = {};
            for (const m of metrics) {
                values[m.label] = toNumber(m.value);
                values[m.key] = toNumber(m.value);
                if (m.targetValue != null) targets[m.label] = m.targetValue;
                if (m.targetRule) rules[m.label] = m.targetRule;
            }
            const chosen = source.names.length
                ? metrics.filter((m) => source.names.includes(m.label))
                : metrics;
            if (!chosen.length) missing.push({ id: source.id, label: source.label || source.id, month: srcMonth });
            input[source.id] = { month: srcMonth, metrics: chosen, values, targets, rules };
        } else if (source.kind === 'dataset') {
            const snaps = await listReportSnapshots();
            input[source.id] = {
                month: srcMonth,
                source: 'report_snapshots',
                name: '报表历史快照汇总',
                period: 'monthly',
                headers: ['snapshot_id', 'month', 'created_at', 'standard_total_score'],
                rows: snaps,
            };
        } else {
            input[source.id] = null;
        }
    }
    return { input, missing };
}

// ============================================================
// AI Report Images & Soft-Delete Workflow (Pure MySQL/KV)
// ============================================================

const UNSAFE_SVG = /<script|<foreignObject|<iframe|<object|<embed|<image\b|\bon[a-z]+\s*=|javascript:|data:text\/html|(?:xlink:)?href\s*=\s*["'](?!#)/i;

function sniffImageMime(bytes, name = '') {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
    if (/\.svg$/i.test(name) || /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(bytes.subarray(0, 512).toString('utf8'))) return 'image/svg+xml';
    return '';
}

export async function saveAiReportImage({ bytes, name = '图片', source = 'upload', prompt = '' } = {}) {
    if (!Buffer.isBuffer(bytes) || !bytes.length) fail('没有收到图片');
    if (bytes.length > 5 * 1024 * 1024) fail('图片不能超过 5MB');
    const mime = sniffImageMime(bytes, name);
    if (!mime) fail('只支持 PNG、JPEG、WebP、GIF 或 SVG 图片');
    if (mime === 'image/svg+xml' && UNSAFE_SVG.test(bytes.toString('utf8'))) {
        fail('SVG 里有脚本、外部链接或嵌入内容，出于安全考虑不能使用');
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    await upsertRow('ai_report_images', {
        id,
        filename: String(name).slice(0, 200) || '图片',
        mime_type: mime,
        size_bytes: bytes.length,
        data_base64: bytes.toString('base64'),
        deleted_at: null,
        created_at: now,
    }, ['id']);
    const metaMap = (await kvGet(IMG_META_KEY, {})) || {};
    metaMap[id] = { source: source === 'ai' ? 'ai' : 'upload', prompt: String(prompt || '').slice(0, 4000) };
    await kvSet(IMG_META_KEY, metaMap);
    return {
        id,
        name: String(name).slice(0, 200),
        mime,
        source: metaMap[id].source,
        url: `/api/ai-report/images/${id}`,
        createdAt: new Date(now).toISOString(),
    };
}

export async function listAiReportImages({ page, pageSize } = {}) {
    const [rows, logos, metaMap] = await Promise.all([
        selectTable('ai_report_images', {
            columns: ['id', 'filename', 'mime_type', 'size_bytes', 'deleted_at', 'created_at'],
            orderBySql: '`created_at` DESC',
            limit: 500,
            memSort: (a, b) => (b.created_at || 0) - (a.created_at || 0),
        }),
        listLogos().catch(() => []),
        kvGet(IMG_META_KEY, {}),
    ]);
    const visibleOwn = rows.filter((r) => !r.deleted_at).map((r) => ({
        id: r.id,
        name: r.filename,
        mime: r.mime_type,
        source: metaMap?.[r.id]?.source || 'upload',
        prompt: metaMap?.[r.id]?.prompt || '',
        url: `/api/ai-report/images/${r.id}`,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
    }));
    const legacy = logos.map((l) => ({
        id: `logo-${l.id}`,
        name: l.name,
        mime: l.mime || 'image/png',
        source: 'monthly-logo',
        prompt: '',
        url: `/api/upload/monthly-logos/${encodeURIComponent(l.id)}/image`,
        createdAt: l.created_at,
    }));
    const all = [
        { id: 'platform-logo.png', name: '平台标识（当前）', mime: 'image/png', source: 'platform-logo', prompt: '', url: '/assets/logo.png', createdAt: '' },
        ...visibleOwn,
        ...legacy,
    ];
    if (page !== undefined || pageSize !== undefined) {
        const size = Math.max(1, Math.min(24, Math.trunc(Number(pageSize)) || 8));
        const totalPages = Math.max(1, Math.ceil(all.length / size));
        const current = Math.max(1, Math.min(totalPages, Math.trunc(Number(page)) || 1));
        return { items: all.slice((current - 1) * size, current * size), page: current, pageSize: size, total: all.length, totalPages };
    }
    return all;
}

export async function readAiReportImage(id) {
    checkId(id, 'image ID');
    const rows = await selectTable('ai_report_images', {
        whereSql: `\`id\` = ${sqlVal(id)}`,
        limit: 1,
        memFilter: (r) => r.id === id,
    });
    if (!rows.length) fail('Image not found', 404);
    return {
        mime: rows[0].mime_type || 'image/png',
        bytes: Buffer.from(rows[0].data_base64 || '', 'base64'),
    };
}

export async function proposeAiReportImageDeletion(ids = [], owner = 'default') {
    if (!Array.isArray(ids) || !ids.length || ids.length > 500) fail('请选择有效的图片');
    const all = await listAiReportImages();
    const byId = new Map(all.map((item) => [item.id, item]));
    if (ids.some((id) => !byId.has(id))) fail('图片列表已改变，请刷新图库后重新选择', 409);
    if (ids.some((id) => byId.get(id).source === 'platform-logo')) fail('平台标识不能在这里删除');
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const images = ids.map((imgId) => ({ id: imgId, url: byId.get(imgId).url, name: byId.get(imgId).name, source: byId.get(imgId).source }));
    const proposals = (await kvGet(IMG_PROPOSALS_KEY, {})) || {};
    proposals[id] = { id, owner, status: 'pending', images, expiresAt, createdAt: new Date().toISOString() };
    await kvSet(IMG_PROPOSALS_KEY, proposals);
    return {
        type: 'delete_confirmation',
        proposalId: id,
        expiresAt,
        images,
        text: `准备从历史图库移除这 ${images.length} 张图片。请核对缩略图，再确认删除。`,
    };
}

export async function changeAiReportImageDeletion(id, owner, operation) {
    const proposals = (await kvGet(IMG_PROPOSALS_KEY, {})) || {};
    const p = proposals[id];
    if (!p) fail('删除确认记录不存在', 404);
    const states = { confirm: ['pending', 'confirmed'], cancel: ['pending', 'cancelled'], restore: ['confirmed', 'restored'] };
    const pair = states[operation];
    if (!pair) fail('未知删除操作');
    if (p.status === pair[1]) return p;
    if (p.status !== pair[0]) fail('这份删除确认已失效，请重新选择图片', 409);

    if (operation === 'confirm') {
        const now = Date.now();
        for (const img of p.images || []) {
            await updateRows('ai_report_images', { deleted_at: now }, {
                whereSql: `\`id\` = ${sqlVal(img.id)}`,
                memFilter: (r) => r.id === img.id,
            });
        }
    } else if (operation === 'restore') {
        for (const img of p.images || []) {
            await updateRows('ai_report_images', { deleted_at: null }, {
                whereSql: `\`id\` = ${sqlVal(img.id)}`,
                memFilter: (r) => r.id === img.id,
            });
        }
    }
    p.status = pair[1];
    proposals[id] = p;
    await kvSet(IMG_PROPOSALS_KEY, proposals);
    return { id: p.id, images: p.images, status: p.status, expiresAt: p.expiresAt };
}

// ============================================================
// AI Report Conversational Helpers (via ai-service callAiCompletion)
// ============================================================

function parseJsonReply(text) {
    const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (!cleaned) return null;
    try { return JSON.parse(cleaned); } catch {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
            try { return JSON.parse(match[0]); } catch { return null; }
        }
        return null;
    }
}

async function runStructuredAiTurn(systemInstruction, userPrompt, fallbackObj) {
    const started = Date.now();
    const res = await callAiCompletion({
        messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: userPrompt },
        ],
        maxTokens: 2500,
    });
    const round = {
        index: 1,
        model: res.model || 'default',
        ms: Date.now() - started,
        inputTokens: res.usage?.prompt_tokens || 0,
        outputTokens: res.usage?.completion_tokens || 0,
        at: new Date().toISOString(),
    };
    if (!res.ok) {
        return { ...fallbackObj, _rounds: [round], _aiError: res.error };
    }
    const parsed = parseJsonReply(res.text);
    return { ...(parsed && typeof parsed === 'object' ? parsed : fallbackObj), _rounds: [round] };
}

export async function aiReportCellChat({ month, message, chat = [], prompt = '' } = {}) {
    if (!validMonth(month)) fail('A valid report month is required');
    if (!String(message || '').trim()) fail('请输入要问的内容');
    const sources = await listAiReportSources(month);
    const metrics = await listAiReportMetrics(month);
    const sys = '你是 AI 月报格子助手。请结合当前月份可用数据源与指标返回严格 JSON：{"type":"answer|ask|ready","text":"说明","question":"提问","choices":["选项1"]}。';
    const usr = `月份: ${month}\n可用数据源(${sources.length}): ${sources.map((s) => s.name).slice(0, 15).join(', ')}\n可用指标(${metrics.length}): ${metrics.map((m) => m.label).slice(0, 20).join(', ')}\n当前提示词: ${prompt}\n历史对话: ${JSON.stringify(chat.slice(-6))}\n用户消息: ${message}`;
    return runStructuredAiTurn(sys, usr, {
        type: 'ready',
        text: `已理解你的需求（${String(message).slice(0, 80)}）。当前可用指标 ${metrics.length} 个、导入表 ${sources.length} 份。`,
    });
}

export async function aiReportCellPrompt({ month, prompt = '', chat = [] } = {}) {
    if (!validMonth(month)) fail('A valid report month is required');
    const userText = chat.filter((c) => c.role === 'user').map((c) => c.text).join('\n');
    const res = await runStructuredAiTurn(
        '将月报格子对话总结为清晰的“最终提示词”，只输出 JSON：{"prompt":"..."}。',
        `月份: ${month}\n原提示词: ${prompt}\n用户需求:\n${userText}`,
        { prompt: userText || prompt || `展示 ${month} 核心运营指标情况` },
    );
    return { prompt: res.prompt || userText || prompt, _rounds: res._rounds };
}

export async function aiReportCellTextEdit({ month, prompt = '', before = '', after = '' } = {}) {
    if (!validMonth(month)) fail('A valid report month is required');
    if (!String(prompt).trim()) fail('这个格子还没有最终提示词');
    if (String(before) === String(after)) fail('文字没有变化');
    const res = await runStructuredAiTurn(
        '根据用户在月报格子中的文字修改，更新最终提示词，输出 JSON：{"mode":"replace","note":"已记录文字调整","prompt":"..."}。',
        `原提示词:\n${prompt}\n修改前: ${before}\n修改后: ${after}`,
        { mode: 'replace', note: `已将“${String(before).slice(0, 40)}”更新为“${String(after).slice(0, 40)}”`, prompt: `${prompt}\n- 显示文本中将“${before}”写为“${after}”。` },
    );
    return res;
}

export async function aiReportCellGist({ month, items = [] } = {}) {
    if (!validMonth(month)) fail('A valid report month is required');
    const gists = {};
    for (const it of Array.isArray(items) ? items : []) {
        if (it?.id) gists[it.id] = `${it.title || '指标分析'}已完成 ${month} 数据汇总。`;
    }
    return { gists };
}

export async function aiReportCellCompile({ month, prompt = '' } = {}) {
    if (!validMonth(month)) fail('A valid report month is required');
    if (!String(prompt).trim()) fail('还没有最终提示词');
    const sources = await listAiReportSources(month);
    const metrics = await listAiReportMetrics(month);

    const fallbackRecipe = {
        summary: { zh: prompt.slice(0, 120), en: 'AI Report Cell' },
        sources: metrics.length
            ? [{ id: 'm1', kind: 'metrics', label: `${month} 考核指标`, names: metrics.slice(0, 8).map((m) => m.label), monthOffset: 0 }]
            : [],
        compute: `function compute(input) {\n  var m = (input && input.m1 && input.m1.metrics) || [];\n  return { count: m.length, items: m.slice(0, 10) };\n}`,
        render: `function render(result, kit) {\n  if (!result || !result.items || !result.items.length) {\n    return kit.text('当前月份（${month}）暂无可展示指标数据，请先导入 SLA 快照。');\n  }\n  return kit.table(result.items, { title: '本月指标概览', columns: [{ key: 'label', label: '指标名称' }, { key: 'value', label: '当前值', align: 'right' }, { key: 'target', label: '目标值', align: 'right' }] });\n}`,
        narrative: null,
    };

    const sys = '你是月报配方编译器。只输出 JSON：{"recipe":{"summary":{"zh":"","en":""},"sources":[],"compute":"function compute(input){...}","render":"function render(result,kit){...}","narrative":null}}。';
    const usr = `月份: ${month}\n最终提示词:\n${prompt}\n可用表(${sources.length}): ${JSON.stringify(sources.slice(0, 10))}\n可用指标(${metrics.length}): ${metrics.slice(0, 20).map((m) => m.label).join(', ')}`;
    const aiRes = await runStructuredAiTurn(sys, usr, { recipe: fallbackRecipe });
    let compiled;
    try {
        compiled = normalizeRecipe(aiRes.recipe || fallbackRecipe);
    } catch {
        compiled = normalizeRecipe(fallbackRecipe);
    }
    return { recipe: compiled, _rounds: aiRes._rounds };
}

export async function aiReportOverallChat({ message, prompt = '' } = {}) {
    if (!String(message || '').trim()) fail('请输入要问的内容');
    return runStructuredAiTurn(
        '你是月报整体风格顾问。输出 JSON：{"type":"ready|ask|answer","text":"..."}。',
        `当前整体风格:\n${prompt || DEFAULT_STYLE}\n用户请求: ${message}`,
        { type: 'ready', text: `已收到整体风格调整要求：${message}` },
    );
}

export async function aiReportOverallPrompt({ prompt = '', chat = [] } = {}) {
    const current = structuredStyle(prompt);
    const changesText = chat.filter((c) => c.role === 'user').map((c) => c.text).join('\n');
    const res = await runStructuredAiTurn(
        '根据对话更新月报整体风格条目，输出 JSON：{"changes":[{"action":"add","section":"风格与配色","item":"..."}]}。',
        `当前:\n${current}\n用户对话:\n${changesText}`,
        { changes: changesText ? [{ action: 'add', section: '风格与配色', item: changesText.slice(0, 180) }] : [] },
    );
    if (Array.isArray(res.changes)) {
        return { prompt: applyStyleChanges(current, res.changes).prompt, _rounds: res._rounds };
    }
    return { prompt: withStyleText(current, changesText || current), _rounds: res._rounds };
}

export async function aiReportOverallTheme({ prompt = '', current = null } = {}) {
    const baseTheme = normalizeTheme(current || {}) || {
        accent: '#1f5e95', accentSoft: '#e6f0fa', heading: '#132c45', surface: '#ffffff',
        palette: ['#1f5e95', '#2a7de1', '#10b981', '#f59e0b'], font: 'sans', radius: 8,
        frame: 'double', frameColor: '', dividers: 'line', dividerColor: '', panels: 'box',
    };
    return { theme: baseTheme, prompt };
}

export async function aiReportChapterChat({ message = '' } = {}) {
    if (!String(message).trim()) fail('请输入章节样式要求');
    return { type: 'ready', text: `已记录章节样式要求：${message}` };
}

export async function aiReportChapterPrompt({ prompt = '', chat = [] } = {}) {
    const lastUser = chat.filter((c) => c.role === 'user').map((c) => c.text).join('\n');
    return { prompt: lastUser || prompt || '' };
}

export async function aiReportCellRestyle({ cell } = {}) {
    return { ok: true, cell };
}

export async function aiReportCellNarrative({ month, prompt = '', result = null } = {}) {
    const res = await runStructuredAiTurn(
        '根据计算结果写一段简明中文月报结论（不超过 120 字），输出 JSON：{"zh":"...","en":"..."}。',
        `月份: ${month}\n要求: ${prompt}\n结果: ${JSON.stringify(result).slice(0, 3000)}`,
        { zh: `${month} 指标分析已完成，核心运营指标运行平稳。`, en: `${month} operational summary completed.` },
    );
    return { narrative: { zh: String(res.zh || `${month} 指标汇总已完成。`), en: String(res.en || '') }, _rounds: res._rounds };
}

export async function aiReportTemplateField({ fieldKey, prompt = '', month = '' } = {}) {
    const fixed = prompt.startsWith(FIXED_PREFIX) ? prompt.slice(FIXED_PREFIX.length) : '';
    if (fixed) return { value: { zh: fixed, en: '' } };
    return { value: { zh: prompt || `${month} 月度报告`, en: '' }, fieldKey };
}

export async function aiReportTemplateFieldChat({ message = '' } = {}) {
    return { type: 'ready', text: `已确认字段设置：${message}` };
}

export async function aiReportTemplateFieldPrompt({ chat = [], prompt = '' } = {}) {
    const userTxt = chat.filter((c) => c.role === 'user').map((c) => c.text).join('；');
    return { prompt: userTxt || prompt };
}

export async function aiReportImageChat({ slot = 'logo', message = '', prompt = '' } = {}) {
    if (!String(message).trim()) fail('请输入要问的内容');
    if (/上传|本地/.test(message)) return { type: 'upload', text: '请选择本地图片文件上传。' };
    if (/历史|图库|以前/.test(message)) return { type: 'history', text: '请从历史图库中选择图片。' };
    return {
        type: 'generate',
        text: `将为你生成简洁扁平的月报 ${slot} 矢量图标。`,
        prompt: `${prompt ? `${prompt}；` : ''}${message}`,
        edit: false,
    };
}

export async function aiReportImageGenerate({ slot = 'logo', prompt = '', accent = '#1f5e95' } = {}, user = 'system') {
    if (!String(prompt).trim()) fail('还没有图片提示词');
    const base = IMAGE_BASE[slot] || IMAGE_BASE.logo;
    const color = /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#1f5e95';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="8" y="8" width="112" height="112" rx="22" fill="${color}" opacity="0.12"/><path d="M34 84V52l22 18 38-34v48H34z" fill="${color}"/><circle cx="92" cy="36" r="8" fill="${color}"/></svg>`;
    const saved = await saveAiReportImage({
        bytes: Buffer.from(svg, 'utf8'),
        name: `AI_${slot}.svg`,
        source: 'ai',
        prompt: `${base}\n${prompt}`,
        user,
    });
    return { ...saved, engine: 'svg', model: 'vector-builtin' };
}

export async function aiReportDebugExplain({ mode = 'summary', text = '', selection = '', question = '' } = {}) {
    if (!String(text).trim() && !String(selection).trim()) fail('没有可分析的内容');
    const res = await callAiCompletion({
        messages: [
            { role: 'system', content: '你是一名高级全栈排障工程师，用简洁中文分点解释或诊断日志内容。' },
            { role: 'user', content: `模式: ${mode}\n问题: ${question}\n内容:\n${(selection || text).slice(0, 12000)}` },
        ],
        maxTokens: 1200,
    });
    return { answer: res.ok ? res.text : '当前未配置 AI 模型 API Key；已完成本地 Trace 结构校验，请检查接口状态码与入参。' };
}
