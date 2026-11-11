import crypto from 'node:crypto';

export const LIMITS = {
    name: 200,
    prompt: 4000,
    chat: 200,
    widgets: 1_500_000,
    chatText: 6000,
    choices: 8,
    choice: 200,
    code: 30_000,
    html: 400_000,
    result: 60_000,
    cells: 80,
    chapters: 40,
    meta: 24,
    sources: 8,
};

export const FIXED_PREFIX = '固定文字：';
export const FIELD_KEY = /^(title|subtitle|footer|meta-value:[-\w]{1,80})$/;
export const IMAGE_KEY = /^logo$/;
export const IMAGE_BASE = {
    logo: '月报 LOGO：扁平矢量风格，简洁专业，在 120px 宽度下也清晰可辨；画布 1:1（viewBox="0 0 512 512"）；透明背景；主色使用月报主题色，整体不超过 3 种颜色；图形在画布中居中，四周留白均匀；图形为主，若有文字只用一个简短的英文缩写或两三个汉字，无衬线粗体；不画细线、小字、照片质感或复杂渐变。',
};

const STYLE_SECTION = '【风格与配色】';
const DEFAULT_RULES = [
    '【数据与计算】',
    '- 所有数字都由数据计算得出，不写死、不用示例数据；本月取不到数据时如实说明缺少数据。',
    '- 指标按名称取数（同一个指标换月后 key 可能变化）；用到的指标都要列入数据来源。',
    '- 名称里带“增量、差值、变化、环比、同比、占比、达成率”的计算型指标，以算出的结果作为主数值展示。',
    '- 判断是否达标、计算与目标的差距时，使用预警目标配置中的当月目标值，不写死目标。',
    '【文字与结论】',
    '- 每个格子只保留一段文字总结：默认显示在格子顶部；提示词指定了位置时放在指定位置。',
    '- 写“最高 / 最低”“最优 / 最差”时要处理并列：全部相同时写“均为 X，持平”，并列时列出所有名称。',
    '- 指标卡下方的变化写成“较上月 +2”“与上月持平”，不单独显示没有说明的数字。',
    '【排版与图表】',
    '- 格子宽度不超过 4/12 栏时，所有内容从上到下排列，一行只放一个内容块。',
    '- 一个格子里有多个内容块时，用小格子排版；长名称截断或缩写，鼠标悬停时显示全称。',
    '- 鼠标悬停、高亮时图形和文字不能消失；坐标轴标签、图例和文字不能超出格子边界。',
].join('\n');

export const DEFAULT_STYLE = `${STYLE_SECTION}\n- 使用平台默认的蓝色商务风格（还没有定制，可以在对话里说明想要的主题、色调和语气）。\n- 月报四周用双线边框包围（外粗内细）；格子之间用细线分隔，不用卡片边框。\n- 不显示标题的章节（快速导航、本月概述）用浅色细线框围成面板，彼此间距紧凑。\n${DEFAULT_RULES}`;

export const validMonth = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value || '');
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
export const bilingual = (zh = '', en = '') => ({ zh: String(zh || ''), en: String(en || '') });
const pair = (value, max = 4000) => (
    value && typeof value === 'object'
        ? bilingual(str(value.zh, max), str(value.en, max))
        : bilingual(str(value, max), '')
);
const cleanId = (value, prefix) => (typeof value === 'string' && /^[-\w]{1,80}$/.test(value) ? value : uid(prefix));
const clamp = (value, min, max, fallback) => {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};
const hex = (value, fallback = '') => (/^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : fallback);

function invalid(message) {
    const error = new Error(message);
    error.status = 400;
    throw error;
}

export function imageUrl(value) {
    const url = String(value || '');
    return /^(\.)?\/api\/ai-report\/images\/[-\w]{1,80}$|^(\.)?\/api\/upload\/monthly-logos\/[-\w%]{1,120}\/image$|^(\.)?\/?assets\/[-\w./]{1,200}$/.test(url)
        ? url
        : '';
}

export function normalizeLayout(input) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const [slot, size] of Object.entries(input).slice(0, 20)) {
        if (!/^[A-Za-z][\w-]{0,30}$/.test(slot) || !size || typeof size !== 'object') continue;
        const entry = {};
        if (Number.isFinite(Number(size.width)) && size.width !== null && size.width !== '') {
            entry.width = clamp(size.width, 5, 100, 0);
        }
        if (size.height) entry.height = clamp(size.height, 60, 1600, 0);
        if (entry.width || entry.height) out[slot] = entry;
    }
    return out;
}

