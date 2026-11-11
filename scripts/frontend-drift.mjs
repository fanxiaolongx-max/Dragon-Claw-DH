// 对比 static/ 与桌面版前端：列出桌面版已更新、这里还没同步的文件。
// 用法：node scripts/frontend-drift.mjs <tools-platform/frontend 路径>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = process.argv[2];
if (!source || !fs.existsSync(source)) {
    console.error('用法：node scripts/frontend-drift.mjs <tools-platform/frontend 路径>');
    process.exit(2);
}
const overlay = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend-overlay.json'), 'utf8'));
const known = new Set([...overlay.added, ...overlay.modified]);
const drift = [];
const missingUpstream = [];
(function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(abs); continue; }
        const rel = path.relative(path.join(ROOT, 'static'), abs).split(path.sep).join('/');
        if (known.has(rel) || entry.name === '.DS_Store') continue;
        const upstream = path.join(source, rel);
        if (!fs.existsSync(upstream)) missingUpstream.push(rel);
        else if (!fs.readFileSync(abs).equals(fs.readFileSync(upstream))) drift.push(rel);
    }
})(path.join(ROOT, 'static'));
console.log(`与桌面版不一致、需要同步的文件：${drift.length}`);
for (const file of drift) console.log('  ~', file);
console.log(`桌面版已不存在的文件：${missingUpstream.length}`);
for (const file of missingUpstream) console.log('  -', file);
console.log(`另有 ${overlay.modified.length} 个文件在这里有专门改动（见 frontend-overlay.json），桌面版更新它们时需要人工合并。`);
process.exit(drift.length ? 1 : 0);
