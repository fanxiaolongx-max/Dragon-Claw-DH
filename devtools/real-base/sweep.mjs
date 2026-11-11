// 全路由扫描：把应用的每个接口都打到真库基座的测试库上，找出在真实 MySQL 上会失败的 SQL 和 5xx。
// 用法：node devtools/real-base/sweep.mjs http://<真库基座>:5401
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = String(process.argv[2] || process.env.DH_REAL_BASE || '').replace(/\/$/, '');
if (!BASE) { console.error('需要真库基座地址'); process.exit(2); }
const SCHEMA = process.env.DH_REAL_BASE_SCHEMA || 'dh_test';

Object.assign(process.env, {
    LOCAL_DEV_MEMORY: '0', LOG_LEVEL: 'silent', DH_OPEN_ADMIN: 'true',
    BASE_QUERY_URL: `${BASE}/query`, BASE_EXECUTE_URL: `${BASE}/execute`,
    APP_SCHEMA: SCHEMA, APP_UUID: 'aaaaaaaa-0000-4000-8000-000000000000', APP_DATASOURCE_ID: '2',
});

// 从源码收集路由：server.js 里的 register(函数, {prefix}) + 各路由文件里的 fastify.<method>('<path>')
const serverSrc = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
const prefixOf = {};
for (const m of serverSrc.matchAll(/app\.register\((\w+)(?:,\s*\{\s*prefix:\s*'([^']+)'\s*\})?\)/g)) prefixOf[m[1]] = m[2] || '';
const routes = [];
for (const file of fs.readdirSync(path.join(ROOT, 'src/routes'))) {
    const src = fs.readFileSync(path.join(ROOT, 'src/routes', file), 'utf8');
    let current = null;
    for (const line of src.split('\n')) {
        const fn = line.match(/^export\s+(?:default\s+)?async\s+function\s+(\w+)/);
        if (fn) current = fn[1];
        const r = line.match(/fastify\.(get|post|put|patch|delete)\(\s*'([^']+)'/);
        if (r && current in prefixOf) routes.push({ method: r[1].toUpperCase(), url: (prefixOf[current] + r[2]).replace(/\/$/, '') || '/' });
    }
}

const reset = await (await fetch(`${BASE}/_base/reset?schema=${SCHEMA}`, { method: 'POST' })).json();
if (reset.code !== 0) { console.error('重置测试库失败', reset); process.exit(2); }
await fetch(`${BASE}/_base/errors/clear`);

const { createServer } = await import(path.join(ROOT, 'src/server.js'));
const app = await createServer();
await app.ready();

const fill = (url) => url.replace(/:(\w+)/g, (_, k) => (/id$/i.test(k) ? '1' : 'sweep'));
const headers = { cookie: 'iLearningXUserName=sweep001' };
const SKIP = /\/logs\/stream|\/stream-test|\/outbound-test|extension-download/;
const bad = [];
let n = 0;
// 两轮：第一轮空库，第二轮带上第一轮写入的数据再读一遍
for (const round of [1, 2]) {
    for (const r of routes) {
        if (SKIP.test(r.url)) continue;
        const opts = { method: r.method, url: fill(r.url), headers: { ...headers } };
        if (r.method !== 'GET' && r.method !== 'DELETE') { opts.payload = {}; opts.headers['content-type'] = 'application/json'; }
        let res;
        try {
            res = await Promise.race([app.inject(opts), new Promise((_, rej) => setTimeout(() => rej(new Error('超时 20s')), 20000))]);
        } catch (e) { bad.push(`${r.method} ${opts.url} → ${e.message}`); continue; }
        n++;
        if (res.statusCode >= 500 && res.statusCode !== 501) bad.push(`${r.method} ${opts.url} → ${res.statusCode} ${String(res.body).slice(0, 180)}`);
    }
}
await app.close();

const report = await (await fetch(`${BASE}/_base/errors`)).json();
const seen = new Set();
const sqlErrors = report.errors.filter((e) => { const k = e.message + e.sql.slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; });
console.log(`路由 ${routes.length} 个，请求 ${n} 次；真库执行查询 ${report.stats.query} 次、写入 ${report.stats.execute} 次`);
console.log(`\nSQL 报错 ${sqlErrors.length} 类：`);
for (const e of sqlErrors) console.log(`- [${e.code}] ${e.message}\n    ${e.sql.slice(0, 260)}`);
const uniqBad = [...new Set(bad)];
console.log(`\n5xx 响应 ${uniqBad.length} 个：`);
for (const b of uniqBad) console.log(`- ${b}`);
process.exit(sqlErrors.length || uniqBad.length ? 1 : 0);