export function normalizeRounds(rounds) {
    const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0;
    };
    return (Array.isArray(rounds) ? rounds : [])
        .slice(0, 30)
        .filter((r) => r && typeof r === 'object')
        .map((r, idx) => ({
            index: idx + 1,
            model: str(r.model, 120),
            inputTokens: num(r.inputTokens),
            outputTokens: num(r.outputTokens),
            estimated: r.estimated === true,
            ms: num(r.ms),
            ttftMs: r.ttftMs == null ? null : num(r.ttftMs),
            generationMs: num(r.generationMs),
            tps: num(r.tps),
            at: str(r.at, 40),
        }));
}

export function normalizeSource(source, index) {
    if (!source || typeof source !== 'object') invalid('Invalid recipe source');
    const sourceId = typeof source.id === 'string' && /^[a-z]\w{0,20}$/i.test(source.id) ? source.id : `s${index + 1}`;
    if (source.kind === 'sheet') {
        const match = source.match || {};
        if (!str(match.sourceKey, 300) && !str(match.tableName, 300)) invalid('Sheet source needs a table identity');
        return {
            id: sourceId,
            kind: 'sheet',
            label: str(source.label, 200),
            match: {
                sourceKey: str(match.sourceKey, 300),
                tableName: str(match.tableName, 300),
                sheetName: str(match.sheetName, 200),
                kind: str(match.kind, 40),
            },
            monthOffset: clamp(source.monthOffset, -24, 0, 0),
        };
    }
    if (source.kind === 'metrics') {
        return {
            id: sourceId,
            kind: 'metrics',
            label: str(source.label, 200),
            names: (Array.isArray(source.names) ? source.names : []).slice(0, 60).map((n) => str(n, 200)).filter(Boolean),
            keys: (Array.isArray(source.keys) ? source.keys : []).slice(0, 60).map((k) => str(k, 300)).filter(Boolean),
            monthOffset: clamp(source.monthOffset, -24, 0, 0),
        };
    }
    if (source.kind === 'dataset') {
        const dataset = str(source.dataset, 400);
        if (!dataset) invalid('Dataset source needs a dataset id');
        return { id: sourceId, kind: 'dataset', label: str(source.label, 200), dataset, monthOffset: clamp(source.monthOffset, -24, 0, 0) };
    }
    if (source.kind === 'report') {
        return {
            id: sourceId,
            kind: 'report',
            label: str(source.label, 200),
            include: source.include === 'results' ? 'results' : 'outline',
            chapters: (Array.isArray(source.chapters) ? source.chapters : []).slice(0, LIMITS.chapters).map((c) => str(c, 80)).filter(Boolean),
        };
    }
    if (source.kind === 'tool') {
        return { id: sourceId, kind: 'tool', label: str(source.label, 200), slug: str(source.slug, 120), question: str(source.question, 1000) };
    }
    invalid('Unknown recipe source kind');
}

