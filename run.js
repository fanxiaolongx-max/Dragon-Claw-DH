'use strict';
// 启动器（CommonJS）。
//
// 为什么根目录不用 ESM：基座启动应用时会在应用目录里放一个它自己的 CommonJS 文件
// （dh-identity-loader.js）并预加载。根目录的 package.json 如果声明 "type": "module"，
// Node 会把这个 .js 也当成 ES 模块，报 “require is not defined in ES module scope”，
// 应用还没开始运行就退出。所以根目录保持 CommonJS，应用代码在 src/ 下（src/package.json 声明 ESM）。
//
// 这个文件只做三件事：打印启动环境、加载 src/main.js、把任何启动失败的原因完整打出来。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const startedAt = Date.now();

function log(level, message, detail) {
    const line = { level, time: new Date().toISOString(), category: 'BOOT', msg: message };
    if (detail !== undefined) line.detail = detail;
    const text = `${JSON.stringify(line)}\n`;
    // 错误同时写 stdout 和 stderr：平台把两路日志分开展示，哪一边都要能看到原因
    process.stdout.write(text);
    if (level === 'error' || level === 'fatal') process.stderr.write(text);
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); } catch (error) { return { __error: error.code || error.message }; }
}

function describeEnv() {
    // 只报告“有没有注入”，不打印取值；少数无敏感性的变量原样显示
    const SHOW = new Set(['PORT', 'HOST', 'NODE_ENV', 'APP_REGION', 'APP_LEVEL', 'LOG_LEVEL', 'WORKERS', 'LOCAL_DEV_MEMORY', 'NODE_OPTIONS', 'TZ']);
    const WATCH = /^(PORT|HOST|TZ|WORKERS|NODE_|LOG_|BASE_|APP_|BUSINESS_|SYSTEM_|DH_|AI_|HTTP_|MAX_PAGE|DEFAULT_PAGE|LOCAL_DEV)/;
    const out = {};
    for (const key of Object.keys(process.env).filter((k) => WATCH.test(k)).sort()) {
        const value = String(process.env[key] ?? '');
        out[key] = SHOW.has(key) ? value : (value ? `已注入(${value.length} 字符)` : '空');
    }
    const expected = ['PORT', 'BASE_QUERY_URL', 'BASE_EXECUTE_URL', 'APP_SCHEMA', 'APP_UUID', 'APP_DATASOURCE_ID'];
    return { injected: out, missing: expected.filter((k) => !process.env[k]) };
}

function describePackage() {
    const KNOWN = new Set(['app.json', 'run.js', 'package.json', 'package-lock.json', '.npmrc', '.nvmrc', 'README.md', 'db', 'src', 'static', 'tests', 'node_modules', 'dragon-claw-dh.version']);
    let entries = [];
    try {
        entries = fs.readdirSync(ROOT, { withFileTypes: true }).map((e) => {
            let size;
            try { size = e.isFile() ? fs.statSync(path.join(ROOT, e.name)).size : undefined; } catch { /* ignore */ }
            return { name: e.isDirectory() ? `${e.name}/` : e.name, ...(size !== undefined ? { size } : {}) };
        });
    } catch (error) {
        return { error: error.message };
    }
    // 不是本包带来的文件：通常是平台注入的（例如 dh-identity-loader.js），出问题时最值得看
    const foreign = entries.filter((e) => !KNOWN.has(e.name.replace(/\/$/, '')));
    const pkg = readJson('package.json');
    return {
        version: pkg.version,
        rootModuleType: pkg.type || 'commonjs（未声明）',
        srcModuleType: readJson('src/package.json').type || '未声明',
        files: entries,
        notFromPackage: foreign.map((e) => e.name),
    };
}

function preloads() {
    const args = [...process.execArgv, ...String(process.env.NODE_OPTIONS || '').split(/\s+/).filter(Boolean)];
    const found = [];
    for (let i = 0; i < args.length; i += 1) {
        const m = /^(?:-r|--require|--import|--loader|--experimental-loader)(?:=(.*))?$/.exec(args[i]);
        if (m) found.push(`${args[i].split('=')[0]} ${m[1] ?? args[i + 1] ?? ''}`.trim());
    }
    return found;
}

