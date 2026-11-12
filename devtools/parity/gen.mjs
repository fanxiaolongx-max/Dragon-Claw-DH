// 生成 docs/对标与规划.xlsx 和 docs/对标与规划.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { VERSION, DATE, FEATURES, TOOLS, SPEC, ROADMAP } from './data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'docs');

const SHEETS = [
    { name: '功能对比', head: ['模块', '功能', '桌面版', 'Web 版现状', '差异说明', '决策', '优先级', '工作量', '依赖与风险'], rows: FEATURES, widths: [12, 34, 20, 12, 46, 12, 8, 8, 46] },
    { name: '智能体工具', head: ['工具', '桌面版', 'Web 版', '说明'], rows: TOOLS, widths: [48, 22, 18, 40] },
    { name: '规范符合度', head: ['条款', '要求', '现状', '结论', '备注'], rows: SPEC, widths: [14, 50, 10, 8, 70] },
    { name: '路线图', head: ['批次', '事项', '价值', '工作量', '状态'], rows: ROADMAP, widths: [16, 52, 40, 8, 14] },
];

const count = (rows, col, value) => rows.filter((r) => r[col] === value).length;
const MODULES = [...new Set(FEATURES.map((r) => r[0]))];
const STATUSES = ['已对齐', 'Web 专有', '改造', '部分', '未做', '不适用'];
const featureStats = STATUSES.map((s) => [s, count(FEATURES, 3, s)]).filter(([, n]) => n);
const decisionStats = ['已完成', '搬', '改造后搬', '暂缓', '不搬'].map((s) => [s, count(FEATURES, 5, s)]);
const specStats = ['✅', '⚠️', '❓', '—'].map((s) => [s, count(SPEC, 3, s)]);

// ── Excel ──
const FILL = {
    已对齐: 'FFD9F2E3', 已完成: 'FFD9F2E3', '✅': 'FFD9F2E3', 符合: 'FFD9F2E3',
    部分: 'FFFFF1CC', '⚠️': 'FFFFF1CC', 偏离: 'FFFFF1CC', 改造: 'FFFFF1CC', 搬: 'FFDCEBFF', 改造后搬: 'FFDCEBFF',
    'Web 专有': 'FFE3EEFF', 未做: 'FFFDE2E0', '❓': 'FFFDE2E0', 未验证: 'FFFDE2E0', 暂缓: 'FFEDEDED', 不搬: 'FFEDEDED', 不适用: 'FFEDEDED',
    P0: 'FFD9F2E3', P1: 'FFFFD6A5', P2: 'FFFFF1CC', P3: 'FFEDEDED',
};
const wb = new ExcelJS.Workbook();
wb.creator = 'Dragon Claw DH';
const cover = wb.addWorksheet('总览');
cover.columns = [{ width: 26 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }];
cover.addRow([`Dragon Claw 数字人 Web 版 · 对标与规划（v${VERSION}，${DATE}）`]).font = { bold: true, size: 14 };
cover.addRow([]);
cover.addRow(['对标对象', '', '桌面版 Dragon Claw；《运营数字人 · Node.js 服务开发规范 v1.0》']);
cover.addRow([]);
cover.addRow(['功能现状', '项数']).font = { bold: true };
for (const [k, n] of featureStats) cover.addRow([k, n]);
cover.addRow([]);
cover.addRow(['按模块', ...STATUSES, '合计']).font = { bold: true };
for (const mod of MODULES) {
    const rows = FEATURES.filter((r) => r[0] === mod);
    cover.addRow([mod, ...STATUSES.map((st) => count(rows, 3, st) || ''), rows.length]);
}
cover.addRow([]);
cover.addRow(['搬迁决策', '项数']).font = { bold: true };
for (const [k, n] of decisionStats) cover.addRow([k, n]);
cover.addRow([]);
cover.addRow(['规范符合度', '条数', '说明']).font = { bold: true };
cover.addRow(['✅ 符合', specStats[0][1]]);
cover.addRow(['⚠️ 部分 / 偏离', specStats[1][1], '原因和处理办法见「规范符合度」表']);
cover.addRow(['❓ 未验证', specStats[2][1], '只在模拟基座上通过，真实基座上未验证']);
cover.addRow(['— 不适用', specStats[3][1]]);
cover.addRow([]);
cover.addRow(['图例', '', '优先级：P0 已完成 / P1 下一批 / P2 之后 / P3 视需求。工作量：S ≤0.5 天 / M 1–2 天 / L 3–5 天 / XL >1 周']);

