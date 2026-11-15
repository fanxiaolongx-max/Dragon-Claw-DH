// 守住首页唯一入口：旧首页（home-page / home-v2）和旧顶部导航（navbar.js）已删除，不留兼容副本。
// 与主线版 tests/platform-architecture.test.js 对应，路径按基座 static/ 的相对地址写。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../static');
const read = (rel) => fs.readFileSync(path.join(STATIC, rel), 'utf8');
const PLATFORM_MODULES = ['platform-core', 'platform-dialogs', 'platform-settings-controller', 'platform-alerts', 'platform-services', 'platform-tool-updates', 'platform-runtime'];

function listFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'vendor') listFiles(abs, out); } else if (/\.(?:html|js|css)$/.test(entry.name)) out.push(abs);
    }
    return out;
}

test('旧首页与旧顶部导航的文件已删除', () => {
    for (const rel of ['js/shared/navbar.js', 'js/shared/navbar-settings.js', 'js/home/home-page.js', 'js/home/home-v2.js', 'css/home-page.css', 'css/home-v2.css']) {
        assert.equal(fs.existsSync(path.join(STATIC, rel)), false, `${rel} 不应再存在`);
    }
});

test('首页只有一套实现：platform-home + 新模块按顺序加载', () => {
    const html = read('index.html');
    assert.match(html, /<html lang="zh-CN" class="platform-home">/);
    assert.doesNotMatch(html, /data-ui|tools_home_ui/);
    const order = PLATFORM_MODULES.map(name => html.indexOf(`src="js/shared/${name}.js"`));
    assert.ok(order.every(i => i > 0), '首页应加载全部 platform-* 模块');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'platform-* 模块加载顺序与 docs 一致');
    assert.ok(html.indexOf('src="js/home/home-tools.js"') < html.indexOf('src="js/home/home-shell.js"'));
});

test('任何页面和脚本都不再引用旧首页 / 旧导航', () => {
    const banned = /js\/shared\/navbar(?:-settings)?\.js|home-page\.(?:js|css)|home-v2\.(?:js|css)|window\.HomeV2\b|mirrorNavbar|watchNavbar|data-ui=["']v2|dataset\.ui\b/;
    for (const file of listFiles(STATIC)) {
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), banned, path.relative(STATIC, file));
    }
});

test('基座：自定义工具仍映射到静态 custom-tool.html（底座 Nginx 只转发 /api/*）', () => {
    const nav = read('js/shared/tool-navigation.js');
    assert.doesNotMatch(nav, /\/custom-tools\/' \+ [^;]*index\.html/, '不要照搬主线版直达 /custom-tools/<slug>/index.html');
    assert.match(read('js/shared/dh-runtime.js'), /return '\/custom-tool\.html\?' \+ params\.toString\(\) \+ hash;/);
});
