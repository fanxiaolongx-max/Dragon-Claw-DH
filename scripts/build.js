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
    '.env.example',
    'dragon-claw-dh.version',
    'README.md',
];

const INCLUDE_DIRS = ['db', 'src', 'static'];
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
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        zip.file(name, fs.readFileSync(abs), { unixPermissions: 0o644 });
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

const outName = `dragon-claw-dh-${version}.zip`;
const outPath = path.join(distDir, outName);
fs.writeFileSync(outPath, zipBuffer);

const md5 = crypto.createHash('md5').update(zipBuffer).digest('hex');
fs.writeFileSync(`${outPath}.md5`, `${md5}  ${outName}\n`, 'utf8');

console.log(`✅ 构建完成: ${path.relative(ROOT, outPath)}`);
console.log(`   文件数: ${totalFiles} | 大小: ${(zipBuffer.length / (1024 * 1024)).toFixed(2)} MB | MD5: ${md5}`);
