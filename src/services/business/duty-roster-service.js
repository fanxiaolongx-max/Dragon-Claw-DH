// 夜间运维值班表：按月保存。周从周日开始、周五周六为周末（埃及工作周），计算逻辑移植自桌面版。
import { BusinessError } from '../../core/errors.js';
import { listRecords, getRecord, putRecord } from '../record-store.js';

const KIND = 'duty_roster';
const DAY_KEYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const EGYPT_WEEKDAYS = [
    { key: 'Sun', labelZh: '周日', labelEn: 'Sun', isWeekend: false },
    { key: 'Mon', labelZh: '周一', labelEn: 'Mon', isWeekend: false },
    { key: 'Tue', labelZh: '周二', labelEn: 'Tue', isWeekend: false },
    { key: 'Wed', labelZh: '周三', labelEn: 'Wed', isWeekend: false },
    { key: 'Thu', labelZh: '周四', labelEn: 'Thu', isWeekend: false },
    { key: 'Fri', labelZh: '周五', labelEn: 'Fri', isWeekend: true },
    { key: 'Sat', labelZh: '周六', labelEn: 'Sat', isWeekend: true },
];

export function parseMonth(value) {
    const match = String(value || '').trim().match(/^(\d{4})-(0?[1-9]|1[0-2])$/);
    if (!match) throw new BusinessError('月份格式应为 YYYY-MM');
    return { year: Number(match[1]), month: Number(match[2]), text: `${match[1]}-${String(match[2]).padStart(2, '0')}` };
}

const calendarMonth = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`; };

/** 目标月份覆盖到的各周（周日开始、周六结束） */
export function calculateEgyptWeeks(year, month) {
    const firstDay = new Date(Date.UTC(year, month - 1, 1));
    const lastDay = new Date(Date.UTC(year, month, 0));
    const formatDate = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
    const weeks = [];
    let sunday = new Date(Date.UTC(year, month - 1, 1 - firstDay.getUTCDay()));
    while (sunday <= lastDay) {
        const saturday = new Date(sunday.getTime() + 6 * 86400000);
        const key = `${formatDate(sunday)}-${formatDate(saturday)}`;
        const days = DAY_KEYS.map((dayLabel, i) => {
            const date = new Date(sunday.getTime() + i * 86400000);
            return {
                dateStr: date.toISOString().slice(0, 10),
                month: date.getUTCMonth() + 1,
                day: date.getUTCDate(),
                year: date.getUTCFullYear(),
                weekdayIndex: i,
                dayLabel,
                isWeekend: i === 5 || i === 6,
                inTargetMonth: date.getUTCMonth() + 1 === month && date.getUTCFullYear() === year,
            };
        });
        weeks.push({ key, label: key, start: sunday.toISOString().slice(0, 10), end: saturday.toISOString().slice(0, 10), days });
        sunday = new Date(sunday.getTime() + 7 * 86400000);
    }
    return weeks;
}

/** 由月份和已填内容得到整张表：周、行、合计 */
export function buildDutyRosterTable(monthText, existing = null) {
    const { year, month, text } = parseMonth(monthText);
    const weeks = calculateEgyptWeeks(year, month);
    const cells = existing?.cells && typeof existing.cells === 'object' ? existing.cells : {};
    const grid = existing?.grid && typeof existing.grid === 'object' ? existing.grid : {};
    const rows = EGYPT_WEEKDAYS.map((weekday, dayIndex) => {
        const row = { Period: weekday.key };
        for (const week of weeks) row[week.key] = cells[week.days[dayIndex].dateStr] ?? grid[week.key]?.[weekday.key] ?? '';
        return row;
    });
    let filled = 0;
    for (const week of weeks) {
        for (const day of week.days) {
            if (!day.inTargetMonth) continue;
            const value = cells[day.dateStr] || grid[week.key]?.[DAY_KEYS[day.weekdayIndex]];
            if (value && String(value).trim()) filled += 1;
        }
    }
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const totalCount = Number(existing?.totalCount || 353);
    const monthlyCount = filled || (existing?.monthlyCount ?? daysInMonth);
    return {
        month: text,
        title: existing?.title || '夜间运维值班表',
        weeks,
        weekdays: EGYPT_WEEKDAYS,
        rows,
        cells,
        grid,
        totalCount,
        monthlyCount,
        summaryText: existing?.summaryText || `In Total: ${totalCount}, ${filled || daysInMonth}*Person-times for Night Operation On-duty`,
    };
}

/** 示例表：用占位姓名填满，方便看版式（不含真实人员） */
export function getSampleDutyRoster(monthText) {
    const table = buildDutyRosterTable(monthText);
    const cells = {};
    const grid = {};
    table.weeks.forEach((week, weekIndex) => {
        grid[week.key] = {};
        for (const day of week.days) {
            const name = `Engineer ${String(day.weekdayIndex * 5 + (weekIndex % 5) + 1).padStart(2, '0')}`;
            grid[week.key][DAY_KEYS[day.weekdayIndex]] = name;
            cells[day.dateStr] = name;
        }
    });
    return buildDutyRosterTable(monthText, { cells, grid, totalCount: 353 });
}

export async function listDutyRosters() {
    // 最近编辑的在前（排序键是保存时间）
    return (await listRecords(KIND, { limit: 240 })).map((r) => ({
        month: r.period,
        title: r.name,
        totalCount: r.summary.totalCount,
        monthlyCount: r.summary.monthlyCount,
        summaryText: r.summary.summaryText,
        updatedAt: r.updatedAt,
    }));
}

/** 常用值班人员：从已保存的各月值班表里统计，出现次数多的在前（代码里不写任何人员姓名） */
export async function listDutyPeople(limit = 60) {
    const counts = new Map();
    for (const record of await listRecords(KIND, { withPayload: true, limit: 24 })) {
        for (const value of Object.values(record.payload?.cells || {})) {
            for (const name of String(value || '').split(/[,，、;；\/\n]+/).map((x) => x.trim()).filter((x) => x && x.length <= 40)) {
                counts.set(name, (counts.get(name) || 0) + 1);
            }
        }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([name]) => name);
}

/** 没指定月份时：最近编辑过的月份，没有就用当月 */
export async function defaultMonth() {
    return (await listDutyRosters())[0]?.month || calendarMonth();
}

export async function recentDutyRosters() {
    const list = await listDutyRosters();
    return { recentMonth: list[0]?.month || calendarMonth(), calendarMonth: calendarMonth(), list };
}

export async function getDutyRoster(monthText) {
    const { text } = parseMonth(monthText);
    const record = await getRecord(KIND, text);
    if (!record?.payload) return { ...buildDutyRosterTable(text), isSaved: false };
    return { ...buildDutyRosterTable(text, record.payload), isSaved: true };
}

export async function saveDutyRoster(data = {}, updatedBy = '') {
    const table = buildDutyRosterTable(data.month, data);
    const payload = { title: table.title, cells: table.cells, grid: table.grid, totalCount: table.totalCount, monthlyCount: table.monthlyCount, summaryText: table.summaryText };
    await putRecord(KIND, {
        id: table.month,
        name: table.title,
        period: table.month,
        sortKey: new Date().toISOString(),
        summary: { totalCount: table.totalCount, monthlyCount: table.monthlyCount, summaryText: table.summaryText },
        payload,
        updatedBy,
    });
    return table;
}
