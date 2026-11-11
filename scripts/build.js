import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { runCheck } from './check.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const ROOT_FILES = [
    'app.json',
    'run.js',
    'package.json',
    'package-lock.json',
    '.npmrc',
    '.nvmrc',
    'dragon-claw-dh.version',
    'README.md',
];

const INCLUDE_DIRS = ['db', 'src', 'static', 'tests'];
// --lite：只带规范白名单内的依赖（fastify / @fastify/static / pino / undici）。
// 内网源缺少 exceljs、@tutao/oxmsg 等包导致完整包安装失败时，用它先把应用跑起来；对应功能会提示改用完整包。
const LITE = process.argv.includes('--lite');
const MAX_ZIP_MB = Number(process.env.DH_MAX_ZIP_MB || 30);
// 精简包不带大体积的可选下载件（UI.Vision 扩展安装包 8MB），下载入口会提示改用完整包
const LITE_SKIP = [/^static\/downloads\/.*\.zip$/];
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', '.git', 'node_modules', 'dist', '.env']);

function addDirToZip(zip, absDir, zipPrefix) {
    if (!fs.existsSync(absDir)) return 0;
    let count = 0;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
        if (SKIP_NAMES.has(entry.name)) continue;
        const absPath = path.join(absDir, entry.name);
        const relZip = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
            count += addDirToZip(zip, absPath, relZip);
        } else if (entry.isFile()) {
            if (LITE && LITE_SKIP.some((re) => re.test(relZip))) continue;
            zip.file(relZip, fs.readFileSync(absPath), {
                unixPermissions: 0o644,
            });
            count += 1;
        }
    }
    return count;
}

const checkRes = await runCheck();
if (!checkRes.ok) {
    console.error('❌ 构建中止：合规检查未通过：');
    for (const err of checkRes.errors) console.error('  -', err);
    process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = fs.existsSync(path.join(ROOT, 'dragon-claw-dh.version'))
    ? fs.readFileSync(path.join(ROOT, 'dragon-claw-dh.version'), 'utf8').trim() || pkg.version
    : pkg.version;

const distDir = path.join(ROOT, 'dist');
fs.mkdirSync(distDir, { recursive: true });

const zip = new JSZip();
let totalFiles = 0;

for (const name of ROOT_FILES) {
    const abs = path.join(ROOT, name);
    const source = LITE && (name === 'package.json' || name === 'package-lock.json') ? path.join(ROOT, 'profiles', 'lite', name) : abs;
    if (fs.existsSync(source) && fs.statSync(source).isFile()) {
        zip.file(name, fs.readFileSync(source), { unixPermissions: 0o644 });
        totalFiles += 1;
    }
}

for (const dirName of INCLUDE_DIRS) {
    totalFiles += addDirToZip(zip, path.join(ROOT, dirName), dirName);
}

const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    platform: 'UNIX',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
});

// 产物自检：根目录必须直接是 app.json / run.js（不含外层目录），路径一律正斜杠，体积不超限
const names = Object.keys(zip.files);
for (const must of ['app.json', 'run.js', 'package.json', 'package-lock.json', '.npmrc', '.nvmrc', 'static/index.html', 'static/js/api.js', 'db/init.sql', 'dragon-claw-dh.version']) {
    if (!names.includes(must)) { console.error(`❌ 构建中止：包内缺少 ${must}`); process.exit(1); }
}
const bad = names.filter((n) => n.includes('\\') || /(^|\/)\.env(\.|$)/.test(n) || n.startsWith('node_modules/') || n.startsWith('scripts/'));
if (bad.length) { console.error(`❌ 构建中止：包内出现禁止入包的路径：${bad.slice(0, 5).join(', ')}`); process.exit(1); }
if (zipBuffer.length > MAX_ZIP_MB * 1024 * 1024) {
    console.error(`❌ 构建中止：ZIP ${(zipBuffer.length / 1048576).toFixed(1)}MB 超过上限 ${MAX_ZIP_MB}MB（可用 DH_MAX_ZIP_MB 调整）`);
    process.exit(1);
}

const outName = `dragon-claw-dh-${version}${LITE ? '-lite' : ''}.zip`;
const outPath = path.join(distDir, outName);
fs.writeFileSync(outPath, zipBuffer);

const md5 = crypto.createHash('md5').update(zipBuffer).digest('hex');
fs.writeFileSync(`${outPath}.md5`, `${md5}  ${outName}\n`, 'utf8');

console.log(`✅ 构建完成: ${path.relative(ROOT, outPath)}`);
console.log(`   文件数: ${totalFiles} | 大小: ${(zipBuffer.length / (1024 * 1024)).toFixed(2)} MB | MD5: ${md5}`);
