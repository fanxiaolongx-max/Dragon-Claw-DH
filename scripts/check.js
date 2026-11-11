import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const BANNED_DB_PKGS = new Set([
    'mysql', 'mysql2', 'pg', 'sqlite3', 'better-sqlite3',
    'sequelize', 'typeorm', 'knex', 'mongoose', 'redis', 'ioredis',
    'tedious', 'oracledb',
]);

const BANNED_AUTH_PKGS = new Set([
    'passport', 'jsonwebtoken', 'bcrypt', 'bcryptjs', 'express-session',
]);

function walkFiles(dir, predicate, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git' || entry.name === 'vendor') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkFiles(full, predicate, out);
        } else if (predicate(full, entry.name)) {
            out.push(full);
        }
    }
    return out;
}

export async function runCheck() {
    const errors = [];
    const rel = (p) => path.relative(ROOT, p);

    // 1. app.json
    const appJsonPath = path.join(ROOT, 'app.json');
    if (!fs.existsSync(appJsonPath)) {
        errors.push('缺少 app.json');
    } else {
        const aj = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
        if (aj.runtime !== 'node') errors.push(`app.json.runtime 必须为 node，当前: ${aj.runtime}`);
        if (aj.runtimeVersion !== '22.21.1') errors.push(`app.json.runtimeVersion 必须为 22.21.1，当前: ${aj.runtimeVersion}`);
        if (aj.entry !== 'run.js') errors.push(`app.json.entry 必须为 run.js，当前: ${aj.entry}`);
        if (aj.health?.path !== '/api/healthz') errors.push(`app.json.health.path 必须为 /api/healthz，当前: ${aj.health?.path}`);
    }

    // 2. .npmrc
    const npmrcPath = path.join(ROOT, '.npmrc');
    if (!fs.existsSync(npmrcPath)) {
        errors.push('缺少 .npmrc');
    } else {
        const npmrc = fs.readFileSync(npmrcPath, 'utf8');
        if (!npmrc.includes('cmc.centralrepo.rnd.huawei.com')) errors.push('.npmrc 未指向公司内部 Artifactory 仓库');
        if (/_authToken\s*=/i.test(npmrc)) errors.push('.npmrc 禁止携带 _authToken');
        if (/registry\.npmjs\.org|registry\.yarnpkg\.com/i.test(npmrc)) errors.push('.npmrc 禁止包含外网公网源');
    }

    // 3. package.json & R1/R2/R8
    const pkgPath = path.join(ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const dep of Object.keys(allDeps)) {
        if (BANNED_DB_PKGS.has(dep)) errors.push(`R1 违规：package.json 禁止包含直接连库依赖 ${dep}`);
        if (BANNED_AUTH_PKGS.has(dep)) errors.push(`R2 违规：package.json 禁止包含自建登录鉴权依赖 ${dep}`);
    }
    for (const scriptName of Object.keys(pkg.scripts || {})) {
        if (/^(?:pre|post)?install$/i.test(scriptName)) {
            errors.push(`R8 违规：package.json 禁止安装脚本 ${scriptName}`);
        }
    }

    // 4. package-lock.json
    const lockPath = path.join(ROOT, 'package-lock.json');
    if (!fs.existsSync(lockPath)) {
        errors.push('缺少 package-lock.json');
    } else {
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (!Number.isFinite(lock.lockfileVersion) || lock.lockfileVersion < 2) {
            errors.push(`package-lock.json lockfileVersion 必须 >= 2，当前: ${lock.lockfileVersion}`);
        }
        const rawLock = fs.readFileSync(lockPath, 'utf8');
        if (/registry\.npmjs\.org|registry\.yarnpkg\.com|registry\.npmmirror\.com/i.test(rawLock)) {
            errors.push('package-lock.json 包含外网公网 resolved URL');
        }
    }

    // 5. db/init.sql
    const initSqlPath = path.join(ROOT, 'db', 'init.sql');
    if (!fs.existsSync(initSqlPath)) {
        errors.push('缺少 db/init.sql');
    } else {
        const ddl = fs.readFileSync(initSqlPath, 'utf8');
        if (!/CREATE\s+TABLE/i.test(ddl)) errors.push('db/init.sql 中未找到 CREATE TABLE');
        if (/\b(?:CREATE\s+DATABASE|USE\s+`)/i.test(ddl)) errors.push('db/init.sql 禁止包含 CREATE DATABASE / USE schema 语句');
    }

    // 6. R3 / R4 / R5 across backend & static frontend
    const backendJs = [
        path.join(ROOT, 'run.js'),
        ...walkFiles(path.join(ROOT, 'src'), (_, name) => name.endsWith('.js')),
    ].filter((f) => fs.existsSync(f));

    for (const file of backendJs) {
        const src = fs.readFileSync(file, 'utf8');
        if (/\beval\s*\(|new\s+Function\s*\(/.test(src)) {
            errors.push(`R3 违规 (${rel(file)})：禁止 eval() / new Function()`);
        }
        if (/child_process/.test(src)) {
            errors.push(`R3 违规 (${rel(file)})：禁止引用 child_process`);
        }
        if (/\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/.test(src)) {
            errors.push(`R4 违规 (${rel(file)})：疑似硬编码内网 IP`);
        }
        if (/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(src)) {
            errors.push(`R4 违规 (${rel(file)})：疑似硬编码 UUID 字面量`);
        }
        if (rel(file).startsWith(`src${path.sep}routes${path.sep}`) || rel(file).startsWith(`src${path.sep}services${path.sep}`)) {
            if (/dao\/base/.test(src) || /\b(?:queryAppSchema|executeAppSchema|queryBusiness|rawBaseGet|rawBasePost|rawBaseDelete)\b/.test(src)) {
                errors.push(`R5 违规 (${rel(file)})：routes/services 只允许通过 dao/scoped.js 访问数据`);
            }
        }
    }

    const staticJs = walkFiles(path.join(ROOT, 'static', 'js'), (_, name) => name.endsWith('.js') && !name.endsWith('.min.js'));
    for (const file of staticJs) {
        const src = fs.readFileSync(file, 'utf8');
        if (/\beval\s*\(|new\s+Function\s*\(/.test(src)) {
            errors.push(`R3 前端违规 (${rel(file)})：禁止 eval() / new Function()`);
        }
        if (/localhost:\d+/i.test(src)) {
            errors.push(`R4 前端违规 (${rel(file)})：包含硬编码 localhost:port`);
        }
    }

    // 7. HTML & CSS: zero external CDN links
    const htmlFiles = [
        path.join(ROOT, 'static', 'index.html'),
        ...walkFiles(path.join(ROOT, 'static', 'pages'), (_, name) => name.endsWith('.html')),
    ].filter((f) => fs.existsSync(f));
    for (const file of htmlFiles) {
        const html = fs.readFileSync(file, 'utf8');
        if (/https?:\/\/(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|fonts\.googleapis\.com)/i.test(html)) {
            errors.push(`离线红线违规 (${rel(file)})：包含外部 CDN 脚本或样式引用`);
        }
    }
    const cssFiles = walkFiles(path.join(ROOT, 'static', 'css'), (_, name) => name.endsWith('.css'));
    for (const file of cssFiles) {
        const css = fs.readFileSync(file, 'utf8');
        if (/@import\s+url\(['"]?https?:/i.test(css)) {
            errors.push(`离线红线违规 (${rel(file)})：CSS 包含外部 @import`);
        }
    }

    return {
        ok: errors.length === 0,
        errors,
        checked: {
            backendJs: backendJs.length,
            staticJs: staticJs.length,
            htmlFiles: htmlFiles.length,
            cssFiles: cssFiles.length,
        },
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const res = await runCheck();
    if (!res.ok) {
        console.error('❌ Spec #244 合规检查失败：');
        for (const err of res.errors) console.error('  -', err);
        process.exit(1);
    }
    console.log(`✅ Spec #244 合规检查通过 (backend=${res.checked.backendJs}, staticJs=${res.checked.staticJs}, html=${res.checked.htmlFiles}, css=${res.checked.cssFiles})`);
}
