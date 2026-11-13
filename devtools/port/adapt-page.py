#!/usr/bin/env python3
"""把主线版页面改成 基座 Web 版可直接由静态目录提供的页面：
   - <head> 后插入运行时垫片（改写 /api 等绝对路径、注入身份）和规范的 API 基址脚本；
   - 站内绝对路径（/css、/js、/assets、/favicon.ico）改成相对路径，适配网关子路径。
用法：adapt-page.py <主线版页面> <输出文件> [--depth N]   depth 为输出文件相对 static/ 的目录层数（默认 0）"""
import re, sys
src, dst = sys.argv[1], sys.argv[2]
depth = int(sys.argv[sys.argv.index('--depth') + 1]) if '--depth' in sys.argv else 0
up = '../' * depth
html = open(src, encoding='utf8').read()
html = re.sub(r'((?:src|href)=["\'])/(css|js|assets|downloads|favicon\.ico)', lambda m: f'{m.group(1)}{up}{m.group(2)}', html)
shim = f'\n    <script src="{up}js/shared/dh-runtime.js"></script><script src="{up}js/api.js"></script>'
html, n = re.subn(r'<head[^>]*>', lambda m: m.group(0) + shim, html, count=1)
if not n:
    html = shim.strip() + '\n' + html
open(dst, 'w', encoding='utf8').write(html)
print(f'{dst}: {len(html)} chars')