export function normalizeRecipe(recipe) {
    if (!recipe || typeof recipe !== 'object') invalid('Invalid recipe');
    const sources = (Array.isArray(recipe.sources) ? recipe.sources : []).slice(0, LIMITS.sources).map(normalizeSource);
    const compute = str(recipe.compute, LIMITS.code);
    const render = str(recipe.render, LIMITS.code);
    if (!/function\s+compute\s*\(/.test(compute)) invalid('Recipe compute must define function compute(input)');
    if (!/function\s+render\s*\(/.test(render)) invalid('Recipe render must define function render(result, kit)');
    return {
        summary: pair(recipe.summary, 1000),
        sources,
        compute,
        render,
        narrative: recipe.narrative && str(recipe.narrative.prompt, 2000) ? { prompt: str(recipe.narrative.prompt, 2000) } : null,
    };
}

export function normalizeOutput(output) {
    let result = null;
    try {
        const txt = JSON.stringify(output?.result ?? null);
        result = txt.length <= LIMITS.result ? JSON.parse(txt) : null;
    } catch { result = null; }
    let widgets = [];
    try {
        const list = (Array.isArray(output?.widgets) ? output.widgets : [])
            .filter((item) => item && /^w\d{1,3}$/.test(item.id) && ['chart', 'datatable', 'tabs', 'interactive'].includes(item.type))
            .slice(0, 40);
        widgets = JSON.stringify(list).length <= LIMITS.widgets ? list : [];
    } catch { widgets = []; }
    return {
        month: validMonth(output?.month) ? output.month : '',
        html: str(output?.html, LIMITS.html),
        widgets,
        result,
        narrative: pair(output?.narrative, 4000),
        narrativeMonth: validMonth(output?.narrativeMonth) ? output.narrativeMonth : '',
        error: str(output?.error, 2000),
        generatedAt: str(output?.generatedAt, 40),
    };
}

export function normalizeTheme(input) {
    if (!input || typeof input !== 'object') return null;
    const palette = (Array.isArray(input.palette) ? input.palette : []).map((c) => hex(c)).filter(Boolean).slice(0, 8);
    return {
        accent: hex(input.accent, '#1f5e95'),
        accentSoft: hex(input.accentSoft, '#e6f0fa'),
        heading: hex(input.heading, '#132c45'),
        surface: hex(input.surface, '#ffffff'),
        palette: palette.length >= 3 ? palette : [],
        font: input.font === 'serif' ? 'serif' : 'sans',
        radius: clamp(input.radius, 0, 16, 8),
        frame: ['double', 'single', 'none'].includes(input.frame) ? input.frame : 'double',
        frameColor: hex(input.frameColor),
        dividers: ['line', 'dashed', 'none'].includes(input.dividers) ? input.dividers : 'line',
        dividerColor: hex(input.dividerColor),
        panels: ['box', 'none'].includes(input.panels) ? input.panels : 'box',
    };
}

function promptSnapshot(item) {
    const snap = item.edited ? { edited: true } : {};
    if (item.sized) {
        snap.sized = true;
        const size = item.previousSize || {};
        snap.previousSize = { height: size.height ? clamp(size.height, 60, 1600, 0) : 0, fit: size.fit === true, span: clamp(size.span, 1, 12, 6) };
    }
    if (item.recipe && typeof item.recipe === 'object') {
        try { snap.recipe = normalizeRecipe(item.recipe); } catch { /* ignore invalid */ }
    }
    if (item.narrative && typeof item.narrative === 'object') {
        snap.narrative = pair(item.narrative, 4000);
        if (validMonth(item.narrativeMonth)) snap.narrativeMonth = item.narrativeMonth;
    }
    if (item.theme && typeof item.theme === 'object') {
        const theme = normalizeTheme(item.theme);
        if (theme) snap.theme = theme;
    }
    return snap;
}

export function normalizeChat(chat) {
    return (Array.isArray(chat) ? chat : [])
        .slice(-LIMITS.chat)
        .filter((item) => item && ['user', 'ai'].includes(item.role))
        .map((item) => ({
            role: item.role,
            text: str(item.text, LIMITS.chatText),
            ...(item.role === 'ai' && Array.isArray(item.rounds) && item.rounds.length ? { rounds: normalizeRounds(item.rounds) } : {}),
            ...(Array.isArray(item.choices) && item.choices.length ? { choices: item.choices.slice(0, LIMITS.choices).map((c) => str(c, LIMITS.choice)).filter(Boolean) } : {}),
            ...(['answer', 'ask', 'prompt', 'note', 'image', 'gallery', 'image_delete'].includes(item.kind) ? { kind: item.kind } : {}),
            ...(item.kind === 'gallery' && imageUrl(item.picked) ? { picked: imageUrl(item.picked) } : {}),
            ...(Array.isArray(item.images) && ['image', 'gallery', 'image_delete'].includes(item.kind)
                ? { images: item.images.slice(0, 500).map((img) => ({ url: imageUrl(img?.url), name: str(img?.name, 200), id: str(img?.id, 90) })).filter((img) => img.url) }
                : {}),
            ...(['abbr', 'rule'].includes(item.purpose) ? { purpose: item.purpose } : {}),
            ...(item.kind === 'prompt' ? promptSnapshot(item) : {}),
        }));
}

export function cell(input = {}) {
    return {
        id: cleanId(input.id, 'cell'),
        span: clamp(input.span, 1, 12, 6),
        height: input.height ? clamp(input.height, 60, 1600, 0) : 0,
        fit: input.fit === true && Boolean(input.height),
        abbreviation: str(input.abbreviation, 500),
        layout: normalizeLayout(input.layout),
        prompt: str(input.prompt, LIMITS.prompt),
        recipePrompt: str(input.recipePrompt, LIMITS.prompt),
        chat: normalizeChat(input.chat),
        recipe: input.recipe ? normalizeRecipe(input.recipe) : null,
        output: input.output ? normalizeOutput(input.output) : null,
    };
}

export function chapter(input = {}) {
    const cells = Array.isArray(input.cells) ? input.cells.slice(0, LIMITS.cells).map(cell) : [];
    const style = input.style && typeof input.style === 'object'
        ? { prompt: str(input.style.prompt, LIMITS.prompt), chat: normalizeChat(input.style.chat), appliedPrompt: str(input.style.appliedPrompt, LIMITS.prompt) }
        : null;
    return {
        id: cleanId(input.id, 'chapter'),
        title: pair(input.title, 200),
        cells,
        ...(input.numbered === false ? { numbered: false } : {}),
        ...(input.heading === false ? { heading: false } : {}),
        ...(style && (style.prompt || style.chat.length) ? { style } : {}),
    };
}

export function structuredStyle(prompt) {
    const text = String(prompt || '').trim();
    if (!text) return DEFAULT_STYLE;
    if (/^【[^】\n]+】/m.test(text)) return text;
    return `${STYLE_SECTION}\n${text.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => (/^[-•·]/.test(l) ? `- ${l.replace(/^[-•·]\s*/, '')}` : `- ${l}`)).join('\n')}\n${DEFAULT_RULES}`;
}

export function styleSections(text) {
    const sections = [];
    let current = null;
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const head = line.match(/^【([^】]+)】\s*(.*)$/);
        if (head) {
            current = { name: head[1].trim(), items: [] };
            sections.push(current);
            if (head[2]) current.items.push(head[2].replace(/^[-•·]\s*/, ''));
            continue;
        }
        if (!current) {
            current = { name: STYLE_SECTION.slice(1, -1), items: [] };
            sections.push(current);
        }
        current.items.push(line.replace(/^[-•·]\s*/, ''));
    }
    return sections;
}

const formatStyle = (sections) => sections.filter((s) => s.items.length).map((s) => `【${s.name}】\n${s.items.map((i) => `- ${i}`).join('\n')}`).join('\n');

export function applyStyleChanges(text, changes) {
    const sections = styleSections(text);
    const skipped = [];
    const plain = (v) => String(v || '').replace(/^[-•·]\s*/, '').replace(/\s+/g, '').replace(/[。.；;]+$/g, '');
    const locate = (item) => {
        const wanted = plain(item);
        if (!wanted) return null;
        for (const same of [(f) => f === wanted, (f) => f.includes(wanted) || wanted.includes(f)]) {
            for (const section of sections) {
                const idx = section.items.findIndex((f) => same(plain(f)));
                if (idx >= 0) return { section, index: idx };
            }
        }
        return null;
    };
    for (const change of Array.isArray(changes) ? changes : []) {
        const item = String(change?.item || '').trim().replace(/^[-•·]\s*/, '');
        if (change?.action === 'add') {
            const name = String(change.section || '').replace(/[【】]/g, '').trim() || '其他要求';
            if (!item) continue;
            let section = sections.find((s) => s.name === name);
            if (!section) {
                section = { name, items: [] };
                sections.push(section);
            }
            if (!section.items.some((f) => plain(f) === plain(item))) section.items.push(item);
        } else if (change?.action === 'remove' || change?.action === 'replace') {
            const at = locate(item);
            if (!at) { skipped.push(change); continue; }
            const to = String(change.to || '').trim().replace(/^[-•·]\s*/, '');
            if (change.action === 'remove') at.section.items.splice(at.index, 1);
            else if (to) at.section.items[at.index] = to;
        }
    }
    return { prompt: formatStyle(sections), skipped };
}

export function withStyleText(text, style) {
    const sections = styleSections(text);
    const lines = String(style || '').split(/\n+/).map((l) => l.trim().replace(/^[-•·]\s*/, '')).filter(Boolean);
    const section = sections.find((s) => s.name === STYLE_SECTION.slice(1, -1));
    if (section) section.items = lines;
    else sections.unshift({ name: STYLE_SECTION.slice(1, -1), items: lines });
    return formatStyle(sections);
}

export function normalizeReport(input) {
    if (!input || typeof input !== 'object') invalid('Invalid report');
    const chapters = (Array.isArray(input.chapters) ? input.chapters : []).slice(0, LIMITS.chapters).map(chapter);
    const templateInput = input.template || {};
    const fields = {};
    if (templateInput.fields && typeof templateInput.fields === 'object') {
        for (const [k, v] of Object.entries(templateInput.fields).slice(0, 60)) {
            if (!FIELD_KEY.test(k) || !v || typeof v !== 'object') continue;
            fields[k] = { prompt: str(v.prompt, 2000).trim(), chat: normalizeChat(v.chat), appliedPrompt: str(v.appliedPrompt, 2000) };
        }
    }
    const tplImages = {};
    if (templateInput.images && typeof templateInput.images === 'object') {
        for (const [k, v] of Object.entries(templateInput.images)) {
            if (!IMAGE_KEY.test(k) || !v || typeof v !== 'object') continue;
            tplImages[k] = { prompt: str(v.prompt, 2000).trim(), chat: normalizeChat(v.chat) };
        }
    }
    const styleIn = input.style || {};
    const prompt = str(structuredStyle(styleIn.prompt), LIMITS.prompt);
    const styleChat = normalizeChat(styleIn.chat);
    if (!styleChat.some((c) => c.kind === 'prompt')) styleChat.push({ role: 'ai', kind: 'prompt', text: prompt });

    return {
        version: 1,
        id: typeof input.id === 'string' && /^[-\w]{1,80}$/.test(input.id) ? input.id : '',
        name: str(input.name, LIMITS.name).trim() || 'AI 月报',
        reportMonth: validMonth(input.reportMonth) ? input.reportMonth : '',
        template: {
            logo: str(templateInput.logo, 500) || './assets/logo.png',
            logoWidth: clamp(templateInput.logoWidth, 40, 400, 120),
            title: pair(templateInput.title, 300),
            subtitle: pair(templateInput.subtitle, 300),
            meta: (Array.isArray(templateInput.meta) ? templateInput.meta : []).slice(0, LIMITS.meta).map((m) => ({
                id: cleanId(m?.id, 'meta'),
                label: pair(m?.label, 200),
                value: pair(m?.value, 2000),
                span: clamp(m?.span, 1, 12, 4),
            })),
            footer: pair(templateInput.footer, 2000),
            ...(Object.keys(fields).length ? { fields } : {}),
            ...(Object.keys(tplImages).length ? { images: tplImages } : {}),
        },
        style: {
            prompt,
            chat: styleChat,
            theme: normalizeTheme(styleIn.theme),
            themePrompt: str(styleIn.themePrompt, LIMITS.prompt),
        },
        chapters: chapters.length ? chapters : [chapter({ title: bilingual('整体情况', 'Overview'), cells: [cell()] })],
        updatedAt: str(input.updatedAt, 40),
    };
}

export function fromLegacyTemplate(legacy, reportMonth = '') {
    const doc = legacy?.document || legacy || {};
    return normalizeReport({
        name: doc.name || 'AI 月报',
        reportMonth,
        template: {
            logo: doc.logo || './assets/logo.png',
            logoWidth: doc.logoWidth,
            title: doc.title || bilingual('运营运维 SLA 月度质量报告', 'Monthly Operations Quality Report'),
            subtitle: doc.subtitle || bilingual('Digital Human Cloud Web Edition', 'Monthly Governance Summary'),
            meta: Array.isArray(doc.meta) ? doc.meta.map((m) => ({ label: m.label, value: m.value, span: m.span })) : [
                { id: 'meta-period', label: bilingual('报告周期', 'Period'), value: bilingual(reportMonth || '', reportMonth || ''), span: 4 },
                { id: 'meta-team', label: bilingual('输出团队', 'Owner'), value: bilingual('AIOps 运营团队', 'AIOps Team'), span: 4 },
            ],
            footer: doc.footer || bilingual('内部运营资料 · 请勿外传', 'Internal Operations Report'),
        },
        chapters: (doc.sections || []).filter((s) => !s.overview).length
            ? (doc.sections || []).filter((s) => !s.overview).map((s) => ({ title: s.title, cells: [cell({ span: 12 })] }))
            : undefined,
    });
}

export function validSnapshotFilter(value) {
    return Number.isInteger(value) && value >= 0 && value <= 10_000;
}

export function documentRevision(doc) {
    return crypto.createHash('sha256').update(JSON.stringify(doc || {})).digest('hex');
}

export function selectLatestSnapshotPerMonth(rows) {
    const latestByMonth = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        const trendMonth = String(row?.trend_month || '').trim();
        if (!/^\d{4}-\d{2}$/.test(trendMonth)) continue;
        const current = latestByMonth.get(trendMonth);
        if (!current) {
            latestByMonth.set(trendMonth, row);
            continue;
        }
        const rowTime = String(row.created_at || '');
        const currentTime = String(current.created_at || '');
        if (rowTime > currentTime || (rowTime === currentTime && Number(row.id) > Number(current.id))) {
            latestByMonth.set(trendMonth, row);
        }
    }
    return Array.from(latestByMonth.values()).sort((a, b) => {
        const cmp = String(a.trend_month).localeCompare(String(b.trend_month));
        return cmp || (Number(a.id) - Number(b.id));
    });
}
