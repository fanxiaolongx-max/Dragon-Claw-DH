import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Skill Hub shared badges & category filter chips for Plugins and Tools in digital-human-web', async (t) => {
    const hubCode = fs.readFileSync(path.join(__dirname, '../static/js/home/skill-hub.js'), 'utf8');

    function createMockEnvironment({ isSuper = false, lang = 'zh-CN' } = {}) {
        const mockWindow = {
            localStorage: {
                getItem: (k) => {
                    if (k === 'tools_super') return isSuper ? '1' : '0';
                    if (k === 'tools_tenant_id') return 'default';
                    if (k === 'tools_lang') return lang;
                    return null;
                }
            },
            HomeSkills: {
                items: () => [
                    {
                        id: 'code-review',
                        name: '代码审查',
                        nameEn: 'Code Review',
                        description: '审查代码',
                        descriptionEn: 'Review code',
                        builtIn: true,
                        sharedAccess: true,
                        workspace: true
                    }
                ]
            },
            SkillSource: {
                kind: () => 'builtin'
            },
            HomeCapabilities: {
                groups: () => [
                    {
                        kind: 'float',
                        label: '浏览器扩展',
                        labelEn: 'Browser plugins',
                        where: '浏览器扩展',
                        whereEn: 'Browser extensions',
                        href: '/uivf12',
                        items: [
                            { id: 'f12:plugin-shared', name: '已开放插件', sharedAccess: true, builtIn: true },
                            { id: 'f12:plugin-unshared', name: '未开放插件', sharedAccess: false, builtIn: false }
                        ]
                    }
                ]
            },
            HomeWorkspace: {
                getTools: () => [
                    {
                        id: 'static-builtin-tool',
                        title: '静态内置工具',
                        href: '/html/static.html',
                        builtIn: true,
                        shared: false,
                        sharedAccess: false,
                        group: '平台工具'
                    },
                    {
                        id: 'custom:tool-shared',
                        title: '已开放自定义工具',
                        href: '/custom-tools/tool-shared/index.html',
                        builtIn: false,
                        shared: false,
                        sharedAccess: true,
                        group: '实用工具'
                    },
                    {
                        id: 'custom:tool-unshared',
                        title: '未开放自定义工具',
                        href: '/custom-tools/tool-unshared/index.html',
                        builtIn: false,
                        shared: false,
                        sharedAccess: false,
                        group: '实用工具'
                    }
                ],
                formatRelative: () => '刚刚'
            },
            __homeCustomTools: [
                {
                    slug: 'tool-shared',
                    name: '已开放自定义工具',
                    href: '/custom-tools/tool-shared/index.html',
                    builtIn: false,
                    sharedAccess: true
                },
                {
                    slug: 'tool-unshared',
                    name: '未开放自定义工具',
                    href: '/custom-tools/tool-unshared/index.html',
                    builtIn: false,
                    sharedAccess: false
                }
            ],
            document: {
                readyState: 'complete',
                addEventListener: () => {},
                getElementById: () => null,
                querySelector: () => null,
                querySelectorAll: () => []
            },
            addEventListener: () => {}
        };
        mockWindow.window = mockWindow;
        return mockWindow;
    }

    await t.test('superadmin receives sharedWithAll and unsharedOnly badges and extraCats for plugins', () => {
        const mockEnv = createMockEnvironment({ isSuper: true });
        const context = vm.createContext(mockEnv);
        vm.runInContext(hubCode, context);

        const plugins = mockEnv.HomeSkillHub.entries('plugins');
        assert.equal(plugins.length, 2);
        const sharedPlugin = plugins.find(p => p.capabilityId === 'f12:plugin-shared');
        const unsharedPlugin = plugins.find(p => p.capabilityId === 'f12:plugin-unshared');

        assert.ok(sharedPlugin.badges.includes('全员开放'), 'shared plugin should have 全员开放 badge');
        assert.ok(sharedPlugin.extraCats.includes('sharedWithAll'), 'shared plugin should have sharedWithAll in extraCats');
        assert.equal(sharedPlugin.sharedAccess, true);

        assert.ok(unsharedPlugin.badges.includes('未全员开放'), 'unshared plugin should have 未全员开放 badge for superadmin');
        assert.ok(unsharedPlugin.extraCats.includes('unsharedOnly'), 'unshared plugin should have unsharedOnly in extraCats for superadmin');
        assert.equal(unsharedPlugin.sharedAccess, false);
    });

    await t.test('superadmin receives sharedWithAll and unsharedOnly badges and extraCats for tools', () => {
        const mockEnv = createMockEnvironment({ isSuper: true });
        const context = vm.createContext(mockEnv);
        vm.runInContext(hubCode, context);

        const tools = mockEnv.HomeSkillHub.entries('tools');
        assert.equal(tools.length, 3);
        const sharedTool = tools.find(t => t.id === 'custom:tool-shared');
        const unsharedTool = tools.find(t => t.id === 'custom:tool-unshared');

        assert.ok(sharedTool.badges.includes('全员开放'), 'shared custom tool should have 全员开放 badge');
        // 「工具」标签底部的「工具来源」已有「全员开放」筛选，顶部分类栏不再重复（与主线版一致）
        assert.ok(!sharedTool.extraCats.includes('sharedWithAll'), 'shared tools are filtered by the source filter, not a duplicate top chip');
        assert.equal(sharedTool.sharedAccess, true);

        assert.ok(unsharedTool.badges.includes('未全员开放'), 'unshared custom tool should have 未全员开放 badge for superadmin');
        assert.ok(unsharedTool.extraCats.includes('unsharedOnly'), 'unshared custom tool should have unsharedOnly in extraCats for superadmin');
        assert.equal(unsharedTool.sharedAccess, false);
    });

    await t.test('non-superadmin hides both sharedWithAll and unsharedOnly badges, extraCats, and source filters across skills, plugins, and tools', () => {
        const mockEnv = createMockEnvironment({ isSuper: false });
        const context = vm.createContext(mockEnv);
        vm.runInContext(hubCode, context);

        const tools = mockEnv.HomeSkillHub.entries('tools');
        const sharedTool = tools.find(t => t.id === 'custom:tool-shared');
        const unsharedTool = tools.find(t => t.id === 'custom:tool-unshared');
        assert.ok(!sharedTool.badges.includes('全员开放'), 'non-superadmin must not see 全员开放 badge on tools');
        assert.ok(!unsharedTool.badges.includes('未全员开放'), 'non-superadmin must not see 未全员开放 badge');
        assert.equal(unsharedTool.extraCats.length, 0, 'non-superadmin must not have unsharedOnly in extraCats');

        const plugins = mockEnv.HomeSkillHub.entries('plugins');
        const sharedPlugin = plugins.find(p => p.capabilityId === 'f12:plugin-shared');
        assert.ok(!sharedPlugin.badges.includes('全员开放'), 'non-superadmin must not see 全员开放 badge on plugins');
        assert.ok(!sharedPlugin.extraCats.includes('sharedWithAll'), 'non-superadmin must not have sharedWithAll in plugin extraCats');

        assert.match(hubCode, /skills:\s*\{[^}]*shared:\s*'sharedWithAll'[^}]*unshared:\s*'unsharedOnly'/);
        assert.match(hubCode, /plugins:\s*\{[^}]*shared:\s*'sharedWithAll'[^}]*unshared:\s*'unsharedOnly'/);
        assert.match(hubCode, /if \(\(source === 'shared' \|\| source === 'unshared'\) && !superAdmin\) return \[\]/);
    });

    await t.test('dragon-claw-skills.js optionNode renders dc-skill-share-badge for superadmin and non-superadmin', () => {
        const skillsCode = fs.readFileSync(path.join(__dirname, '../static/js/home/dragon-claw-skills.js'), 'utf8');
        assert.match(skillsCode, /dc-skill-share-badge/, 'must define dc-skill-share-badge');
        assert.match(skillsCode, /dc-skill-option-tags/, 'must wrap option tags in a right-aligned container');
        assert.match(skillsCode, /dc-skill-tag-workspace/, 'must give workspace requirement a distinct tag class');
        assert.match(skillsCode, /isSuperAdminUser\(\)/, 'must check isSuperAdminUser');
        assert.match(skillsCode, /isShared \? '全员开放' : '未全员开放'/, 'must support i18n for shared');
    });

    await t.test('home-shell.js discover popup defines shared and unshared category chips and badges', () => {
        const homeShellCode = fs.readFileSync(path.join(__dirname, '../static/js/home/home-shell.js'), 'utf8');
        assert.match(homeShellCode, /sharedWithAll:\s*'全员开放'/, 'must define sharedWithAll translation in zh-CN');
        assert.match(homeShellCode, /unsharedOnly:\s*'未全员开放'/, 'must define unsharedOnly translation in zh-CN');
        assert.match(homeShellCode, /v2-badge-shared-pill/, 'must render v2-badge-shared-pill in appRow');
        assert.match(homeShellCode, /discover\.cat === 'sharedWithAll'/, 'must handle sharedWithAll filter');
        assert.match(homeShellCode, /discover\.cat === 'unsharedOnly'/, 'must handle unsharedOnly filter');
    });

    await t.test('skill-hub.js defines nonBuiltin translations, swatch styling and filter logic', () => {
        assert.match(hubCode, /nonBuiltin:\s*'非内置'/, 'zh-CN must include nonBuiltin: 非内置');
        assert.match(hubCode, /nonBuiltin:\s*'Non-builtin'/, 'en-US must include nonBuiltin: Non-builtin');
        assert.match(hubCode, /skills:\s*\{[^}]*nonBuiltin:\s*'nonBuiltin'/);
        assert.match(hubCode, /plugins:\s*\{[^}]*nonBuiltin:\s*'nonBuiltin'/);
        assert.match(hubCode, /tools:\s*\{[^}]*nonBuiltin:\s*'nonBuiltin'/);
        assert.match(hubCode, /state\.filterSource === 'nonBuiltin'/);

        const cssCode = fs.readFileSync(path.join(__dirname, '../static/css/home-skill-hub.css'), 'utf8');
        assert.match(cssCode, /\.v2-hub-legend-swatch:is\(\[data-src="nonBuiltin"\],\s*\.is-non-builtin\)\s*\{\s*--swatch-c:\s*#ec4899;\s*\}/);
    });
});
