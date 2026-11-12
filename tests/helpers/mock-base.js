// 测试用假基座：按真机回执模拟 {code,message,data}、不返回 lastInsertId、Redis 前缀等行为
import http from 'node:http';

// 设了 DH_REAL_BASE（devtools/real-base 的地址）时，/query 与 /execute 不再用下面的正则模拟，
// 而是转给真实 MySQL 8 执行——同一套用例顺带验证每条 SQL 在真库上能跑。
const REAL_BASE = String(process.env.DH_REAL_BASE || '').replace(/\/$/, '');
const REAL_SCHEMA = process.env.DH_REAL_BASE_SCHEMA || 'dh_test';

async function realBase(pathname, body) {
    const r = await fetch(`${REAL_BASE}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, schema: REAL_SCHEMA }),
    });
    return r.json();
}

export async function startMockBaseServer() {
    if (REAL_BASE) {
        const r = await fetch(`${REAL_BASE}/_base/reset?schema=${REAL_SCHEMA}`, { method: 'POST' });
        const j = await r.json();
        if (j.code !== 0) throw new Error(`真库基座重置失败：${j.message}`);
    }
    const tables = new Map();
    const cache = new Map();
    const auditRequests = [];
    const notifications = [];
    const aiRequests = [];
    const sqlErrors = [];
    const aiScript = [];
    const options = { rejectImages: false };

    function getTable(name) {
        if (!tables.has(name)) tables.set(name, []);
        return tables.get(name);
    }

    function splitCsvRespectingQuotes(str) {
        const out = [];
        let cur = '';
        let inStr = false;
        let escaped = false;
        for (let i = 0; i < str.length; i++) {
            const ch = str[i];
            if (escaped) { cur += ch; escaped = false; continue; }
            if (inStr) {
                if (ch === '\\') { cur += ch; escaped = true; continue; }
                if (ch === "'") {
                    if (str[i + 1] === "'") { cur += "''"; i++; continue; }
                    inStr = false; cur += ch; continue;
                }
                cur += ch;
            } else {
                if (ch === "'") { inStr = true; cur += ch; }
                else if (ch === ',') { out.push(cur.trim()); cur = ''; }
                else { cur += ch; }
            }
        }
        if (cur.trim() || out.length) out.push(cur.trim());
        return out;
    }

    function parseSqlLiteral(tok) {
        const s = tok.trim();
        if (/^NULL$/i.test(s)) return null;
        if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
        if (s.startsWith("'") && s.endsWith("'")) {
            // 单趟反转义：逐个替换会把 \\\\n（转义的反斜杠 + n）错当成换行
            return s.slice(1, -1).replace(/''|\\([\s\S])/g, (m, ch) => (m === "''" ? "'" : ({ n: '\n', r: '\r', 0: '\0' }[ch] ?? ch)));
        }
        return s;
    }

    function matchesWhere(row, whereStr) {
        if (!whereStr) return true;
        // 支持用 AND 连接的 =、>=、<、IN (...) 条件，够覆盖数据层生成的语句
        const body = String(whereStr).replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i, '');
        const re = /`?([a-zA-Z0-9_]+)`?\s*(>=|<=|=|<|>|IN)\s*(\((?:'(?:\\.|[^'])*'|[^)])*\)|'(?:\\.|[^'])*'|-?\d+)/gi;
        let m;
        while ((m = re.exec(body))) {
            const [, col, op, raw] = m;
            const left = row[col];
            if (op.toUpperCase() === 'IN') {
                const list = splitCsvRespectingQuotes(raw.slice(1, -1)).map(parseSqlLiteral).map(String);
                if (!list.includes(String(left))) return false;
                continue;
            }
            const right = parseSqlLiteral(raw);
            if (op === '=' && String(left) !== String(right)) return false;
            if (op === '>=' && !(Number(left) >= Number(right))) return false;
            if (op === '<=' && !(Number(left) <= Number(right))) return false;
            if (op === '<' && !(Number(left) < Number(right))) return false;
            if (op === '>' && !(Number(left) > Number(right))) return false;
        }
        return true;
    }

    function execMockSql(sql) {
        const clean = String(sql || '').trim();
        let m = clean.match(/^INSERT\s+(?:IGNORE\s+)?INTO\s+`?([a-zA-Z0-9_]+)`?\s*\(([^)]+)\)\s*VALUES\s*\(([\s\S]*?)\)(?:\s+ON\s+DUPLICATE\s+KEY\s+UPDATE\s+([\s\S]+))?$/i);
        if (m) {
            const [, tbl, colStr, valStr, dupStr] = m;
            const cols = colStr.split(',').map((c) => c.trim().replace(/^`|`$/g, ''));
            const vals = splitCsvRespectingQuotes(valStr).map(parseSqlLiteral);
            const row = {};
            cols.forEach((c, idx) => { row[c] = vals[idx]; });
            const list = getTable(tbl);
            if (dupStr) {
                const keyCol = cols[0];
                const existing = list.find((r) => String(r[keyCol]) === String(row[keyCol]));
                if (existing) {
                    Object.assign(existing, row);
                    return 1;
                }
            }
            if (row.id === undefined) row.id = list.length + 1;
            if (row.created_at === undefined) row.created_at = new Date().toISOString();
            list.push(row);
            return 1;
        }
        m = clean.match(/^UPDATE\s+`?([a-zA-Z0-9_]+)`?\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+)$/i);
        if (m) {
            const [, tbl, setStr, whereStr] = m;
            const pairs = splitCsvRespectingQuotes(setStr);
            const patch = {};
            for (const p of pairs) {
                const eqIdx = p.indexOf('=');
                if (eqIdx > 0) {
                    const k = p.slice(0, eqIdx).trim().replace(/^`|`$/g, '');
                    patch[k] = parseSqlLiteral(p.slice(eqIdx + 1));
                }
            }
            let affected = 0;
            for (const row of getTable(tbl)) {
                if (matchesWhere(row, whereStr)) {
                    Object.assign(row, patch);
                    affected++;
                }
            }
            return affected;
        }
        m = clean.match(/^DELETE\s+FROM\s+`?([a-zA-Z0-9_]+)`?\s+WHERE\s+([\s\S]+)$/i);
        if (m) {
            const [, tbl, whereStr] = m;
            const list = getTable(tbl);
            const kept = list.filter((r) => !matchesWhere(r, whereStr));
            const diff = list.length - kept.length;
            tables.set(tbl, kept);
            return diff;
        }
        return 0;
    }

    function queryMockSql(sql, limit = 100) {
        const clean = String(sql || '').trim();
        if (/FROM\s+information_schema\.TABLES/i.test(clean)) {
            return Array.from(tables.keys()).map((t) => ({
                TABLE_NAME: t,
                TABLE_ROWS: tables.get(t).length,
                CREATE_TIME: new Date().toISOString(),
            }));
        }
        if (/FROM\s+demo_base_test/i.test(clean)) {
            return [{ id: 1, msg: 'init.sql 初始化数据', create_time: '2026-10-20T14:09:08' }];
        }
        const cnt = clean.match(/^SELECT\s+COUNT\(\*\)\s+AS\s+(\w+)\s+FROM\s+`?([a-zA-Z0-9_]+)`?(?:\s+WHERE\s+([\s\S]+?))?(?:\s+LIMIT\s+\d+)?$/i);
        if (cnt) return [{ [cnt[1]]: getTable(cnt[2]).filter((r) => matchesWhere(r, cnt[3])).length }];
        const m = clean.match(/^SELECT\s+([\s\S]+?)\s+FROM\s+`?([a-zA-Z0-9_]+)`?(?:\s+WHERE\s+([\s\S]+?))?(?:\s+ORDER\s+BY\s+([\s\S]+?))?$/i);
        if (!m) return [];
        const [, _cols, tbl, whereStr] = m;
        let rows = getTable(tbl).filter((r) => matchesWhere(r, whereStr));
        if (/ORDER\s+BY\s+.*DESC/i.test(clean)) rows = [...rows].reverse();
        return rows.slice(0, limit);
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const chunks = [];
        for await (const ch of req) chunks.push(ch);
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let body = {};
        if (rawBody) {
            try { body = JSON.parse(rawBody); } catch { body = {}; }
        }
        auditRequests.push({
            method: req.method,
            path: url.pathname,
            requestId: req.headers['x-request-id'] || '',
            body,
        });

        const sendJson = (obj, status = 200) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(obj));
        };

        // OpenAI chat completion mock endpoint
        if (url.pathname === '/v1/chat/completions') {
            aiRequests.push(body);
            if (options.rejectImages && JSON.stringify(body.messages || []).includes('image_url')) {
                return sendJson({ error: { message: 'image input is not supported by this model' } }, 400);
            }
            // 用例可以预先排好模型的每一轮输出：{ text } 或 { toolCalls: [{ name, args }] }
            const scripted = body.stream && aiScript.length ? aiScript.shift() : null;
            if (scripted) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
                if (scripted.text) for (const piece of String(scripted.text).match(/[\s\S]{1,12}/g)) send({ choices: [{ delta: { content: piece } }] });
                (scripted.toolCalls || []).forEach((call, index) => {
                    const args = JSON.stringify(call.args || {});
                    send({ choices: [{ delta: { tool_calls: [{ index, id: `call_${aiRequests.length}_${index}`, type: 'function', function: { name: call.name, arguments: args.slice(0, 7) } }] } }] });
                    send({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(7) } }] } }] });
                });
                send({ choices: [{ delta: {}, finish_reason: scripted.finish || (scripted.toolCalls ? 'tool_calls' : 'stop') }] });
                send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } });
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }
            if (body.stream) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好，' } }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '这是数字人 AI 回复。' } }] })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }
            return sendJson({ choices: [{ message: { content: 'OK' } }] });
        }

        if (url.pathname === '/healthz') return sendJson({ status: 'ok' });
        if (url.pathname === '/query/datasources') {
            return sendJson({ code: 0, message: 'ok', data: { items: [{ id: 2, name: 'netcare-digital-human-app' }] } });
        }
        if (url.pathname === '/common/rep-offices') {
            return sendJson({ code: 0, message: 'ok', data: { items: [{ code: 'EG', name: 'Egypt' }] } });
        }
        if (url.pathname === '/app/menus') {
            return sendJson({ code: 0, message: 'ok', data: { menus: [{ id: 'home', name: 'Home' }] } });
        }
        if (url.pathname === '/query') {
            if (body.schema === 'netcare') {
                return sendJson({ code: 400, message: '基座库 [netcare] 仅允许基础应用查询', data: null });
            }
            if (REAL_BASE && !/^netcare/.test(String(body.schema || ''))) {
                const out = await realBase('/query', body);
                if (out.code !== 0) sqlErrors.push({ sql: String(body.sql).slice(0, 400), message: out.message });
                return sendJson(out);
            }
            const rows = queryMockSql(body.sql, body.limit || 200);
            return sendJson({ code: 0, message: 'ok', data: { datasourceId: body.datasourceId, schema: body.schema, rows, rowCount: rows.length } });
        }
        if (url.pathname === '/execute') {
            if (body.schema === 'netcare') {
                return sendJson({ code: 409, message: '基座 schema [netcare] 不允许任何应用写操作', data: null });
            }
            if (body.schema === 'netcare_base') {
                return sendJson({ code: 409, message: '写 netcare_base 仅允许基础应用携带自身 x-app-id 执行', data: null });
            }
            if (REAL_BASE && !/^netcare/.test(String(body.schema || ''))) {
                const out = await realBase('/execute', body);
                if (out.code !== 0) sqlErrors.push({ sql: String(body.sql).slice(0, 400), message: out.message });
                return sendJson(out);
            }
            const affectedRows = execMockSql(body.sql);
            return sendJson({ code: 0, message: 'ok', data: { datasourceId: body.datasourceId, schema: body.schema, affectedRows, success: true } });
        }
        if (url.pathname === '/cache/execute') {
            cache.set(String(body.key), String(body.value));
            return sendJson({ code: 0, message: 'ok', data: { success: true, key: body.key } });
        }
        if (url.pathname === '/cache/query/key') {
            const k = String(body.key);
            const exists = cache.has(k);
            return sendJson({ code: 0, message: 'ok', data: { exists, key: k, value: exists ? cache.get(k) : null } });
        }
        if (url.pathname === '/cache/query') {
            return sendJson({ code: 0, message: 'ok', data: { keys: Array.from(cache.keys()).map((k) => `app:${body.schema || 'test'}:${k}`), count: cache.size } });
        }
        if (url.pathname === '/cache/execute/key' && req.method === 'DELETE') {
            const deleted = cache.delete(String(body.key));
            return sendJson({ code: 0, message: 'ok', data: { deleted, key: body.key } });
        }
        if (url.pathname === '/notify/send') {
            notifications.push(body);
            return sendJson({ code: 0, message: 'ok', data: { success: true, delivered: true } });
        }
        return sendJson({ code: 404, message: 'Not found' }, 404);
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            resolve({
                baseUrl: `http://127.0.0.1:${addr.port}`,
                auditRequests,
                notifications,
                aiRequests,
                sqlErrors,
                aiScript,
                options,
                realBase: Boolean(REAL_BASE),
                close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
            });
        });
    });
}

export async function getFreePort() {
    return new Promise((resolve) => {
        const s = http.createServer();
        s.listen(0, '127.0.0.1', () => {
            const port = s.address().port;
            s.close(() => resolve(port));
        });
    });
}

export async function waitForServer(url, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(url);
            if (res.ok) return;
        } catch { /* wait */ }
        await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error(`Server did not become healthy at ${url}`);
}
