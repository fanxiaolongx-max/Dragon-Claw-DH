// 测试用假基座：按真机回执模拟 {code,message,data}、不返回 lastInsertId、Redis 前缀等行为
import http from 'node:http';

export function startMockBaseServer() {
    const tables = new Map();
    const cache = new Map();
    const auditRequests = [];
    const notifications = [];
    const aiRequests = [];

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
            return s.slice(1, -1)
                .replace(/''/g, "'")
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '\r')
                .replace(/\\'/g, "'")
                .replace(/\\\\/g, '\\');
        }
        return s;
    }

    function matchesWhere(row, whereStr) {
        if (!whereStr) return true;
        const m = whereStr.match(/`?([a-zA-Z0-9_]+)`?\s*=\s*('(?:\\.|[^'])*'|\d+)/);
        if (!m) return true;
        const col = m[1];
        const val = parseSqlLiteral(m[2]);
        return String(row[col]) === String(val);
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
