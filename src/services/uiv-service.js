import crypto from 'node:crypto';
import { BusinessError } from '../core/errors.js';
import { optionalDep } from '../core/optional.js';
import {
    kvGet, kvSet, selectTable, upsertRow, updateRows, deleteRows,
    cacheSet, cacheGet, sqlVal, parseJsonCol,
} from '../dao/scoped.js';
import { callAiCompletion } from './ai-service.js';

const DEFAULT_CATEGORIES = ['默认分类', 'NetCare', 'DataFab'];

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
    await deleteRows('uiv_categories', {
        whereSql: `\`name\` = ${sqlVal(trimmed)}`,
        memFilter: (r) => r.name === trimmed,
    });
    await deleteRows('uiv_scripts', {
        whereSql: `\`category\` = ${sqlVal(trimmed)}`,
        memFilter: (r) => r.category === trimmed,
    });
    return { success: true };
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

export async function saveAutoImportDatasets(sessionId, payload = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid || !/^[a-zA-Z0-9_-]{4,100}$/.test(sid)) {
        throw new BusinessError('无效的 sessionId');
    }
    const now = Date.now();
    const record = {
        sessionId: sid,
        target: String(payload.target || 'sla'),
        sourceLabel: String(payload.sourceLabel || payload.name || 'UI.Vision 自动导入'),
        datasets: Array.isArray(payload.datasets) ? payload.datasets : [],
        meta: payload.meta || {},
        createdAt: now,
    };
    await cacheSet(`uiv_import:${sid}`, JSON.stringify(record), 3600).catch(() => null);
    await upsertRow('dh_uiv_import_sessions', {
        session_id: sid,
        target: record.target,
        source_label: record.sourceLabel,
        payload_json: JSON.stringify(record),
        expires_at: now + 3600_000,
        created_at: now,
    }, ['session_id']);
    return { success: true, sessionId: sid, datasetCount: record.datasets.length };
}

export async function getAutoImportSession(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) return null;
    try {
        const cached = await cacheGet(`uiv_import:${sid}`);
        const val = cached?.data?.value;
        if (val) {
            return typeof val === 'string' ? JSON.parse(val) : val;
        }
    } catch { /* fallback to MySQL */ }
    const rows = await selectTable('dh_uiv_import_sessions', {
        whereSql: `\`session_id\` = ${sqlVal(sid)}`,
        limit: 1,
        memFilter: (r) => r.session_id === sid,
    });
    if (!rows.length) return null;
    return parseJsonCol(rows[0].payload_json, null);
}
