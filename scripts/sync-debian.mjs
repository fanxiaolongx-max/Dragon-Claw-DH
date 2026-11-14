#!/usr/bin/env node
/**
 * 智能防抖实时同步工具：同步本地改动到 Debian (NewAPI / 192.168.100.174)
 *
 * 核心机制（防频繁重启、无感更新）：
 * 1. 动静分离（静默更新）：修改 static/ 前端文件时，仅增量推送，【完全不重启容器】，直接刷新浏览器生效；
 * 2. 静默防抖（Trailing Quiet Period）：写代码打字时不断重置计时器，停手 1.5 秒后才触发合并同步；
 * 3. 语法防崩守卫（Pre-flight Syntax Check）：修改后端 js 时，先做语法闭合检查；语法未闭合时不重启容器；
 * 4. 重启冷却节流（Restart Throttle）：两次容器重启之间保证至少 5 秒冷却，杜绝重启风暴。
 *
 * 用法：
 *   node scripts/sync-debian.mjs          # 一次性手动同步（智能判定是否重启）
 *   node scripts/sync-debian.mjs --watch  # 开启智能监听模式（保存即无感生效）
 */

import { execSync } from 'node:child_process';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watch, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const TARGET_HOST = process.env.DEBIAN_HOST || 'NewAPI';
const TARGET_PATH = process.env.DEBIAN_PATH || '/opt/dh-verify/live/';
const TARGET_CONTAINER = process.env.DEBIAN_CONTAINER || 'dh-web';
const HEALTH_URL = process.env.DEBIAN_HEALTH_URL || 'http://192.168.100.174:5400/digital-human/dh/aaaaaaaa-0000-4000-8000-000000000000/api/healthz';

const RSYNC_EXCLUDES = [
    '--exclude=node_modules',
    '--exclude=.git',
    '--exclude=dist',
    '--exclude=.DS_Store',
    '--exclude=dh-identity-loader.js',
    '--exclude=.env*',
    '--exclude=package-lock.json',
];

const SYNC_PATHS = [
    'src',
    'static',
    'db',
    'run.js',
    'app.json',
    'package.json',
    'dragon-claw-dh.version',
];

// 运行态状态
let syncing = false;
let pendingFiles = new Set();
let lastRestartTime = 0;
const RESTART_COOLDOWN_MS = 4000; // 容器重启最小冷却 4 秒

/** 检查文件是否有语法错误（防止写了一半报错搞崩容器） */
function checkSyntax(filePath) {
    if (!filePath.endsWith('.js') && !filePath.endsWith('.mjs')) return true;
    const abs = resolve(ROOT, filePath);
    if (!existsSync(abs)) return true;
    try {
        execSync(`node --check "${abs}"`, { stdio: 'pipe' });
        return true;
    } catch (err) {
        return false;
    }
}