// ── 依赖预检 ──────────────────────────────────────────────
// 必需依赖缺一个，应用就起不来；可选依赖缺了只影响对应功能（精简包本来就不带）。
const REQUIRED_DEPS = ['fastify', '@fastify/static', 'pino', 'undici'];
const OPTIONAL_DEPS = {
    '@fastify/multipart': '文件上传（对话附件、手工校准附件、月报 Logo、原始文件归档）',
    exceljs: '服务端 Excel 读写（附件里的 Excel、表格分析、裕湘模板导出）',
    jszip: '压缩包（技能导入导出、报表备份、Word / PPT 附件）',
    '@tutao/oxmsg': '月报导出为 .msg 邮件',
    acorn: '数据抓取里的 fetch 代码解析',
};

function registryHosts(lock) {
    const hosts = {};
    for (const info of Object.values(lock.packages || {})) {
        const url = info && info.resolved;
        if (!url) continue;
        let host = '';
        try { host = new URL(url).host; } catch { host = '无法解析'; }
        hosts[host] = (hosts[host] || 0) + 1;
    }
    return hosts;
}

function checkDependencies() {
    const pkg = readJson('package.json');
    const lock = readJson('package-lock.json');
    const declared = Object.keys(pkg.dependencies || {});
    const nm = path.join(ROOT, 'node_modules');
    const result = {
        ok: true,
        profile: declared.some((d) => d in OPTIONAL_DEPS) ? '完整包' : '精简包',
        nodeModules: fs.existsSync(nm),
        npmInstallFinished: fs.existsSync(path.join(nm, '.package-lock.json')), // npm ci 成功结束时才会写这个文件
        lockfile: lock.__error ? `读取失败：${lock.__error}` : `lockfileVersion ${lock.lockfileVersion}，${Object.keys(lock.packages || {}).length - 1} 个包`,
        registry: (() => { try { return (/^\s*registry\s*=\s*(\S+)/m.exec(fs.readFileSync(path.join(ROOT, '.npmrc'), 'utf8')) || [])[1] || '未配置'; } catch { return '.npmrc 不存在'; } })(),
        lockRegistries: lock.__error ? {} : registryHosts(lock),
        required: [],
        optional: [],
        mismatched: [],
        missingTransitive: [],
        problems: [],
    };
    const expectVersion = (name) => (lock.packages && lock.packages[`node_modules/${name}`] && lock.packages[`node_modules/${name}`].version) || (pkg.dependencies || {})[name] || '';
    const installedVersion = (name) => {
        const info = readJson(path.join('node_modules', name, 'package.json'));
        return info.__error ? '' : info.version;
    };
    for (const name of declared) {
        const want = expectVersion(name);
        const have = installedVersion(name);
        const item = { name, want, have: have || '未安装' };
        if (REQUIRED_DEPS.includes(name)) result.required.push(item);
        else result.optional.push({ ...item, feature: OPTIONAL_DEPS[name] || '' });
        if (have && want && have !== want) result.mismatched.push(`${name}（锁文件 ${want}，实际 ${have}）`);
    }
    for (const name of REQUIRED_DEPS) {
        if (!declared.includes(name)) result.required.push({ name, want: '', have: installedVersion(name) || '未安装', note: 'package.json 未声明' });
    }
    // 间接依赖：锁文件里列出的每个包都应该在 node_modules 里（排除开发依赖和可选的平台二进制）
    if (!lock.__error && result.nodeModules) {
        for (const [key, info] of Object.entries(lock.packages || {})) {
            if (!key.startsWith('node_modules/') || info.dev || info.optional || info.devOptional) continue;
            if (!fs.existsSync(path.join(ROOT, key, 'package.json'))) result.missingTransitive.push(key.replace(/^node_modules\//, '').replace(/\/node_modules\//g, ' › '));
        }
    }

    const missingRequired = result.required.filter((d) => d.have === '未安装');
    const missingOptional = result.optional.filter((d) => d.have === '未安装');
    if (!result.nodeModules) {
        result.problems.push({ level: 'fatal', text: '依赖完全没有安装：应用目录下没有 node_modules。', hint: '查看平台「依赖安装」步骤的日志：npm ci 是否执行、是否报错（常见原因：内网源连不上、源里缺包、锁文件里的下载地址不是内网源）。' });
    } else if (missingRequired.length) {
        result.problems.push({ level: 'fatal', text: `缺少必需依赖：${missingRequired.map((d) => `${d.name}${d.want ? `@${d.want}` : ''}`).join('、')}，应用无法启动。`, hint: '依赖安装没有完成。查看平台安装日志里 npm ci 的报错；如果是内网源缺少某些包，先改传精简包（文件名带 -lite，只依赖 fastify、@fastify/static、pino、undici）。' });
    }
    if (result.nodeModules && !result.npmInstallFinished) {
        result.problems.push({ level: 'warn', text: '没有找到 node_modules/.package-lock.json：npm ci 可能中途失败，或者依赖不是用 npm ci 装的。', hint: '对照平台安装日志确认 npm ci 是否成功结束。' });
    }
    if (result.missingTransitive.length) {
        result.problems.push({ level: missingRequired.length ? 'fatal' : 'warn', text: `锁文件里有 ${result.missingTransitive.length} 个包没有装上：${result.missingTransitive.slice(0, 12).join('、')}${result.missingTransitive.length > 12 ? ' …' : ''}`, hint: '依赖只装了一部分，通常是 npm ci 中途失败。依赖这些包的功能会在使用时报错。' });
    }
    if (result.mismatched.length) {
        result.problems.push({ level: 'warn', text: `依赖版本与锁文件不一致：${result.mismatched.join('、')}`, hint: '依赖不是按锁文件安装的（可能用了 npm install）。' });
    }
    if (missingOptional.length && result.nodeModules && !missingRequired.length) {
        result.problems.push({ level: result.profile === '完整包' ? 'warn' : 'info', text: `${result.profile === '完整包' ? '完整包里这些可选依赖没有装上' : '精简包不含这些依赖'}，对应功能不可用：${missingOptional.map((d) => `${d.name}（${d.feature}）`).join('；')}`, hint: result.profile === '完整包' ? '查看安装日志，确认内网源里有这些包。' : '需要这些功能时改传完整包。' });
    }
    const publicHosts = Object.keys(result.lockRegistries).filter((h) => /registry\.npmjs\.org|registry\.yarnpkg\.com|npmmirror/i.test(h));
    if (publicHosts.length) {
        result.problems.push({ level: 'warn', text: `锁文件里的下载地址指向公网源：${publicHosts.join('、')}`, hint: '内网通常访问不到公网源，npm ci 会失败。需要在内网机器上重新生成 package-lock.json。' });
    }
    result.ok = !result.problems.some((p) => p.level === 'fatal');
    return result;
}

function logDependencies(dep) {
    const req = dep.required.map((d) => `${d.name} ${d.have === '未安装' ? '✗未安装' : `✓${d.have}`}`).join('，');
    const opt = dep.optional.map((d) => `${d.name} ${d.have === '未安装' ? '✗' : '✓'}`).join('，');
    log(dep.ok ? 'info' : 'fatal', `依赖检查${dep.ok ? (dep.problems.some((p) => p.level === 'warn') ? '：可以启动，但有问题需要处理' : '：通过') : '：不通过，应用无法启动'}（${dep.profile}）`, {
        必需: req || '无',
        可选: opt || '无',
        npmCi完成标记: dep.npmInstallFinished ? '有' : '没有',
        锁文件: dep.lockfile,
        npm源: dep.registry,
        锁文件下载地址: dep.lockRegistries,
    });
    for (const p of dep.problems) log(p.level === 'info' ? 'info' : p.level === 'warn' ? 'warn' : 'fatal', `依赖检查：${p.text}`, { 处理: p.hint });
}

const HINTS = [
    [/require is not defined in ES module scope/, '有 CommonJS 文件被当成了 ES 模块：检查应用根目录的 package.json 是否声明了 "type": "module"（本包不应声明）。'],
    [/Cannot find (?:package|module)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/, '依赖没有装全：查看平台的依赖安装日志（npm ci）。如果是内网源缺少某个包，改传精简包（文件名带 -lite）。'],
    [/EADDRINUSE/, '端口已被占用：平台注入的 PORT 上已有进程在监听，通常是上一个实例没有退出。'],
    [/EACCES/, '没有权限监听该端口或读取文件。'],
    [/Unexpected token|SyntaxError/, '代码或配置文件语法错误：确认 Node 版本是 22.21.1，以及上传的 zip 没有损坏。'],
    [/ERR_UNSUPPORTED_NODE|engine/i, 'Node 版本不符合要求（需要 22.21.1）。'],
];

function fail(stage, error) {
    const message = String(error?.message || error);
    let hint = HINTS.find(([re]) => re.test(`${error?.code || ''} ${message}`))?.[1];
    const missingPkg = /Cannot find (?:package|module) '([^']+)'/.exec(message)?.[1];
    if (missingPkg && !missingPkg.startsWith('.') && !missingPkg.startsWith('/')) hint = `找不到依赖 ${missingPkg}：${OPTIONAL_DEPS[missingPkg] ? `它是可选依赖（${OPTIONAL_DEPS[missingPkg]}），但被启动流程用到了，请反馈给开发者。` : '依赖没有装全，查看平台安装日志里 npm ci 的报错。'}`;
    log('fatal', `启动失败（${stage}）：${message}`, {
        stage,
        name: error?.name,
        code: error?.code,
        ...(hint ? { hint } : {}),
        stack: String(error?.stack || '').split('\n').slice(0, 12),
        uptimeMs: Date.now() - startedAt,
    });
    process.exitCode = 1;
    // 给日志一点时间刷出去再退出，避免平台只看到进程消失
    setTimeout(() => process.exit(1), 100);
}

