#!/usr/bin/env node
// 按 db/init.sql 里的原表生成「团队版表」team_<表名> 的建表语句，写进 init.sql 和 upgrade.sql 的生成区块：
//   - 第一列加 `team_id`；
//   - 主键、唯一键、普通索引都在最前面加上 team_id（自增列所在的键保持原样：自增值本来就全局唯一，
//     InnoDB 也要求自增列打头建索引）。
// 只有 CREATE TABLE IF NOT EXISTS，可重复执行，和 upgrade.sql 现有写法一致。
// 用法：node scripts/gen-team-tables.mjs          写入两个文件
//       node scripts/gen-team-tables.mjs --check  只检查是否最新（测试用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEAM_TABLES, teamTableName } from '../src/dao/team-scope.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BEGIN = '-- ===== 团队版表（scripts/gen-team-tables.mjs 生成，勿手改）=====';
const END = '-- ===== 团队版表结束 =====';

export function teamTablesSql(initSql) {
    const out = [BEGIN, '-- 非默认团队的工具页面数据存这里（默认团队继续用原表）；结构与原表相同，多一列 team_id。'];
    for (const table of TEAM_TABLES) {
        const m = new RegExp(`CREATE TABLE IF NOT EXISTS \`${table}\`\\s*\\(([\\s\\S]*?)\\)\\s*(ENGINE[^;]*);`).exec(initSql);
        if (!m) throw new Error(`init.sql 里没有表 ${table}`);
        const lines = m[1].split('\n').map((l) => l.replace(/,\s*$/, '').trim()).filter(Boolean);
        const autoCols = new Set(lines.filter((l) => /AUTO_INCREMENT/i.test(l)).map((l) => /^`(\w+)`/.exec(l)?.[1]).filter(Boolean));
        const withTeam = (cols) => {
            const names = [...cols.matchAll(/`(\w+)`/g)].map((c) => c[1]);
            return names.some((n) => autoCols.has(n)) ? cols : `\`team_id\`, ${cols}`;
        };
        const body = ['`team_id` VARCHAR(64) NOT NULL'];
        for (const line of lines) {
            const key = /^((?:PRIMARY|UNIQUE)?\s*KEY(?:\s+`\w+`)?)\s*\(([^)]*)\)$/i.exec(line);
            body.push(key ? `${key[1]} (${withTeam(key[2])})` : line);
        }
        // 每张团队版表都要能按团队快速筛（自增主键的表主键里没有 team_id）
        if (!body.some((l) => /KEY[^(]*\(`team_id`/.test(l))) body.push('KEY `idx_team` (`team_id`)');
        out.push(`CREATE TABLE IF NOT EXISTS \`${teamTableName(table)}\` (\n  ${body.join(',\n  ')}\n) ${m[2]};`);
    }
    out.push(END);
    return out.join('\n\n');
}

function replaceBlock(text, block) {
    const start = text.indexOf(BEGIN);
    const end = text.indexOf(END);
    if (start >= 0 && end > start) return `${text.slice(0, start)}${block}${text.slice(end + END.length)}`;
    return `${text.replace(/\s*$/, '')}\n\n${block}\n`;
}

const isMain = process.argv[1] && process.argv[1].endsWith('gen-team-tables.mjs');
if (isMain) {
    const initPath = path.join(ROOT, 'db', 'init.sql');
    const upgradePath = path.join(ROOT, 'db', 'upgrade.sql');
    const init = fs.readFileSync(initPath, 'utf8');
    const block = teamTablesSql(init);
    const nextInit = replaceBlock(init, block);
    const upgrade = fs.readFileSync(upgradePath, 'utf8');
    const nextUpgrade = replaceBlock(upgrade, `${block.replace(BEGIN, `${BEGIN}\n-- ===== 1.9.0：账号绑定团队 =====`)}`);
    if (process.argv.includes('--check')) {
        const stale = [nextInit !== init && 'db/init.sql', nextUpgrade !== upgrade && 'db/upgrade.sql'].filter(Boolean);
        if (stale.length) { console.error(`团队版表不是最新：${stale.join('、')}，请运行 node scripts/gen-team-tables.mjs`); process.exit(1); }
        console.log('团队版表已是最新');
    } else {
        fs.writeFileSync(initPath, nextInit);
        fs.writeFileSync(upgradePath, nextUpgrade);
        console.log(`已生成 ${TEAM_TABLES.length} 张团队版表`);
    }
}
