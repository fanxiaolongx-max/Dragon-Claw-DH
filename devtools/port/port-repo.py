#!/usr/bin/env python3
"""把主线版的一个 CommonJS 仓库文件搬成基座 Web 版的 ESM 服务：纯逻辑原样保留，只把读写数据库的函数换掉。
用法：port-repo.py <主线版文件> <输出文件> --head <文件头> --tail <新的存取实现> --drop 名字,名字…
  - 去掉 require 行、module.exports、`await ensureReady();`；
  - --drop 列出的顶层声明（原来读写 SQLite 的函数）整段删掉，由 --tail 里的实现代替。"""
import re, sys
arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
src, dst = sys.argv[1], sys.argv[2]
lines = open(src, encoding='utf8').read().split('\n')
drop = set(filter(None, (arg('--drop', '') or '').split(',')))
out, i, dropped = [], 0, set()
decl = re.compile(r'^(?:async\s+)?function\s+(\w+)\s*\(|^(?:const|let)\s+(\w+)\s*=')
while i < len(lines):
    line = lines[i]
    m = decl.match(line)
    name = m and (m.group(1) or m.group(2))
    if re.match(r'^const .*=\s*require\(', line):
        i += 1; continue
    if line.startswith('module.exports'):
        while not re.search(r'\};?\s*$', lines[i]): i += 1
        i += 1; continue
    if name in drop:
        dropped.add(name)
        single = re.search(r';\s*$', line) and line.count('{') == line.count('}') and line.count('(') == line.count(')')
        if not single:
            i += 1
            while not re.match(r'^[}\])]+\)?;?\s*$', lines[i]): i += 1
        i += 1; continue
    if re.match(r'^\s*await ensureReady\(\);\s*$', line):
        i += 1; continue
    out.append(line); i += 1
missing = drop - dropped
if missing: raise SystemExit(f'--drop 里这些名字没找到：{missing}')
body = re.sub(r'\n{3,}', '\n\n', '\n'.join(out)).strip('\n')
open(dst, 'w', encoding='utf8').write(open(arg('--head'), encoding='utf8').read().rstrip('\n') + '\n\n' + body + '\n\n' + open(arg('--tail'), encoding='utf8').read().lstrip('\n'))
print(dst, len(body.split('\n')), 'lines kept, dropped', sorted(dropped))
