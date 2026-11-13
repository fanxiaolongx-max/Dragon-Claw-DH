#!/usr/bin/env python3
"""把主线版的一个内置工具搬进 基座 Web 版：复制到 static/builtin-tools/<slug>/，页面套上运行时垫片，并登记到 manifest.json。
用法：port-builtin-tool.py <主线版 tools-platform 目录> <slug> [--name 名称] [--icon 图标]"""
import json, os, re, shutil, subprocess, sys
desktop, slug = sys.argv[1], sys.argv[2]
opt = lambda k: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else None
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(os.path.dirname(here))
src = os.path.join(desktop, 'backend', 'builtin-tools', slug)
dst = os.path.join(root, 'static', 'builtin-tools', slug)
if os.path.isdir(dst):
    shutil.rmtree(dst)
shutil.copytree(src, dst, ignore=shutil.ignore_patterns('.*', 'reference', 'tailwind.config.js', '*.map'))
for base, _dirs, files in os.walk(dst):
    for name in files:
        if name.endswith('.html'):
            path = os.path.join(base, name)
            depth = 2 + os.path.relpath(base, dst).count(os.sep) + (0 if os.path.relpath(base, dst) == '.' else 1)
            subprocess.run([sys.executable, os.path.join(here, 'adapt-page.py'), path, path, '--depth', str(depth)], check=True)
tool = json.load(open(os.path.join(src, '.tool-manifest.json'), encoding='utf8'))['tool']
manifest_path = os.path.join(root, 'static', 'builtin-tools', 'manifest.json')
manifest = json.load(open(manifest_path, encoding='utf8')) if os.path.exists(manifest_path) else {'tools': []}
entry = {
    'slug': slug,
    'name': opt('--name') or tool.get('name') or slug,
    'nameEn': tool.get('nameEn', ''),
    'icon': opt('--icon') or tool.get('icon') or '🧩',
    'description': tool.get('description', ''),
    'descriptionEn': tool.get('descriptionEn', ''),
    'tags': tool.get('tags', []),
}
manifest['tools'] = sorted([t for t in manifest['tools'] if t['slug'] != slug] + [entry], key=lambda t: t['slug'])
json.dump(manifest, open(manifest_path, 'w', encoding='utf8'), ensure_ascii=False, indent=2)
print('ported', slug, entry['name'])
