import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startMockBaseServer } from './helpers/mock-base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const as = (user) => ({ cookie: `iLearningXUserName=${user}` });
const json = (headers = {}) => ({ 'Content-Type': 'application/json', ...headers });

test('ask_user 端到端：前面工具轮已有正文时仍输出问题并在下一轮保留上下文（含旧历史兼容）', async () => {
    const mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        APP_SCHEMA: 'ask-user-test',
        APP_UUID: 'ask-user-test',
        APP_DATASOURCE_ID: '2',
    });
    delete process.env.DH_OPEN_ADMIN;
    delete process.env.DH_ADMIN_USERS;

    const { buildAskedQuestionDelta } = await import('../src/agent/loop.js');
    const { appendQuestionContext } = await import('../src/services/conversation-service.js');
    assert.equal(buildAskedQuestionDelta('', '起始基础分是多少？'), '起始基础分是多少？');
    assert.equal(buildAskedQuestionDelta('好的，我先看一下这个 Excel 的结构。\n\n', '空值行怎么处理？'), '空值行怎么处理？');
    assert.equal(buildAskedQuestionDelta('在开始做看板之前，我有几个疑问需要确认：', '起始基础分是多少？'), '\n\n起始基础分是多少？');
    assert.equal(buildAskedQuestionDelta('在开始做看板之前，我有几个疑问需要确认：\n', '起始基础分是多少？'), '\n起始基础分是多少？');
    assert.equal(buildAskedQuestionDelta('请确认一下：\n起始基础分是多少？', '起始基础分是多少？'), '');

    const legacy = appendQuestionContext(
        '好的，我先看一下这个 Excel 的结构和内容。',
        [{ type: 'question', question: '空值行怎么处理？', options: ['跳过不计分', '视为不满足'] }],
    );
    assert.match(legacy, /\[向用户确认的问题\] 空值行怎么处理？/);
    assert.match(legacy, /\[提供的选项\] 1\. 跳过不计分 \/ 2\. 视为不满足/);

    const alreadyHasQuestion = appendQuestionContext(
        '好的，我先看一下。\n\n空值行怎么处理？',
        [{ type: 'question', question: '空值行怎么处理？', options: ['跳过不计分', '视为不满足'] }],
    );
    assert.doesNotMatch(alreadyHasQuestion, /\[向用户确认的问题\]/);
    assert.match(alreadyHasQuestion, /\[提供的选项\] 1\. 跳过不计分 \/ 2\. 视为不满足/);

    const { createServer } = await import('../src/server.js');
    const { appendMessage } = await import('../src/services/ai-service.js');
    const app = await createServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${app.server.address().port}`;

    const chat = async (user, body) => {
        const res = await fetch(`${url}/api/ai/chat`, {
            method: 'POST',
            headers: json(as(user)),
            body: JSON.stringify({ stream: true, ...body }),
        });
        assert.equal(res.status, 200);
        return (await res.text()).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    };

    try {
        await fetch(`${url}/api/auth/me`, { headers: as('alice') });
        const cfg = await fetch(`${url}/api/ai-settings/profiles`, {
            method: 'POST',
            headers: json(as('alice')),
            body: JSON.stringify({
                name: 'MockLLM',
                baseUrl: `${mock.baseUrl}/v1`,
                apiKey: 'test-key-ask',
                model: 'test-model',
                activate: true,
            }),
        });
        assert.equal(cfg.status, 201);

        // 1. 复现用户日志场景：第 1 轮输出过渡语 + 调工具，第 2 轮输出引导语 + 调 ask_user
        mock.aiRequests.length = 0;
        mock.aiScript.push(
            {
                text: '好的，我先看一下报表概况。',
                toolCalls: [{ name: 'get_report_overview', args: {} }],
            },
            {
                text: '在开始做看板之前，我有几个疑问需要确认：',
                toolCalls: [{
                    name: 'ask_user',
                    args: {
                        question: '起始基础分（满分）是多少？',
                        options: ['100分', '不设满分，只统计总扣分'],
                    },
                }],
            },
        );
        const turn1 = await chat('alice', { messages: [{ role: 'user', content: '帮我做一个汇报看板' }] });
        const deltas = turn1.filter((e) => e.type === 'delta').map((e) => e.delta).join('');
        const qEvent = turn1.find((e) => e.type === 'question');
        const done1 = turn1.find((e) => e.type === 'done');
        assert.ok(qEvent, '应推送 question 事件');
        assert.equal(qEvent.question, '起始基础分（满分）是多少？');
        assert.match(deltas, /起始基础分（满分）是多少？/, '流式正文必须包含 ask_user 的问题');
        assert.match(done1.reply, /好的，我先看一下报表概况。/);
        assert.match(done1.reply, /起始基础分（满分）是多少？/);

        // 校验落库消息同样包含问题正文和 question 事件
        const saved = await (await fetch(`${url}/api/ai/sessions/${done1.sessionId}/messages`, { headers: as('alice') })).json();
        const modelMsg = saved.items.find((m) => m.role === 'model');
        assert.match(modelMsg.content, /起始基础分（满分）是多少？/);
        assert.ok(modelMsg.events.some((e) => e.type === 'question' && e.question === '起始基础分（满分）是多少？'));

        // 2. 下一轮用户回复「第1个」，验证发给模型的历史同时带有问题和编号选项
        mock.aiRequests.length = 0;
        mock.aiScript.push({ text: '收到，按 100 分满分开始计算。' });
        await chat('alice', {
            sessionId: done1.sessionId,
            messages: [
                { role: 'user', content: '帮我做一个汇报看板' },
                { role: 'model', content: done1.reply },
                { role: 'user', content: '第1个' },
            ],
        });
        const turn2Req = mock.aiRequests.find((r) => r.stream);
        const prevAssistant = turn2Req.messages.find((m) => m.role === 'assistant');
        assert.match(prevAssistant.content, /起始基础分（满分）是多少？/);
        assert.match(prevAssistant.content, /\[提供的选项\] 1\. 100分 \/ 2\. 不设满分，只统计总扣分/);

        // 3. 兼容旧库中“正文缺问题、仅 events 里有 question”的历史消息
        await appendMessage(done1.sessionId, 'model', '好的，我先看一下这个 Excel 的结构和内容。', {
            author: 'alice',
            events: [{
                type: 'question',
                question: '空值行在评分时应该怎么处理？',
                options: ['跳过不计分', '视为不满足'],
            }],
        });
        mock.aiRequests.length = 0;
        mock.aiScript.push({ text: '明白，空值行跳过不计分。' });
        await chat('alice', {
            sessionId: done1.sessionId,
            messages: [
                { role: 'user', content: '帮我做一个汇报看板' },
                { role: 'model', content: '好的，我先看一下这个 Excel 的结构和内容。' },
                { role: 'user', content: '选第一个' },
            ],
        });
        const turn3Req = mock.aiRequests.find((r) => r.stream);
        const recoveredAssistant = [...turn3Req.messages].reverse().find((m) => m.role === 'assistant');
        assert.match(recoveredAssistant.content, /\[向用户确认的问题\] 空值行在评分时应该怎么处理？/);
        assert.match(recoveredAssistant.content, /\[提供的选项\] 1\. 跳过不计分 \/ 2\. 视为不满足/);
    } finally {
        await app.close();
        await mock.close();
    }
});

test('基座 Web 版（dh-web）即便是超管也彻底隐藏终端按钮、面板与更多菜单入口', () => {
    const trimCss = fs.readFileSync(path.join(rootDir, 'static/css/dh-web-trim.css'), 'utf8');
    assert.match(trimCss, /html\.dh-web\s+#dcTerminalToggle/);
    assert.match(trimCss, /html\.dh-web\s+#dcTerminalPanel/);

    const dragonClawSrc = fs.readFileSync(path.join(rootDir, 'static/js/home/dragon-claw.js'), 'utf8');
    assert.match(dragonClawSrc, /const hasTerm = !isDhWeb && Boolean\(termBtn && !termBtn\.hidden\)/);

    // 在最小 DOM 沙盒中加载 terminal-sidebar.js，验证 dh-web + 超管下不创建终端 DOM、不打开面板
    const createdNodes = [];
    const insertedAfterBrowser = [];
    const browserToggle = { after: (node) => insertedAfterBrowser.push(node) };
    const workspacePanel = { after: () => {} };
    const windowListeners = new Map();
    const docListeners = new Map();
    const sandboxWindow = {
        DH_BASE: '/digital-human/dh/test-uuid',
        isNavSuperAdmin: () => true,
        addEventListener: (type, fn) => windowListeners.set(type, fn),
        dispatchEvent: () => {},
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        localStorage: { getItem: (k) => (k === 'tools_role' ? 'admin' : k === 'tools_super' ? '1' : null), setItem: () => {} },
        sessionStorage: { getItem: () => null },
    };
    const sandboxDoc = {
        readyState: 'complete',
        documentElement: {
            classList: { contains: (cls) => cls === 'dh-web' },
            dataset: {},
        },
        body: { classList: { contains: () => false, toggle: () => {} } },
        getElementById: (id) => (id === 'dcBrowserToggle' ? browserToggle : id === 'dcWorkspacePanel' ? workspacePanel : null),
        createElement: (tag) => {
            const node = { tag, attrs: {}, setAttribute: (k, v) => { node.attrs[k] = v; }, querySelector: () => null, addEventListener: () => {} };
            createdNodes.push(node);
            return node;
        },
        addEventListener: (type, fn) => docListeners.set(type, fn),
    };
    const ctx = vm.createContext({
        window: sandboxWindow,
        document: sandboxDoc,
        localStorage: sandboxWindow.localStorage,
        sessionStorage: sandboxWindow.sessionStorage,
        navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0' },
        matchMedia: sandboxWindow.matchMedia,
        MutationObserver: class { observe() {} },
        ResizeObserver: class { observe() {} },
        Event: class { constructor(t) { this.type = t; } },
        setTimeout,
        clearTimeout,
        console,
    });
    const terminalSrc = fs.readFileSync(path.join(rootDir, 'static/js/home/terminal-sidebar.js'), 'utf8');
    vm.runInContext(terminalSrc, ctx, { filename: 'terminal-sidebar.js' });

    assert.equal(insertedAfterBrowser.length, 0, 'dh-web 下不应向对话顶栏插入 #dcTerminalToggle');
    assert.equal(createdNodes.length, 0, 'dh-web 下不应创建终端按钮或终端面板 DOM');
    assert.ok(sandboxWindow.DragonTerminalSidebar, '应保留安全的空操作接口');
    sandboxWindow.DragonTerminalSidebar.open();
    assert.equal(sandboxWindow.DragonTerminalSidebar.isOpen(), false);
    assert.equal(docListeners.has('keydown'), false, 'dh-web 下不应注册 Ctrl+` 快捷键');
});

