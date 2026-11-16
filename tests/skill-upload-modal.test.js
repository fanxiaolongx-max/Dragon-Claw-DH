import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Upload Skill: HomeTools.openImport registers regardless of async tools_role and opens Skill modal cleanly', () => {
    const homeToolsCode = fs.readFileSync(path.join(__dirname, '../static/js/home/home-tools.js'), 'utf8');
    const skillHubCode = fs.readFileSync(path.join(__dirname, '../static/js/home/skill-hub.js'), 'utf8');
    const homeShellCode = fs.readFileSync(path.join(__dirname, '../static/js/home/home-shell.js'), 'utf8');
    const apiCode = fs.readFileSync(path.join(__dirname, '../static/js/shared/api.js'), 'utf8');

    // Static contracts across hub -> shell -> api
    assert.match(skillHubCode, /row\('upload',\s*t\('uploadSkill'\),\s*'data-v2-do="importSkill"'\)/);
    assert.match(skillHubCode, /event\.target\.closest\('\.v2-hub-menu \[data-v2-do\], \.v2-hub-menu a'\)/);
    assert.match(skillHubCode, /addEventListener\('tools:authchange'/);
    assert.match(homeShellCode, /importSkill\(\)\s*\{\s*window\.HomeTools\?\.openImport\?\.\(\{\s*kind:\s*'skill'\s*\}\);/);
    assert.match(apiCode, /typeof window\.dhResolveUrl === 'function'\s*\?\s*window\.dhResolveUrl\('\/js\/shared\/jszip\.min\.js'\)\s*:\s*'\/js\/shared\/jszip\.min\.js'/);

    // Runtime simulation with empty localStorage at DOMContentLoaded (async auth race)
    const storage = new Map();
    const domListeners = new Map();
    const winListeners = new Map();
    const elements = new Map();
    const makeEl = (id) => {
        const classes = new Set();
        const attrs = {};
        const elListeners = new Map();
        return {
            id,
            value: '',
            textContent: '',
            innerHTML: '',
            title: '',
            hidden: false,
            disabled: false,
            checked: false,
            readOnly: false,
            files: [],
            dataset: {},
            style: {},
            classList: {
                add: (...c) => c.forEach((x) => classes.add(x)),
                remove: (...c) => c.forEach((x) => classes.delete(x)),
                contains: (c) => classes.has(c),
            },
            addEventListener: (type, fn) => {
                if (!elListeners.has(type)) elListeners.set(type, []);
                elListeners.get(type).push(fn);
            },
            setAttribute: (k, v) => { attrs[k] = String(v); },
            removeAttribute: (k) => { delete attrs[k]; },
            closest: () => ({ hidden: false }),
            reset: () => {},
            focus: () => {},
        };
    };

    const ids = [
        'customToolImportModal', 'customToolImportForm', 'customToolFileInput', 'customToolFilePicker',
        'customToolFileName', 'customToolName', 'customToolNameEn', 'customToolIcon', 'customToolDescription',
        'customToolDescriptionEn', 'customToolTags', 'customToolShareField', 'customToolShareCheckbox',
        'customToolImportError', 'customToolImportSubmit', 'customToolAiStatus', 'customToolImportProgress',
        'customToolImportBar', 'customToolImportStatus', 'customToolImportLog', 'customToolImportTitle',
        'customToolImportSubtitle', 'customToolFileTitle', 'customToolFileHint', 'customToolNameLabel',
        'customToolNameEnLabel', 'customToolImportLockedHint', 'customToolImportClose', 'customToolImportCancel',
    ];
    for (const id of ids) elements.set(id, makeEl(id));

    const sandbox = {
        window: null,
        document: {
            body: { style: {} },
            title: '',
            querySelector: () => null,
            querySelectorAll: () => [],
            getElementById: (id) => elements.get(id) || null,
            addEventListener: (type, fn) => {
                if (!domListeners.has(type)) domListeners.set(type, []);
                domListeners.get(type).push(fn);
            },
        },
        localStorage: {
            getItem: (k) => (storage.has(k) ? storage.get(k) : null),
            setItem: (k, v) => storage.set(k, String(v)),
        },
        location: { origin: 'http://127.0.0.1:5400', pathname: '/', search: '' },
        API: { get: async () => [], post: async () => ({}) },
        ToolsI18n: (() => {
            let dict = {};
            return {
                getLanguage: () => 'zh-CN',
                register: (_ns, map) => { dict = { ...dict, ...(map?.['zh-CN'] || {}) }; },
                t: (key, params = {}) => Object.entries(params).reduce(
                    (s, [k, v]) => s.replaceAll(`{${k}}`, String(v)),
                    dict[key] || key
                ),
            };
        })(),
        ToolsPlatformTitle: { apply: () => true },
        CustomToolUpload: { upload: async () => ({}) },
        AppDialog: { alert: async () => {}, confirm: async () => false },
        setTimeout: (fn) => { fn(); return 1; },
        clearTimeout: () => {},
        CustomEvent: function CustomEvent(type, init) { return { type, detail: init?.detail }; },
        Event: function Event() {},
        TextEncoder,
        URLSearchParams,
    };
    sandbox.window = sandbox;
    sandbox.addEventListener = (type, fn) => {
        if (!winListeners.has(type)) winListeners.set(type, []);
        winListeners.get(type).push(fn);
    };

    vm.runInNewContext(homeToolsCode, sandbox);
    for (const fn of domListeners.get('DOMContentLoaded') || []) fn();

    // Even before localStorage tools_role is populated, openImport MUST be registered!
    assert.equal(typeof sandbox.HomeTools.openImport, 'function');

    // Now simulate delayed /api/auth/me populating admin + superadmin
    storage.set('tools_role', 'admin');
    storage.set('tools_super', '1');
    storage.set('tools_tenant_id', 'default');

    sandbox.HomeTools.openImport({ kind: 'skill' });
    const modal = elements.get('customToolImportModal');
    assert.equal(modal.classList.contains('open'), true);
    assert.equal(elements.get('customToolImportTitle').textContent, '导入技能');
    assert.match(elements.get('customToolImportSubtitle').textContent, /SKILL\.md/);
    assert.equal(elements.get('customToolShareField').hidden, false);
    assert.equal(elements.get('customToolImportSubmit').textContent, '导入技能');

    // Opening normally for tools restores tool labels
    sandbox.HomeTools.openImport();
    assert.equal(modal.classList.contains('open'), true);
    assert.equal(elements.get('customToolImportTitle').textContent, '导入自定义工具');
    assert.equal(elements.get('customToolImportSubmit').textContent, '导入工具');
});
