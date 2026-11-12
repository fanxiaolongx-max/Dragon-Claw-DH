// 启动器：依赖预检的提示，以及基座注入的 CommonJS 加载器（dh-identity-loader.js）能正常预加载。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForServer } from './helpers/mock-base.js';

const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function copyApp(withModules) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-boot-'));
    for (const f of ['run.js', 'package.json', 'package-lock.json', '.npmrc', 'app.json', 'dragon-claw-dh.version']) fs.copyFileSync(path.join(APP_ROOT, f), path.join(dir, f));
    for (const d of ['src', 'db', 'static']) fs.cpSync(path.join(APP_ROOT, d), path.join(dir, d), { recursive: true });
    if (withModules) fs.symlinkSync(path.join(APP_ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    // 模拟基座：第 16 行 require 的 CommonJS 加载器
    fs.writeFileSync(path.join(dir, 'dh-identity-loader.js'), `${Array.from({ length: 15 }, (_, i) => `// line ${i + 1}`).join('\n')}\nconst http = require('http');\nvoid http;\n`);
    return dir;
}

function run(dir, env, args = ['run.js']) {
    const child = spawn(process.execPath, args, { cwd: dir, env: { ...process.env, LOG_LEVEL: 'silent', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    return { child, exited, output: () => out };
}

test('依赖没装：启动器直接给出结论和处理办法，不抛一屏看不懂的堆栈', async () => {
    const dir = copyApp(false);
    try {
        const p = run(dir, { PORT: String(await getFreePort()) });
        assert.equal(await p.exited, 1);
        const lines = p.output().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
        assert.ok(lines.some((l) => l.level === 'fatal' && /依赖完全没有安装/.test(l.msg) && /npm ci/.test(l.detail?.处理)));
        assert.ok(lines.some((l) => l.msg === '启动中止：依赖没有装好，详见上面的「依赖检查」日志'));
        assert.doesNotMatch(p.output(), /ERR_MODULE_NOT_FOUND/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('基座预加载 CommonJS 加载器时应用能正常启动，并打印启动环境与依赖检查', async () => {
    const dir = copyApp(true);
    const port = await getFreePort();
    const p = run(dir, { PORT: String(port), HOST: '127.0.0.1', LOCAL_DEV_MEMORY: '1', LOG_LEVEL: 'info' }, ['-r', './dh-identity-loader.js', 'run.js']);
    try {
        await waitForServer(`http://127.0.0.1:${port}/api/healthz`, 15000);
        const lines = p.output().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
        const boot = lines.find((l) => l.msg === 'boot: 启动环境');
        assert.ok(boot.detail.preloads.some((x) => x.includes('dh-identity-loader.js')));
        assert.deepEqual(boot.detail.package.notFromPackage, ['dh-identity-loader.js']);
        assert.ok(lines.some((l) => /^依赖检查：通过/.test(l.msg)));
        assert.ok(lines.some((l) => /server started/.test(l.msg)));
    } finally {
        p.child.kill('SIGTERM');
        await p.exited;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
