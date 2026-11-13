#!/usr/bin/env python3
"""从主线版的 CommonJS 文件里按名字切出顶层声明（function / const / let），原样输出，供搬到 基座 Web 版的 ESM 服务里复用纯逻辑。
用法：slice-js.py <文件> <名字>...      名字前加 export: 则输出时带 export"""
import re, sys
lines = open(sys.argv[1], encoding='utf8').read().split('\n')
def block(name):
    pat = re.compile(r'^(?:async\s+)?function\s+%s\s*\(|^(?:const|let)\s+%s\s*=' % (re.escape(name), re.escape(name)))
    for i, line in enumerate(lines):
        if pat.match(line):
            if re.search(r';\s*$', line) and line.count('{') == line.count('}') and line.count('[') == line.count(']') and line.count('(') == line.count(')'):
                return [line]
            for j in range(i + 1, len(lines)):
                if re.match(r'^[}\])]+[;,]?\s*$', lines[j]) or re.match(r'^\}\)?\(?\)?;?\s*$', lines[j]):
                    return lines[i:j + 1]
    raise SystemExit(f'not found: {name}')
out = []
for arg in sys.argv[2:]:
    export = arg.startswith('export:')
    body = block(arg.split(':')[-1])
    if export:
        body = ['export ' + body[0]] + body[1:]
    out.append('\n'.join(body))
print('\n\n'.join(out))
