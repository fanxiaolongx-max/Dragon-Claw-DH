import crypto from 'node:crypto';
import { BusinessError } from '../core/errors.js';
import { optionalDep } from '../core/optional.js';
import {
    kvGet, kvSet, selectTable, upsertRow, updateRows, deleteRows,
    cacheSet, cacheGet, cacheDelete, sqlVal, parseJsonCol,
} from '../dao/scoped.js';
import { callAiCompletion } from './ai-service.js';

export const DEFAULT_CATEGORIES = ['默认分类'];

export function uivScriptOrigin(script) {
    const fromCode = (code) => (String(code || '').match(/URL:\s*(https?:\/\/[^\s]+)/) || [])[1]
        || (String(code || '').match(/fetch\("([^"]+)"/) || [])[1]
        || '';
    for (const candidate of [script?.openUrl, script?.url, fromCode(script?.code), fromCode(script?.consoleCode)]) {
        if (!candidate) continue;
        try {
            const parsed = new URL(candidate);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
        } catch {
            // Try next candidate
        }
    }
    return '';
}

export function uivSiteLabel(origin, lang) {
    let host = '';
    try { host = new URL(origin).hostname.toLowerCase(); } catch { host = origin; }
    const en = lang === 'en-US';
    if (host === 'netcare.huawei.com') return en ? 'NetCare China' : 'NetCare 中国';
    if (host === 'netcare-ae.gts.huawei.com') return en ? 'NetCare Middle East' : 'NetCare 中东';
    if (host === 'netcare-de.gts.huawei.com') return en ? 'NetCare Germany' : 'NetCare 德国';
    if (host.includes('datafab')) return 'DataFab';
    return host || 'Web';
}

export async function listCategories() {
    const rows = await selectTable('uiv_categories', {
        orderBySql: '`sort_order` ASC, `id` ASC',
        limit: 200,
        memSort: (a, b) => ((a.sort_order || 0) - (b.sort_order || 0)) || ((a.id || 0) - (b.id || 0)),
    });
    const names = [...DEFAULT_CATEGORIES];
    for (const r of rows) {
        if (r.name && !names.includes(r.name)) names.push(r.name);
    }
    return names;
}

export async function addCategory(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new BusinessError('分类名不能为空');
    if (!DEFAULT_CATEGORIES.includes(trimmed)) {
        const existing = await selectTable('uiv_categories', {
            whereSql: `\`name\` = ${sqlVal(trimmed)}`,
            limit: 1,
            memFilter: (r) => r.name === trimmed,
        });
        if (!existing.length) {
            await upsertRow('uiv_categories', {
                name: trimmed,
                description: '',
                sort_order: 10,
                created_at: Date.now(),
            }, ['name']);
        }
    }
    return listCategories();
}

export async function deleteCategory(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new BusinessError('分类名不能为空');
    if (DEFAULT_CATEGORIES.includes(trimmed)) throw new BusinessError('默认分类不可删除');
    await deleteRows('uiv_categories', {
        whereSql: `\`name\` = ${sqlVal(trimmed)}`,
        memFilter: (r) => r.name === trimmed,
    });
    await deleteRows('uiv_scripts', {
        whereSql: `\`category\` = ${sqlVal(trimmed)}`,
        memFilter: (r) => r.category === trimmed,
    });
    return listCategories();
}

function hydrateScriptRow(r) {
    const payload = parseJsonCol(r.payload_json, {}) || {};
    return {
        ...payload,
        id: r.id,
        name: r.name,
        url: r.url || payload.url || '',
        category: r.category || payload.category || '默认分类',
        createdAt: r.created_at || payload.createdAt,
        updatedAt: r.updated_at || payload.updatedAt,
    };
}

export async function listScripts() {
    const rows = await selectTable('uiv_scripts', {
        orderBySql: '`seq` ASC',
        limit: 1000,
        memSort: (a, b) => (a.seq || 0) - (b.seq || 0),
    });
    return rows.map(hydrateScriptRow);
}

export async function saveScripts(items = []) {
    const now = Date.now();
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const id = String(item.id || `script_${crypto.randomUUID().slice(0, 10)}`);
        const category = String(item.category || '默认分类').trim() || '默认分类';
        if (!DEFAULT_CATEGORIES.includes(category)) {
            await addCategory(category).catch(() => {});
        }
        const record = { ...item, id, category, updatedAt: now };
        await upsertRow('uiv_scripts', {
            id,
            name: String(item.name || id).slice(0, 250),
            url: String(item.url || ''),
            category,
            payload_json: JSON.stringify(record),
            created_at: Number(item.createdAt) || now,
            updated_at: now,
        }, ['id'], ['name', 'url', 'category', 'payload_json', 'updated_at']);
    }
    return listScripts();
}

