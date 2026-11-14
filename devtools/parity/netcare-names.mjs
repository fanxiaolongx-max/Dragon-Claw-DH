// 「业务表待补中文名」：从 NetCare 表目录的盘点种子里挑出没有中文名的表，按表名里的词给一个建议中文名。
// 建议名只是按表名推断，方便基座对照着确认或改正；以基座补充的表注释为准。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/services/netcare/netcare-table-seed.json'), 'utf8'));

// 表名里的词 → 中文。分层 / 粒度后缀（dwd、dws、ods、snap、d、h、m 等）单独处理，放在名字最后。
const WORDS = {
    op: '运营', ioc: 'IOC', nc: 'NetCare', netcareb: 'NetCare', opcenter: '运营中心', cnbg: '运营商BG', ebg: '政企BG', mec: '运营商', '2bg': '两BG', bg: 'BG',
    task: '任务', rfc: 'RFC变更', change: '变更', network: '网络', knet: 'KNET网络', mr: 'MR', sr: 'SR问题单', srvreq: '服务请求', problem: '问题', itr: 'ITR', iwar: 'IWAR',
    report: '报表', rpt: '报表', repor: '报表', details: '明细', detail: '明细', detailed: '明细', dtl: '明细', info: '信息', data: '数据', record: '记录', log: '日志', list: '清单', table: '表', tbl: '表',
    stat: '统计', metrics: '指标', index: '指标', ratio: '比率', times: '次数', analysis: '分析', analyze: '分析', query: '查询', model: '模型', model1: '模型1',
    risk: '风险', erisk: 'eRisk风险', risklist: '风险清单', highrisk: '高危', commands: '命令', redline: '红线', eos: 'EOS', saca: 'SACA作战地图', escalation: '管理升级',
    rectify: '整改', rectification: '整改', check: '核查', inspect: '巡检', insp: '巡检', health: '健康检查', maintenance: '维护', drill: '演练', test: '测试', contingency: '应急预案',
    emergency: '紧急', recovery: '恢复', incident: '事故', incidents: '事故', accident: '事故', major: '重大', event: '事件', alarm: '告警', notification: '通知', notice: '通知',
    product: '产品', version: '版本', software: '软件', license: 'License', nekey: '网元Key', ne: '网元', inventory: '存量', shipment: '发货', contract: '合同', project: '项目',
    customer: '客户', country: '国家', org: '组织', rep: '代表处', division: '部门', parent: '上级', relationship: '关系', rel: '关系', relation: '关系', dim: '维度', common: '公共', comm: '公共',
    owner: '责任人', reviewer: '评审人', developer: '方案制作人', applier: '申请人', manager: '主管', account: '账号', permission: '权限', position: '岗位', post: '岗位', leave: '请假',
    plan: '计划', solution: '方案', rule: '规则', configuration: '配置', dropdown: '下拉选项', item: '条目', level: '等级', l1: 'L1', l2: 'L2', p1: 'P1', p2: 'P2',
    portray: '画像', space: '空间', bubble: '气泡图', map: '地图', topo: '拓扑', card: '红黄牌', pool: '资源池', timeliness: '及时率', tuning: '调优', realtime: '实时',
    third: '第三', party: '方', all: '全量', full: '全量', final: '最终', latest: '最新', previous: '上期', new: '新', temp: '临时', bak: '备份', copy1: '副本', cpoy: '副本', archive: '归档', arc: '归档',
    holiday: '节假日', calendar: '日历', morning: '早报', evening: '晚报', monthly: '月度', day: '日', root: '根', cause: '因', work: '工作', operation: '操作', management: '管理',
    release: '发布', match: '匹配', derive: '衍生', partition: '分区', reverse: '逆向', direction: '方向', united: '联合', it: 'IT', api: 'API', by: '按', some: '部分', no: '编号', net: '网络', base: '基础',
    tired: '疲劳', driving: '驾驶', threetimes: '三次', threetimesday: '三次日', incpt: '拦截', minor: '次要', vw: '视图', vi: '视图', china: '中国', mm: '月',
    bids: 'BIDS', ibms: 'IBMS', gauss: 'Gauss', ogg: 'OGG', clb: 'CLB', dwr: '宽表', uc: 'UC', sa: 'SA', cs: 'CS', ar: 'AR', sd: 'SD', dm: 'DM', du: 'DU', rr: 'RR', rt: 'RT', rc: 'RC', na: 'NA', nt: 'NT', nl: 'NL',
    sn: 'SN', nu: 'NU', qu: 'QU', intg: '集成', prv: '省份', ofr: 'OFR', o3: 'O3', cyrr: 'CYRR', df: 'DF', a: 'A', s: 'S', n: 'N', t: 'T', f: '全量', ga: '全量', v2: 'V2', pc: 'PC', dlvy: '交付',
};
// 分层与粒度：按出现的后缀拼成说明
const LAYERS = { dwd: '明细层', dws: '汇总层', ods: '贴源层', snap: '快照', snapshot: '快照' };
const GRAINS = { d: '日', h: '小时', m: '月' };

function suggest(name) {
    const tokens = name.toLowerCase().split('_').filter(Boolean);
    const words = [];
    const tail = [];
    let partition = '';
    tokens.forEach((token, index) => {
        if (LAYERS[token]) { if (!tail.includes(LAYERS[token])) tail.push(LAYERS[token]); return; }
        // 单个字母的粒度词只在后半段才当粒度看
        if (GRAINS[token] && index >= tokens.length - 3) { tail.unshift(`${GRAINS[token]}粒度`); return; }
        if (/^\d{1,2}$/.test(token) && index === tokens.length - 1) { partition = `分区${token}`; return; }
        if (/^\d+$/.test(token) || /^[0-9a-z]{10,}$/.test(token) && /\d/.test(token)) { words.push(token.toUpperCase()); return; }
        words.push(WORDS[token] ?? token.toUpperCase());
    });
    // 相邻的两个英文 / 数字词之间留一个空格，中文之间不留
    const body = words.reduce((text, word) => text + (/[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(word) ? ' ' : '') + word, '') || name;
    const suffix = [...new Set(tail), partition].filter(Boolean).join('·');
    return `${body}${suffix ? `（${suffix}）` : ''}`;
}

const entries = Object.entries(seed.tables);
export const TABLE_STATS = {
    total: entries.length,
    named: entries.filter(([, t]) => t.nameCn).length,
    unnamed: entries.filter(([, t]) => !t.nameCn).length,
    unnamedWithData: entries.filter(([, t]) => !t.nameCn && t.rows > 0).length,
    empty: entries.filter(([, t]) => !(t.rows > 0)).length,
    source: seed.source,
};

// 序号, 表名, 建议中文名, 类别, 粒度, 估算行数, 字段数, 情况
export const UNNAMED_TABLES = entries
    .filter(([, t]) => !t.nameCn)
    .sort((a, b) => (b[1].rows > 0) - (a[1].rows > 0) || String(a[1].category).localeCompare(String(b[1].category), 'zh') || b[1].rows - a[1].rows || a[0].localeCompare(b[0]))
    .map(([name, t], index) => [index + 1, name, suggest(name), t.category || '其他', t.grain || '', Number(t.rows) || 0, Number(t.columns) || 0, t.rows > 0 ? '有数据，缺中文名' : '空表，缺中文名（请确认是否还在用）']);
