// 开发用「真库基座」：按基座 REST 约定把 SQL 交给真实 MySQL 8 执行，并模拟网关（路径前缀 + 工号 Cookie）。
// 目的：让每条 SQL 在上基座之前先在真 MySQL 上跑一遍。不随应用包发布。
import http from 'node:http';
import fs from 'node:fs';
import mysql from 'mysql2/promise';

const env = process.env;
const PORT = Number(env.PORT || 5401);
const SCHEMA = env.APP_SCHEMA || 'dh_app';
const UUID = env.APP_UUID || 'aaaaaaaa-0000-4000-8000-000000000000';
const UPSTREAM = new URL(env.APP_UPSTREAM || 'http://127.0.0.1:5400');
const PREFIX = `/digital-human/dh/${UUID}`;
const STRIP_PREFIX = env.GATEWAY_STRIP !== '0';
const PAGE_CAP = Number(env.BASE_PAGE_CAP || 1000);
const MAX_SQL_BYTES = Number(env.BASE_MAX_SQL_BYTES || 4 * 1024 * 1024);
const INIT_SQL = env.INIT_SQL || '/init.sql';
// 额外的库（自动化测试用，可通过 /_base/reset 清空重建）；主库永远不会被重置
const TEST_SCHEMAS = String(env.TEST_SCHEMAS || 'dh_test').split(',').map((s) => s.trim()).filter((s) => /^[a-z0-9_]+$/i.test(s) && s !== SCHEMA);

const conn = {
    host: env.MYSQL_HOST || '127.0.0.1',
    port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER || 'root',
    password: env.MYSQL_PASSWORD || '',
    charset: 'utf8mb4',
    dateStrings: true,
    decimalNumbers: true,
};

async function waitForMysql() {
    for (let i = 0; i < 90; i++) {
        try {
            const c = await mysql.createConnection(conn);
            await c.query(`CREATE DATABASE IF NOT EXISTS \`${SCHEMA}\` DEFAULT CHARSET utf8mb4`);
            await c.end();
            return;
        } catch (e) {
            if (i % 10 === 0) console.log(`等待 MySQL… ${e.code || e.message}`);
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
    throw new Error('MySQL 未就绪');
}

async function applyInitSql(schema, { reset = false } = {}) {
    if (!fs.existsSync(INIT_SQL)) { console.log(`未找到 ${INIT_SQL}，跳过建表`); return 0; }
    // 相当于 DBA 执行 init.sql：运行期接口不接受 DDL
    const c = await mysql.createConnection({ ...conn, multipleStatements: true });
    if (reset) await c.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    await c.query(`CREATE DATABASE IF NOT EXISTS \`${schema}\` DEFAULT CHARSET utf8mb4; USE \`${schema}\``);
    await c.query(fs.readFileSync(INIT_SQL, 'utf8'));
    const [rows] = await c.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [schema]);
    await c.end();
    console.log(`init.sql 已执行，${schema} 现有 ${rows[0].n} 张表`);
    return rows[0].n;
}

const pools = new Map();
const poolFor = (schema) => {
    if (!pools.has(schema)) pools.set(schema, mysql.createPool({ ...conn, database: schema, connectionLimit: 6, multipleStatements: false }));
    return pools.get(schema);
};
const redis = new Map();
const notifications = [];
const stats = { query: 0, execute: 0, sqlErrors: 0, lastErrors: [] };

const isoDates = (row) => {
    for (const k of Object.keys(row)) {
        const v = row[k];
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(v)) row[k] = v.replace(' ', 'T');
        else if (Buffer.isBuffer(v)) row[k] = v.toString('utf8');
    }
    return row;
};

function sqlFailure(kind, sql, error) {
    stats.sqlErrors++;
    const item = { at: new Date().toISOString(), kind, code: error.code, message: error.sqlMessage || error.message, sql: String(sql).slice(0, 600) };
    stats.lastErrors.unshift(item);
    stats.lastErrors.length = Math.min(stats.lastErrors.length, 50);
    console.log(`SQL_ERROR ${JSON.stringify(item)}`);
    return { code: 500, message: `SQL 执行失败：${item.message}`, data: null };
}