export async function deleteScript(id) {
    await deleteRows('uiv_scripts', {
        whereSql: `\`id\` = ${sqlVal(id)}`,
        memFilter: (r) => r.id === id,
    });
    return { success: true };
}

export async function moveScriptCategory(id, category) {
    const list = await listScripts();
    const target = list.find((s) => s.id === id);
    if (!target) return null;
    const nextCat = String(category || '默认分类').trim() || '默认分类';
    const nextPayload = { ...target, category: nextCat, updatedAt: Date.now() };
    await updateRows('uiv_scripts', {
        category: nextCat,
        payload_json: JSON.stringify(nextPayload),
        updated_at: Date.now(),
    }, {
        whereSql: `\`id\` = ${sqlVal(id)}`,
        memFilter: (r) => r.id === id,
    });
    return nextPayload;
}

export async function renameScript(id, name) {
    const list = await listScripts();
    const target = list.find((s) => s.id === id);
    if (!target) return null;
    const nextName = String(name || '').trim() || target.name;
    const nextPayload = { ...target, name: nextName, updatedAt: Date.now() };
    await updateRows('uiv_scripts', {
        name: nextName,
        payload_json: JSON.stringify(nextPayload),
        updated_at: Date.now(),
    }, {
        whereSql: `\`id\` = ${sqlVal(id)}`,
        memFilter: (r) => r.id === id,
    });
    return nextPayload;
}

export async function exportBackup() {
    const [scripts, categories] = await Promise.all([listScripts(), listCategories()]);
    return {
        scripts,
        categories: categories.filter((c) => !DEFAULT_CATEGORIES.includes(c)),
        exportDate: new Date().toISOString(),
    };
}

export async function importBackup({ scripts = [], categories = [], merge = true }) {
    if (!merge) {
        await deleteRows('uiv_scripts', {
            whereSql: '`id` IS NOT NULL',
            memFilter: () => true,
        });
    }
    for (const cat of (Array.isArray(categories) ? categories : [])) {
        if (cat && !DEFAULT_CATEGORIES.includes(cat)) {
            await addCategory(cat).catch(() => {});
        }
    }
    if (Array.isArray(scripts) && scripts.length) {
        await saveScripts(scripts);
    }
    return { success: true, count: (await listScripts()).length };
}

export async function getBatchScope() {
    return (await kvGet('uiv_batch_scope', {
        includedIds: [],
        excludedIds: [],
        intervalMinutes: 60,
        enabled: false,
    })) || {};
}

export async function saveBatchScope(data) {
    return kvSet('uiv_batch_scope', { ...(data || {}), updatedAt: Date.now() });
}

// ============================================================
// UIV Fetch Parser (AST via acorn) & AI Script Adapter
// ============================================================

export async function parseFetchSnippet(codeText) {
    const raw = String(codeText || '').trim();
    if (!raw) throw new BusinessError('请输入从 Chrome DevTools 复制的 fetch(...) 代码');
    const acorn = await optionalDep('acorn', 'fetch 代码解析');
    let ast;
    try {
        ast = acorn.parse(raw, { ecmaVersion: 'latest', sourceType: 'script' });
    } catch {
        ast = acorn.parse(raw, { ecmaVersion: 'latest', sourceType: 'module' });
    }

    let url = '';
    let method = 'GET';
    let headers = {};
    let body = '';

    function readStr(node) {
        if (!node) return '';
        if (node.type === 'Literal') return String(node.value ?? '');
        if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
            return node.quasis.map((q) => q.value.cooked).join('');
        }
        return raw.slice(node.start, node.end);
    }

    function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'CallExpression' && node.callee?.name === 'fetch') {
            const [arg0, arg1] = node.arguments || [];
            url = readStr(arg0);
            if (arg1 && arg1.type === 'ObjectExpression') {
                for (const prop of arg1.properties || []) {
                    const key = prop.key?.name || prop.key?.value;
                    if (key === 'method') method = readStr(prop.value).toUpperCase() || 'GET';
                    else if (key === 'body') body = readStr(prop.value);
                    else if (key === 'headers' && prop.value?.type === 'ObjectExpression') {
                        for (const hp of prop.value.properties || []) {
                            const hk = hp.key?.name || hp.key?.value;
                            if (hk) headers[hk] = readStr(hp.value);
                        }
                    }
                }
            }
            return;
        }
        for (const k of Object.keys(node)) {
            const child = node[k];
            if (Array.isArray(child)) child.forEach(walk);
            else if (child && typeof child.type === 'string') walk(child);
        }
    }

    walk(ast);
    if (!url) throw new BusinessError('未在代码片段中识别到 fetch("...") 调用');
    return { url, method, headers, body, raw };
}

