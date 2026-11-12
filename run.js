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
    const deps = {};
    for (const name of ['fastify', '@fastify/static', 'pino', 'undici', '@fastify/multipart', 'exceljs', 'jszip', '@tutao/oxmsg', 'acorn']) {
        deps[name] = fs.existsSync(path.join(ROOT, 'node_modules', name, 'package.json')) ? '已安装' : '未安装';
    }
    const pkg = readJson('package.json');
    return {
        version: pkg.version,
        rootModuleType: pkg.type || 'commonjs（未声明）',
        srcModuleType: readJson('src/package.json').type || '未声明',
        files: entries,
        notFromPackage: foreign.map((e) => e.name),
        dependencies: deps,
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
    const hint = HINTS.find(([re]) => re.test(`${error?.code || ''} ${message}`))?.[1];
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
if (!/^v22\./.test(process.version)) log('warn', `boot: 当前 Node 版本 ${process.version}，规范要求 22.21.1`);
if (report.package.rootModuleType === 'module') log('warn', 'boot: 根目录 package.json 声明了 "type": "module"，平台注入的 CommonJS 文件会加载失败');
if (report.package.notFromPackage.length) log('info', `boot: 应用目录里有不属于本包的文件（通常由平台注入）：${report.package.notFromPackage.join('、')}`);
if (report.env.missing.length) log('warn', `boot: 这些环境变量没有注入：${report.env.missing.join('、')}（数据接口会报错，探活不受影响）`);

process.on('uncaughtException', (error) => fail('运行期未捕获异常', error));
process.on('unhandledRejection', (reason) => fail('运行期未处理的 Promise 拒绝', reason instanceof Error ? reason : new Error(String(reason))));
process.on('exit', (code) => { if (code !== 0) log('error', `进程退出，退出码 ${code}`, { uptimeMs: Date.now() - startedAt }); });

log('info', 'boot: 加载应用模块 src/main.js');
import('./src/main.js')
    .then((main) => {
        log('info', `boot: 模块加载完成（${Date.now() - startedAt}ms），开始监听`);
        return main.start();
    })
    .then(() => log('info', `boot: 启动完成，共 ${Date.now() - startedAt}ms`))
    .catch((error) => fail(error?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find/.test(String(error?.message)) ? '加载模块' : '启动服务', error));
