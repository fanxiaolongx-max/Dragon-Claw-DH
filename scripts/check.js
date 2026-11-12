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
        const installCmd = String(aj.install?.command || '');
        if (!installCmd.includes('rm -rf node_modules &&') || !installCmd.includes('--ignore-scripts') || !installCmd.includes('--engine-strict=false')) {
            errors.push(`app.json.install.command 必须包含 rm -rf node_modules &&、--ignore-scripts 和 --engine-strict=false，当前: ${installCmd}`);
        }
        if (aj.install?.registry && /registry\.npmjs\.org|registry\.yarnpkg\.com|registry\.npmmirror\.com|cmc\.centralrepo\.rnd\.huawei\.com/i.test(aj.install.registry)) {
            errors.push(`app.json.install.registry 禁止指向公网或旧 Artifactory 源: ${aj.install.registry}`);
        }
    }

    // 2. .npmrc
    const npmrcPath = path.join(ROOT, '.npmrc');
    if (fs.existsSync(npmrcPath)) {
        const npmrc = fs.readFileSync(npmrcPath, 'utf8');
        const regMatch = /^\s*registry\s*=\s*(.+)$/im.exec(npmrc);
        if (regMatch && !regMatch[1].includes('mirrors.tools.huawei.com')) {
            errors.push(`R9 违规：.npmrc 若显式指定 registry，必须指向内网源 mirrors.tools.huawei.com，当前: ${regMatch[1].trim()}`);
        }
        if (/^\s*(?:\/\/[^=]+:)?_authToken\s*=\s*(?!\$\{NPM_TOKEN\}\s*$)/im.test(npmrc)) {
            errors.push('R11 违规：.npmrc 禁止携带明文 _authToken（只允许 ${NPM_TOKEN}）');
        }
        if (/registry\.npmjs\.org|registry\.yarnpkg\.com|registry\.npmmirror\.com|cmc\.centralrepo\.rnd\.huawei\.com/i.test(npmrc)) {
            errors.push('R9 违规：.npmrc 禁止包含外网公网源或旧 Artifactory 源');
        }
    }

    // 3. package.json & R1/R2/R8
    const pkgPath = path.join(ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const dep of Object.keys(allDeps)) {
        if (BANNED_DB_PKGS.has(dep)) errors.push(`R1 违规：package.json 禁止包含直接连库依赖 ${dep}`);
        if (BANNED_AUTH_PKGS.has(dep)) errors.push(`R2 违规：package.json 禁止包含自建登录鉴权依赖 ${dep}`);
    }
    if (pkg.engines?.node !== '>=22 <23') errors.push(`package.json engines.node 必须为 ">=22 <23"，当前: ${pkg.engines?.node}`);
    // 基座会在应用根目录放一个 CommonJS 文件（dh-identity-loader.js）并预加载：根目录声明 ESM 会让它加载失败、应用起不来。
    // 所以根目录保持 CommonJS（run.js 是启动器），应用代码在 src/ 下由 src/package.json 声明 ESM。
    if (pkg.type === 'module') errors.push('根目录 package.json 不能声明 "type": "module"（会导致基座注入的 CommonJS 加载器启动失败）');
    try {
        if (JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'package.json'), 'utf8')).type !== 'module') errors.push('src/package.json 必须声明 "type": "module"');
    } catch { errors.push('缺少 src/package.json（声明 src 下的代码为 ESM）'); }
    if (/^\s*(?:import\s[^(]|export\s)/m.test(fs.readFileSync(path.join(ROOT, 'run.js'), 'utf8'))) errors.push('run.js 必须是 CommonJS 启动器，不能使用 import / export 语句');
    for (const [file, expect] of [['.nvmrc', '22.21.1']]) {
        const p = path.join(ROOT, file);
        if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8').trim() !== expect) errors.push(`${file} 内容必须为 ${expect}`);
    }
    const versionFile = path.join(ROOT, 'dragon-claw-dh.version');
    if (!fs.existsSync(versionFile) || !/^\d+\.\d+\.\d+$/.test(fs.readFileSync(versionFile, 'utf8').trim())) errors.push('dragon-claw-dh.version 必须是纯版本号（如 1.0.0）');
    if (!fs.existsSync(path.join(ROOT, 'static', 'js', 'api.js'))) errors.push('缺少 static/js/api.js（规范 §2.1 必含）');
    // 精简包的依赖必须是完整包的子集，且版本一致
    const litePkgPath = path.join(ROOT, 'profiles', 'lite', 'package.json');
    if (fs.existsSync(litePkgPath)) {
        const lite = JSON.parse(fs.readFileSync(litePkgPath, 'utf8'));
        if (lite.engines?.node !== '>=22 <23') errors.push(`profiles/lite/package.json engines.node 必须为 ">=22 <23"，当前: ${lite.engines?.node}`);
        for (const [dep, ver] of Object.entries(lite.dependencies || {})) {
            if (pkg.dependencies?.[dep] !== ver) errors.push(`profiles/lite/package.json 的 ${dep}@${ver} 与主 package.json 不一致`);
        }
        const liteLock = fs.readFileSync(path.join(ROOT, 'profiles', 'lite', 'package-lock.json'), 'utf8');
        if (/registry\.npmjs\.org|registry\.yarnpkg\.com|registry\.npmmirror\.com|cmc\.centralrepo\.rnd\.huawei\.com/i.test(liteLock)) {
            errors.push('profiles/lite/package-lock.json 包含外网公网或旧 Artifactory resolved URL');
        }
    }
    for (const scriptName of Object.keys(pkg.scripts || {})) {
        if (/^(?:(?:pre|post)?install|prepare)$/i.test(scriptName)) {
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
        if (/registry\.npmjs\.org|registry\.yarnpkg\.com|registry\.npmmirror\.com|cmc\.centralrepo\.rnd\.huawei\.com/i.test(rawLock)) {
            errors.push('package-lock.json 包含外网公网或旧 Artifactory resolved URL');
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
        // 规范 §6.1：环境变量只在 src/config.js 读取一次
        // run.js 例外：它要在加载任何应用模块之前打印启动环境（只报告是否注入，不打印取值）
        if (rel(file) !== `src${path.sep}config.js` && rel(file) !== 'run.js' && /process\.env\b/.test(src)) {
            errors.push(`§6.1 违规 (${rel(file)})：环境变量只能在 src/config.js 读取`);
        }
        // 规范 §5.1：routes 只调 service，不直接引用数据访问层
        if (rel(file).startsWith(`src${path.sep}routes${path.sep}`) && /dao\/(?:scoped|base|memory-store)/.test(src)) {
            errors.push(`§5.1 违规 (${rel(file)})：routes 不得直接引用 dao，请通过 services 调用`);
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
    const htmlFiles = walkFiles(path.join(ROOT, 'static'), (_, name) => name.endsWith('.html'));
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