export async function nameScriptWithAi(payload = {}) {
    const prompt = `请为下面这个数据抓取请求生成一个简短清晰且带日期占位符友好描述的中文脚本名称（不超过20字，只返回名称本身，不要引号或解释）：
URL: ${payload.url || ''}
Method: ${payload.method || 'GET'}
Existing Name: ${payload.name || ''}`;
    const res = await callAiCompletion({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 120,
    });
    if (res.ok && res.text.trim()) {
        return { name: res.text.trim().replace(/^["'「]|["'」]$/g, '').slice(0, 60), source: 'ai' };
    }
    let hostName = '抓取脚本';
    try { hostName = new URL(payload.url).hostname.split('.')[0]; } catch { /* ignore */ }
    return { name: `${hostName}_${payload.method || 'DATA'}`, source: 'heuristic' };
}

export async function analyzeFetchWithAi(payload = {}) {
    const parsed = payload.fetchCode ? await parseFetchSnippet(payload.fetchCode) : payload;
    const res = await callAiCompletion({
        messages: [{
            role: 'user',
            content: `分析该 HTTP 数据抓取请求：\nURL: ${parsed.url}\nMethod: ${parsed.method}\nBody: ${String(parsed.body || '').slice(0, 500)}\n请返回 JSON: {"suggestedName": "...", "notes": "...", "headersToDrop": ["cookie", "content-length"]}`,
        }],
        maxTokens: 600,
    });
    let suggestion = null;
    if (res.ok && res.text) {
        const match = res.text.match(/\{[\s\S]*\}/);
        if (match) {
            try { suggestion = JSON.parse(match[0]); } catch { /* ignore */ }
        }
    }
    return {
        parsed,
        analysis: suggestion || {
            suggestedName: (await nameScriptWithAi(parsed)).name,
            notes: res.ok ? res.text : '已使用本地 AST 解析规则提取请求地址、方法与请求头（未配置 AI 模型时跳过语义分析）。',
            headersToDrop: ['content-length', 'host'],
        },
        aiUsed: Boolean(res.ok),
    };
}

// ============================================================
// UIV Auto Import 会话（Redis 缓存优先 + MySQL 表持久化兜底）
// ============================================================

// 抓取页每抓到一张表就 POST 一次 { name, rows }（与桌面版 UIVF12 下载拦截脚本一致），逐表追加；
// 旧接口一次性的 { datasets: [...] } 也照样接收。会话元信息一行（session_id = 会话 ID），
// 每张表的行单独一行（session_id = 会话 ID:表 ID），追加时不必把已收到的全部数据重写一遍。
const AUTO_IMPORT_TTL_MS = 48 * 3600_000;
const autoImportLocks = new Map();

function withAutoImportLock(sid, fn) {
    const previous = autoImportLocks.get(sid) || Promise.resolve();
    const next = previous.catch(() => null).then(fn);
    autoImportLocks.set(sid, next);
    next.finally(() => { if (autoImportLocks.get(sid) === next) autoImportLocks.delete(sid); }).catch(() => null);
    return next;
}

function checkAutoImportSessionId(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid || !/^[a-zA-Z0-9_-]{4,100}$/.test(sid)) throw new BusinessError('无效的 sessionId');
    return sid;
}

function safeDatasetName(name) {
    const cleaned = String(name || 'uivf12_capture.csv').replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/^\.+/, '').slice(0, 160);
    return cleaned || 'uivf12_capture.csv';
}

// 各表的行记录键：会话 ID:表 ID:分片号；都记在会话元信息里，读取和删除时用 IN 列出，不依赖 LIKE
const chunkKey = (sid, dataset, chunk) => `${sid}:${dataset.id}:${String(chunk.no).padStart(5, '0')}`;
const keysFilter = (keys) => ({
    whereSql: `\`session_id\` IN (${keys.map((key) => sqlVal(key)).join(', ')})`,
    memFilter: (r) => keys.includes(r.session_id),
});
// 抓取页经桥接按小分片上传（约 12 行一片），一张大表会有上百个键：分批查询/删除，避免单条 SQL 过长
const KEY_BATCH = 100;
async function forKeyBatches(keys, fn) {
    const out = [];
    for (let i = 0; i < keys.length; i += KEY_BATCH) out.push(...((await fn(keysFilter(keys.slice(i, i + KEY_BATCH)))) || []));
    return out;
}

async function readAutoImportMeta(sid) {
    const rows = await selectTable('dh_uiv_import_sessions', {
        whereSql: `\`session_id\` = ${sqlVal(sid)}`,
        limit: 1,
        memFilter: (r) => r.session_id === sid,
    });
    if (rows.length) return parseJsonCol(rows[0].payload_json, null);
    // 旧版本写在缓存里的会话
    try {
        const cached = await cacheGet(`uiv_import:${sid}`);
        const val = cached?.data?.value;
        if (val) return typeof val === 'string' ? JSON.parse(val) : val;
    } catch { /* 没有缓存 */ }
    return null;
}

async function writeAutoImportRow(sessionKey, record, payload) {
    const now = Date.now();
    await upsertRow('dh_uiv_import_sessions', {
        session_id: sessionKey,
        target: record.target || 'sla',
        source_label: String(record.sourceLabel || '').slice(0, 255),
        payload_json: JSON.stringify(payload),
        expires_at: now + AUTO_IMPORT_TTL_MS,
        created_at: record.createdAt || now,
    }, ['session_id']);
}

export async function saveAutoImportDatasets(sessionId, payload = {}, { token = '' } = {}) {
    const sid = checkAutoImportSessionId(sessionId);
    const incoming = Array.isArray(payload.datasets)
        ? payload.datasets
        : (Array.isArray(payload.rows) ? [{ name: payload.name, rows: payload.rows, fallback: payload.fallback === true, clientUploadId: payload.clientUploadId, append: payload.append, chunkIndex: payload.chunkIndex }] : []);
    return withAutoImportLock(sid, async () => {
        const now = Date.now();
        const existing = await readAutoImportMeta(sid);
        if (existing?.token && token && existing.token !== token) throw new BusinessError('自动导入会话 token 不匹配', 403);
        const record = existing && !Array.isArray(existing.datasets?.[0]?.rows) ? existing : {
            sessionId: sid,
            token: String(token || ''),
            target: String(payload.target || 'sla'),
            sourceLabel: String(payload.sourceLabel || payload.groupName || 'UI.Vision 自动导入'),
            datasets: [],
            meta: payload.meta || {},
            createdAt: now,
        };
        // 旧格式会话（行内嵌在元信息里）先拆成单独的行
        if (existing && Array.isArray(existing.datasets?.[0]?.rows)) {
            for (const dataset of existing.datasets) incoming.unshift({ name: dataset.name, rows: dataset.rows });
        }
        if (!record.token && token) record.token = String(token);
        record.origin = payload.origin || record.origin || '';
        record.groupName = payload.groupName || record.groupName || '';
        let saved = null, skipped = false;
        for (const item of incoming) {
            const rows = (Array.isArray(item?.rows) ? item.rows : []).filter((row) => row && typeof row === 'object' && !Array.isArray(row));
            if (!rows.length) continue;
            const name = safeDatasetName(item.name);
            const clientUploadId = item.clientUploadId ? String(item.clientUploadId) : '';
            let dataset = item.append && clientUploadId ? record.datasets.find((d) => d.clientUploadId === clientUploadId) : null;
            if (!dataset) {
                // 桌面端补传真实下载的文件（fallback）：同名的页面上传已在就跳过；补传先到时，页面上传到达后替换它
                const sameName = record.datasets.filter((d) => d.name === name);
                if (item.fallback && sameName.length) { saved = sameName[0]; skipped = true; continue; }
                for (const old of sameName.filter((d) => d.fallback)) {
                    await forKeyBatches(old.chunks.map((chunk) => chunkKey(sid, old, chunk)), (filter) => deleteRows('dh_uiv_import_sessions', filter).then(() => []));
                    record.datasets.splice(record.datasets.indexOf(old), 1);
                }
                dataset = { id: crypto.randomBytes(8).toString('hex'), name, clientUploadId: clientUploadId || undefined, fallback: item.fallback || undefined, chunks: [], rowCount: 0, uploadedAt: new Date(now).toISOString() };
                record.datasets.push(dataset);
            }
            const chunkIndex = Number(item.chunkIndex);
            if (item.append && Number.isFinite(chunkIndex) && dataset.chunks.some((c) => c.chunkIndex === chunkIndex)) { saved = dataset; continue; }
            const chunkNo = dataset.chunks.length;
            await writeAutoImportRow(chunkKey(sid, dataset, { no: chunkNo }), record, rows);
            dataset.chunks.push({ no: chunkNo, rowCount: rows.length, chunkIndex: Number.isFinite(chunkIndex) ? chunkIndex : undefined });
            dataset.rowCount += rows.length;
            dataset.updatedAt = new Date(now).toISOString();
            saved = dataset;
        }
        record.updatedAt = new Date(now).toISOString();
        await writeAutoImportRow(sid, record, record);
        // 顺手清掉过期会话
        await deleteRows('dh_uiv_import_sessions', {
            whereSql: `\`expires_at\` > 0 AND \`expires_at\` < ${sqlVal(now)}`,
            memFilter: (r) => Number(r.expires_at) > 0 && Number(r.expires_at) < now,
        }).catch(() => null);
        return {
            success: true,
            sessionId: sid,
            skipped,
            dataset: saved ? { id: saved.id, name: saved.name, rowCount: saved.rowCount } : null,
            datasetCount: record.datasets.length,
            count: record.datasets.length,
        };
    });
}

/** 读取会话（含每张表的全部行）；带 token 时校验 */
export async function getAutoImportSession(sessionId, { token = '' } = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid || !/^[a-zA-Z0-9_-]{4,100}$/.test(sid)) return null;
    const record = await readAutoImportMeta(sid);
    if (!record) return null;
    if (record.token && token && record.token !== token) throw new BusinessError('自动导入会话 token 不匹配', 403);
    if (Array.isArray(record.datasets?.[0]?.rows)) return record; // 旧格式
    const keys = record.datasets.flatMap((dataset) => dataset.chunks.map((chunk) => chunkKey(sid, dataset, chunk)));
    const chunkRows = await forKeyBatches(keys, (filter) => selectTable('dh_uiv_import_sessions', filter));
    const byKey = new Map(chunkRows.map((r) => [r.session_id, r.payload_json]));
    const { token: _secret, ...visible } = record;
    return {
        ...visible,
        id: sid,
        datasets: record.datasets.map((dataset) => ({
            id: dataset.id,
            name: dataset.name,
            rowCount: dataset.rowCount,
            uploadedAt: dataset.uploadedAt,
            rows: dataset.chunks.flatMap((chunk) => parseJsonCol(byKey.get(chunkKey(sid, dataset, chunk)), []) || []),
        })),
    };
}

/** 导入完成后删除临时会话（元信息与各表的行） */
export async function deleteAutoImportSession(sessionId, { token = '' } = {}) {
    const sid = String(sessionId || '').trim();
    const record = sid ? await readAutoImportMeta(sid) : null;
    if (!record) return { success: false };
    if (record.token && record.token !== token) throw new BusinessError('自动导入会话 token 不匹配', 403);
    const datasets = Array.isArray(record.datasets) ? record.datasets : [];
    await forKeyBatches([sid, ...datasets.flatMap((dataset) => (dataset.chunks || []).map((chunk) => chunkKey(sid, dataset, chunk)))], (filter) => deleteRows('dh_uiv_import_sessions', filter).then(() => []));
    await cacheDelete(`uiv_import:${sid}`).catch(() => null);
    return { success: true };
}