for (const sheet of SHEETS) {
    const ws = wb.addWorksheet(sheet.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = sheet.widths.map((width) => ({ width }));
    const head = ws.addRow(sheet.head);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } }; c.alignment = { vertical: 'middle' }; });
    for (const row of sheet.rows) {
        const r = ws.addRow(row);
        r.alignment = { vertical: 'top', wrapText: true };
        r.eachCell((c) => {
            const fill = FILL[String(c.value)];
            if (fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
            c.border = { bottom: { style: 'hair', color: { argb: 'FFBFC5CE' } } };
        });
    }
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.head.length } };
}
await wb.xlsx.writeFile(path.join(OUT, '对标与规划.xlsx'));

// ── Markdown ──
const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
const md = [];
md.push(`# 对标与规划（v${VERSION}，${DATE}）`, '',
    '对标对象：桌面版 Dragon Claw、《运营数字人 · Node.js 服务开发规范 v1.0》。本文件与 `对标与规划.xlsx` 由 `devtools/parity/data.mjs` 生成，改数据后运行 `node devtools/parity/gen.mjs`。', '',
    '## 结论', '',
    `- **功能**：共梳理 ${FEATURES.length} 项。${featureStats.map(([k, n]) => `${k} ${n}`).join('、')}。`,
    `- **决策**：${decisionStats.map(([k, n]) => `${k} ${n}`).join('、')}。不搬的都是依赖本机进程（终端、浏览器、桌面协作）或规范明确禁止的能力；还没完成的 ${FEATURES.filter((r) => ['搬', '改造后搬'].includes(r[5])).length} 项都在 P2（见路线图）。`,
    `- **规范**：共 ${SPEC.length} 条。符合 ${specStats[0][1]}、部分或偏离 ${specStats[1][1]}、未验证 ${specStats[2][1]}、不适用 ${specStats[3][1]}。`,
    '- **最大的未知**：智能体还没有接过真实模型；真实基座上的端到端也没有验证过。', '',
    '### 按模块', '', table(['模块', ...STATUSES, '合计'], MODULES.map((mod) => { const rows = FEATURES.filter((r) => r[0] === mod); return [mod, ...STATUSES.map((st) => count(rows, 3, st) || ''), rows.length]; })), '',
    '「Web 专有」指桌面版没有、但运行在基座上必须具备的能力（启动诊断、依赖预检、前缀适配、分片存储等）；「改造」指同一能力换了实现方式（如登录改为基座身份、发消息改为基座通知）。', '',
    '图例：优先级 P0 已完成 / P1 下一批 / P2 之后 / P3 视需求；工作量 S ≤0.5 天 / M 1–2 天 / L 3–5 天 / XL >1 周。', '',
    '## 路线图', '', table(SHEETS[3].head, ROADMAP), '');
md.push('## 规范符合度', '', '只列出不是“符合”的条款，完整清单见 Excel。', '', table(SHEETS[2].head, SPEC.filter((r) => r[3] !== '✅')), '');
md.push('## 功能对比', '');
for (const mod of [...new Set(FEATURES.map((r) => r[0]))]) {
    md.push(`### ${mod}`, '', table(SHEETS[0].head.slice(1), FEATURES.filter((r) => r[0] === mod).map((r) => r.slice(1))), '');
}
md.push('## 智能体工具对比', '', table(SHEETS[1].head, TOOLS), '');
fs.writeFileSync(path.join(OUT, '对标与规划.md'), md.join('\n'));
console.log(`功能 ${FEATURES.length} 项 | ${featureStats.map(([k, n]) => `${k} ${n}`).join(' ')} | 决策 ${decisionStats.map(([k, n]) => `${k} ${n}`).join(' ')} | 规范 ${SPEC.length} 条 ${specStats.map(([k, n]) => `${k}${n}`).join(' ')}`);