const report = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    pid: process.pid,
    cwd: process.cwd(),
    appDir: ROOT,
    argv: process.argv.slice(1),
    execArgv: process.execArgv,
    preloads: preloads(),
    package: describePackage(),
    env: describeEnv(),
};
globalThis.__dhBootReport = report;
log('info', 'boot: 启动环境', report);

const deps = checkDependencies();
report.dependencies = deps;
logDependencies(deps);
if (!/^v22\./.test(process.version)) log('warn', `boot: 当前 Node 版本 ${process.version}，规范要求 22.21.1`);
if (report.package.rootModuleType === 'module') log('warn', 'boot: 根目录 package.json 声明了 "type": "module"，平台注入的 CommonJS 文件会加载失败');
if (report.package.notFromPackage.length) log('info', `boot: 应用目录里有不属于本包的文件（通常由平台注入）：${report.package.notFromPackage.join('、')}`);
if (report.env.missing.length) log('warn', `boot: 这些环境变量没有注入：${report.env.missing.join('、')}（数据接口会报错，探活不受影响）`);

process.on('uncaughtException', (error) => fail('运行期未捕获异常', error));
process.on('unhandledRejection', (reason) => fail('运行期未处理的 Promise 拒绝', reason instanceof Error ? reason : new Error(String(reason))));
process.on('exit', (code) => { if (code !== 0) log('error', `进程退出，退出码 ${code}`, { uptimeMs: Date.now() - startedAt }); });

if (!deps.ok) {
    // 必需依赖缺失：不再去加载应用（那样只会得到一屏看不懂的 ERR_MODULE_NOT_FOUND），直接给出结论退出
    log('fatal', '启动中止：依赖没有装好，详见上面的「依赖检查」日志');
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 100);
} else {
log('info', 'boot: 加载应用模块 src/main.js');
import('./src/main.js')
    .then((main) => {
        log('info', `boot: 模块加载完成（${Date.now() - startedAt}ms），开始监听`);
        return main.start();
    })
    .then(() => log('info', `boot: 启动完成，共 ${Date.now() - startedAt}ms`))
    .catch((error) => fail(error?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find/.test(String(error?.message)) ? '加载模块' : '启动服务', error));
}