test('workspace-panel.js 渲染 question 事件：正文缺问题时显示标题，正文已有时不重复', () => {
    const wpSrc = fs.readFileSync(path.join(rootDir, 'static/js/home/workspace-panel.js'), 'utf8');
    assert.match(wpSrc, /dc-question-title/);
    assert.match(wpSrc, /dcRawText/);

    // 提取 question 渲染分支并用最小 DOM 节点直接验证行为
    const startIdx = wpSrc.indexOf("} else if (event.type === 'question') {");
    const endIdx = wpSrc.indexOf("} else if (event.type === 'approval') {", startIdx);
    assert.ok(startIdx > 0 && endIdx > startIdx);
    const branch = `${wpSrc.slice(startIdx + 7, endIdx)}\n}`; // "if (event.type === 'question') { ... }"

    const makeElement = (initialBodyText, rawText) => {
        const children = [];
        const body = { textContent: initialBodyText };
        const main = { appendChild: (c) => children.push(c) };
        const el = {
            dataset: rawText === undefined ? {} : { dcRawText: rawText },
            querySelector: (sel) => (sel === '.dc-msg-body' ? body : sel === '.dc-msg-main' ? main : null),
            children,
        };
        return el;
    };

    const runBranch = (messageEl, event, replaying) => {
        const fn = new Function('document', 'window', 'escapeHtml', 'tx', 'replaying', 'messageEl', 'event', branch);
        const doc = {
            createElement: (tag) => ({
                tag,
                className: '',
                innerHTML: '',
                addEventListener: () => {},
                querySelectorAll: () => [],
            }),
        };
        const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        fn(doc, { dispatchEvent: () => {} }, escapeHtml, () => '点选一个回答', replaying, messageEl, event);
        return messageEl.children[0];
    };

    // 1. 旧历史消息正文没有问题文本 -> 卡片必须渲染 dc-question-title
    const legacyEl = makeElement('好的，我先看一下这个 Excel 的结构和内容。', '好的，我先看一下这个 Excel 的结构和内容。');
    const legacyCard = runBranch(legacyEl, {
        type: 'question',
        question: '空值行在评分时应该怎么处理？',
        options: ['跳过不计分', '视为不满足'],
    }, true);
    assert.match(legacyCard.className, /\bhas-title\b/);
    assert.match(legacyCard.className, /\bis-history\b/);
    assert.match(legacyCard.innerHTML, /<div class="dc-question-title">空值行在评分时应该怎么处理？<\/div>/);

    // 2. 新消息正文已经包含问题文本 -> 不重复渲染 dc-question-title
    const newEl = makeElement('正在流式输出...', '好的，我先看一下。\n\n起始基础分（满分）是多少？');
    const newCard = runBranch(newEl, {
        type: 'question',
        question: '起始基础分（满分）是多少？',
        options: ['100分', '不设满分'],
    }, false);
    assert.doesNotMatch(newCard.className, /\bhas-title\b/);
    assert.doesNotMatch(newCard.innerHTML, /dc-question-title/);
});
