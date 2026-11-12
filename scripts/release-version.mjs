// 定版本号并写入各处：发版流水线和本地改版本号都用它。
//   node scripts/release-version.mjs 1.7.0     指定版本
//   node scripts/release-version.mjs --next    自动：取「版本文件里的版本」和「已发布的最高版本 + 1 个修订号」中较大的一个
// 版本文件比已发布的新（手工升了大版本或小版本）就用版本文件的；否则在已发布的最高版本上把修订号加一。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const parse = (text) => { const m = VERSION_RE.exec(String(text).trim().replace(/^v/, '')); return m ? m.slice(1).map(Number) : null; };
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function nextVersion() {
    const fileVersion = parse(fs.readFileSync(path.join(ROOT, 'dragon-claw-dh.version'), 'utf8'));
    if (!fileVersion) throw new Error('dragon-claw-dh.version 里不是合法的版本号（应为 x.y.z）');
    let tags = [];
    try {
        tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: ROOT, encoding: 'utf8' }).split('\n').map(parse).filter(Boolean);
    } catch { /* 不在 git 仓库里：只看版本文件 */ }
    const released = tags.sort(compare).pop();
    if (!released || compare(fileVersion, released) > 0) return fileVersion;
    return [released[0], released[1], released[2] + 1];
}

const arg = process.argv[2];
const version = arg === '--next' ? nextVersion() : parse(arg || '');
if (!version) {
    console.error('用法：node scripts/release-version.mjs <x.y.z | --next>');
    process.exit(2);
}
const text = version.join('.');
fs.writeFileSync(path.join(ROOT, 'dragon-claw-dh.version'), `${text}\n`);
// package.json / package-lock.json 只改最前面的版本字段，不动依赖
for (const file of ['package.json', 'package-lock.json', 'profiles/lite/package.json', 'profiles/lite/package-lock.json']) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) continue;
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    for (let i = 0; i < Math.min(12, lines.length); i += 1) lines[i] = lines[i].replace(/^(\s*"version":\s*")\d+\.\d+\.\d+(")/, `$1${text}$2`);
    fs.writeFileSync(full, lines.join('\n'));
}
console.log(text);
