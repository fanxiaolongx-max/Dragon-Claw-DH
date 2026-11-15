#!/usr/bin/env node
import { execSync } from 'node:child_process';

export function getDbUpgradeNote() {
    try {
        const tags = execSync('git tag --sort=-creatordate', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
        const prevTag = tags[0];
        if (!prevTag) {
            return '✅ **数据库状态**：本版本无需执行数据库脚本（无新增数据表）。';
        }

        const diff = execSync(`git diff ${prevTag}..HEAD -- db/upgrade.sql`, { encoding: 'utf8' }).trim();
        if (!diff) {
            return '✅ **数据库状态**：本版本无需执行数据库脚本（无新增数据表，直接上传安装包即可）。';
        }

        const addedLines = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
        const addedSql = addedLines.map((l) => l.slice(1)).join('\n');
        const matches = [...new Set([...addedSql.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+[`"]?([a-zA-Z0-9_]+)[`"]?/gi)].map((m) => m[1]))];

        if (matches.length > 0) {
            return `⚠️ **数据库变更提示**：本版本新增了数据表（${matches.map((t) => `\`${t}\``).join('、')}），升级前请联系 DBA 在基座库中执行 \`db/upgrade.sql\`。`;
        }

        return 'ℹ️ **数据库变更提示**：`db/upgrade.sql` 存在改动，升级前请对照确认是否需要 DBA 导入。';
    } catch {
        return '升级前请对照 `db/upgrade.sql` 确认是否有新增的表。';
    }
}

const isMain = process.argv[1] && process.argv[1].endsWith('check-db-upgrade-diff.mjs');
if (isMain) {
    process.stdout.write(getDbUpgradeNote() + '\n');
}