async function handleBase(pathname, method, body) {
    if (pathname === '/query/datasources') {
        return { code: 0, message: 'ok', data: { items: [{ id: 2, name: 'netcare-digital-human-app', schema: SCHEMA }] } };
    }
    if (pathname === '/query' || pathname === '/execute') {
        const sql = String(body.sql || '').trim();
        if (!sql) return { code: 400, message: 'sql 不能为空', data: null };
        if (Buffer.byteLength(sql) > MAX_SQL_BYTES) return { code: 413, message: `SQL 超过 ${MAX_SQL_BYTES} 字节`, data: null };
        const schema = body.schema || SCHEMA;
        if (schema !== SCHEMA && !TEST_SCHEMAS.includes(schema)) return { code: 400, message: `schema [${schema}] 不属于本应用`, data: null };
        const pool = poolFor(schema);
        const head = sql.replace(/^\(+/, '').slice(0, 12).toUpperCase();
        if (pathname === '/query') {
            stats.query++;
            if (!/^(SELECT|SHOW|WITH|DESC|EXPLAIN)\b/.test(head)) return { code: 400, message: '查询接口仅允许 SELECT', data: null };
            const limit = Math.max(1, Math.min(Number(body.limit) || 100, PAGE_CAP));
            try {
                const [rows] = await pool.query(sql);
                const list = Array.isArray(rows) ? rows.slice(0, limit).map(isoDates) : [];
                return { code: 0, message: 'ok', data: { datasourceId: body.datasourceId, schema, rows: list, rowCount: list.length } };
            } catch (e) { return sqlFailure('query', sql, e); }
        }
        stats.execute++;
        if (/^(SELECT|SHOW)\b/.test(head)) return { code: 400, message: '写接口不允许 SELECT', data: null };
        if (/^(CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE)\b/.test(head)) return { code: 409, message: '禁止运行期 DDL', data: null };
        try {
            const [r] = await pool.query(sql);
            // 与真机一致：不返回 lastInsertId
            return { code: 0, message: 'ok', data: { datasourceId: body.datasourceId, schema, affectedRows: r.affectedRows ?? 0, success: true } };
        } catch (e) { return sqlFailure('execute', sql, e); }
    }
    if (pathname === '/cache/execute') { redis.set(String(body.key), String(body.value)); return { code: 0, message: 'ok', data: { success: true, key: body.key } }; }
    if (pathname === '/cache/query/key') { const k = String(body.key); return { code: 0, message: 'ok', data: { exists: redis.has(k), key: k, value: redis.has(k) ? redis.get(k) : null } }; }
    if (pathname === '/cache/query') { return { code: 0, message: 'ok', data: { keys: [...redis.keys()].map((k) => `app:${UUID}:${k}`), count: redis.size } }; }
    if (pathname === '/cache/execute/key' && method === 'DELETE') { return { code: 0, message: 'ok', data: { deleted: redis.delete(String(body.key)), key: body.key } }; }
    if (pathname === '/notify/send') { notifications.push({ at: Date.now(), body }); return { code: 0, message: 'ok', data: { success: true, delivered: true } }; }
    if (pathname === '/common/rep-offices') return { code: 0, message: 'ok', data: { items: [] } };
    if (pathname === '/app/menus') return { code: 0, message: 'ok', data: { menus: [] } };
    return null;
}

function proxy(req, res, path) {
    const headers = { ...req.headers, host: UPSTREAM.host, 'x-forwarded-prefix': PREFIX };
    const up = http.request({ host: UPSTREAM.hostname, port: UPSTREAM.port || 80, method: req.method, path, headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
    });
    up.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`应用未响应：${e.message}`); });
    req.pipe(up);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function portal(req) {
    const who = /(?:^|;\s*)iLearningXUserName=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '';
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>模拟数字人门户</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:560px;margin:8vh auto;padding:0 16px;color:#1c2430}input{font:inherit;padding:8px 10px;border:1px solid #b9c2cf;border-radius:8px;width:180px}button,a.b{font:inherit;padding:8px 14px;border-radius:8px;border:0;background:#1f6feb;color:#fff;text-decoration:none;cursor:pointer}a.g{color:#57606a;margin-left:12px}small{color:#57606a}</style>
<h2>模拟数字人门户</h2>
<p>当前工号：<b>${who ? esc(decodeURIComponent(who)) : '未登录（匿名访客）'}</b></p>
<form action="/as" method="get"><input name="u" placeholder="输入任意工号" required> <button>以此工号进入应用</button><a class="g" href="/as?u=">退出登录</a></form>
<p><a class="b" href="${PREFIX}/">进入应用</a></p>
<p><small>这里模拟基座网关：把工号写进 Cookie <code>iLearningXUserName</code>，并在 <code>${PREFIX}/</code> 前缀下转发到应用。数据存在真实 MySQL 8 里。<br>已执行查询 ${stats.query} 次、写入 ${stats.execute} 次、SQL 报错 ${stats.sqlErrors} 次（<a href="/_base/errors">查看</a>）。</small></p>`;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

    if (p === PREFIX) { res.writeHead(302, { Location: `${PREFIX}/` }); return res.end(); }
    if (p.startsWith(`${PREFIX}/`)) return proxy(req, res, STRIP_PREFIX ? (req.url.slice(PREFIX.length) || '/') : req.url);
    if (p === '/' || p === '/portal') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(portal(req)); }
    if (p === '/as') {
        const u = (url.searchParams.get('u') || '').trim().replace(/[^\w.@-]/g, '').slice(0, 40);
        const cookie = u ? `iLearningXUserName=${u}; Path=/; SameSite=Lax` : 'iLearningXUserName=; Path=/; Max-Age=0';
        res.writeHead(302, { 'Set-Cookie': cookie, Location: u ? `${PREFIX}/` : '/' });
        return res.end();
    }
    if (p === '/_base/errors') return json({ stats: { query: stats.query, execute: stats.execute, sqlErrors: stats.sqlErrors }, errors: stats.lastErrors, notifications: notifications.slice(-20) });
    if (p === '/_base/errors/clear') { stats.sqlErrors = 0; stats.lastErrors = []; return json({ ok: true }); }
    if (p === '/healthz') return json({ status: 'ok' });
    if (p === '/_base/reset' && req.method === 'POST') {
        const schema = url.searchParams.get('schema') || '';
        if (!TEST_SCHEMAS.includes(schema)) return json({ code: 400, message: '只能重置测试库', data: null });
        try {
            const old = pools.get(schema); pools.delete(schema); if (old) await old.end().catch(() => {});
            return json({ code: 0, message: 'ok', data: { schema, tables: await applyInitSql(schema, { reset: true }) } });
        } catch (e) { return json({ code: 500, message: e.message, data: null }); }
    }

    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    let body = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return json({ code: 400, message: '请求体不是合法 JSON', data: null }); }
    try {
        const out = await handleBase(p, req.method, body);
        return out ? json(out) : json({ code: 404, message: 'Not found', data: null }, 404);
    } catch (e) {
        return json({ code: 500, message: e.message, data: null });
    }
});

await waitForMysql();
await applyInitSql(SCHEMA);
server.listen(PORT, '0.0.0.0', () => console.log(`真库基座已启动 :${PORT}  门户 /  应用 ${PREFIX}/  上游 ${UPSTREAM.origin}`));