/** 执行同步主流程 */
async function syncBatch(filesChanged = []) {
    if (syncing) return;
    syncing = true;

    try {
        const fileList = Array.from(filesChanged);
        const hasBackendChange = fileList.length === 0 || fileList.some((f) => !f.startsWith('static/'));
        const hasFrontendOnly = fileList.length > 0 && fileList.every((f) => f.startsWith('static/'));

        // 1. 如果改动了后端文件，先检查改动的 JS 语法是否完整闭合
        if (hasBackendChange && fileList.length > 0) {
            const brokenFiles = fileList.filter((f) => (f.startsWith('src/') || f === 'run.js') && !checkSyntax(f));
            if (brokenFiles.length > 0) {
                console.log(`[\x1b[33mHOLD\x1b[0m] 正在编辑中 (语法未闭合: ${brokenFiles.join(', ')})，暂缓重启容器，等待写完...`);
                syncing = false;
                return;
            }
        }

        const start = Date.now();

        // 2. 增量 rsync
        const rsyncCmd = [
            'rsync',
            '-avz',
            '--delete',
            ...RSYNC_EXCLUDES,
            ...SYNC_PATHS.map((p) => resolve(ROOT, p)),
            `${TARGET_HOST}:${TARGET_PATH}`,
        ];
        execSync(rsyncCmd.join(' '), { stdio: 'pipe' });

        // 3. 动静分流：纯前端改动直接零重启生效！
        if (hasFrontendOnly) {
            const elapsed = ((Date.now() - start) / 1000).toFixed(2);
            console.log(`[\x1b[32mFAST-SYNC\x1b[0m] 静态前端资源推送完成 (${elapsed}s，\x1b[32m零重启\x1b[0m)！`);
            console.log(`           涉及文件: ${fileList.slice(0, 3).join(', ')}${fileList.length > 3 ? ' 等' : ''}`);
            console.log(`           👉 浏览器直接按 F5 刷新即可预览！`);
            syncing = false;
            return;
        }

        // 4. 后端改动，检查冷却时间后重启容器
        const now = Date.now();
        const timeSinceLastRestart = now - lastRestartTime;
        if (timeSinceLastRestart < RESTART_COOLDOWN_MS) {
            const waitTime = RESTART_COOLDOWN_MS - timeSinceLastRestart;
            console.log(`[\x1b[34mWAIT\x1b[0m] 距离上次重启过近，冷却等待 ${(waitTime / 1000).toFixed(1)} 秒...`);
            await new Promise((r) => setTimeout(r, waitTime));
        }

        execSync(`ssh ${TARGET_HOST} "docker restart ${TARGET_CONTAINER}"`, { stdio: 'pipe' });
        lastRestartTime = Date.now();

        // 5. 探活验证
        let healthRes = null;
        for (let i = 0; i < 15; i++) {
            await new Promise((r) => setTimeout(r, 600));
            try {
                const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
                if (res.ok) {
                    healthRes = await res.json();
                    break;
                }
            } catch {
                // 等待容器启动完成
            }
        }

        const elapsed = ((Date.now() - start) / 1000).toFixed(2);
        if (healthRes && healthRes.code === 0) {
            console.log(`[\x1b[32mRELOAD-OK\x1b[0m] 后端更新并重启成功 (${elapsed}s)！`);
            console.log(`           版本: \x1b[33m${healthRes.data?.version || 'unknown'}\x1b[0m | 基座响应: ${healthRes.data?.base_latency_ms}ms`);
            console.log(`           服务正常: http://192.168.100.174:5400/digital-human/dh/aaaaaaaa-0000-4000-8000-000000000000/`);
        } else {
            console.warn(`[\x1b[33mWARN\x1b[0m] 容器已重启 (${elapsed}s)，探活等待超时，请稍后刷新查看`);
        }
    } catch (err) {
        console.error(`[\x1b[31mFAIL\x1b[0m] 同步遇到异常: ${err.message}`);
    } finally {
        syncing = false;
    }
}

// 检查模式
const isWatch = process.argv.includes('--watch');

if (isWatch) {
    console.log(`\x1b[36m=======================================================\x1b[0m`);
    console.log(`  \x1b[1mDragon Claw 智能防抖实时同步服务已启动\x1b[0m`);
    console.log(`  - 目标主机: ${TARGET_HOST} (${TARGET_CONTAINER})`);
    console.log(`  - 规则 1: 前端文件 (static/) 修改 -> \x1b[32m0 秒零重启直接生效\x1b[0m`);
    console.log(`  - 规则 2: 后端文件 (src/) 修改 -> \x1b[33m防抖 1.5s + 语法检查 + 平滑重载\x1b[0m`);
    console.log(`  - 规则 3: 最小重启冷却 4s，彻底杜绝打字时的频繁重启`);
    console.log(`\x1b[36m=======================================================\x1b[0m\n`);

    let debounceTimer = null;
    const QUIET_PERIOD_MS = 1500; // 停顿 1.5 秒无新按键才触发

    const queueChange = (relPath) => {
        if (!relPath || relPath.includes('.DS_Store') || relPath.includes('node_modules')) return;
        pendingFiles.add(relPath);

        // 如果只有静态文件变动，防抖可以更灵敏（800ms），因为不重启容器，完全没有开销
        const allStatic = Array.from(pendingFiles).every((f) => f.startsWith('static/'));
        const delay = allStatic ? 800 : QUIET_PERIOD_MS;

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            const files = new Set(pendingFiles);
            pendingFiles.clear();
            syncBatch(files);
        }, delay);
    };

    ['src', 'static', 'db'].forEach((dir) => {
        try {
            watch(resolve(ROOT, dir), { recursive: true }, (_, filename) => {
                if (filename) queueChange(`${dir}/${filename}`);
            });
        } catch {
            // ignore
        }
    });

    ['run.js', 'app.json', 'package.json'].forEach((file) => {
        try {
            watch(resolve(ROOT, file), () => queueChange(file));
        } catch {
            // ignore
        }
    });

    // 启动时同步一次基线
    syncBatch();
} else {
    syncBatch();
}
