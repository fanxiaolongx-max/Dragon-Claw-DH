// 精确计算（不使用 eval）：递归下降解析四则运算、乘方、括号、函数调用与日期。
// 模型心算容易出错，涉及占比、增减幅、工作日这类数字时让它调用 calculate 工具。
const DAY = 86_400_000;

function tokenize(src) {
    const tokens = [];
    const re = /\s*(?:(\d+(?:\.\d+)?(?:e[+-]?\d+)?%?)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|[-+*/%^(),]))/gy;
    let pos = 0;
    while (pos < src.length) {
        re.lastIndex = pos;
        const m = re.exec(src);
        if (!m) {
            if (!src.slice(pos).trim()) break;
            throw new Error(`无法识别的内容：${src.slice(pos, pos + 12)}`);
        }
        pos = re.lastIndex;
        if (m[1] !== undefined) tokens.push({ t: 'num', v: m[1].endsWith('%') ? Number(m[1].slice(0, -1)) / 100 : Number(m[1]) });
        else if (m[2] !== undefined) tokens.push({ t: 'str', v: m[2].slice(1, -1) });
        else if (m[3] !== undefined) tokens.push({ t: 'id', v: m[3].toLowerCase() });
        else tokens.push({ t: 'op', v: m[4] === '**' ? '^' : m[4] });
    }
    return tokens;
}

function toDate(value) {
    if (value instanceof Date) return value;
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(value).trim());
    if (!m) throw new Error(`日期要写成 "YYYY-MM-DD"：${value}`);
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (d.getUTCMonth() !== Number(m[2]) - 1) throw new Error(`日期不存在：${value}`);
    return d;
}
const fmtDate = (d) => d.toISOString().slice(0, 10);
const num = (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('需要数字参数');
    return v;
};
const flat = (args) => args.flat(Infinity).map(num);
const isRest = (d, restDays) => restDays.includes(d.getUTCDay());
const restOf = (v) => (v === undefined ? [0, 6] : String(v).split(/[,，\s]+/).filter(Boolean).map(Number));

const FUNCS = {
    percent: (part, whole) => (num(part) / num(whole)) * 100,
    change_percent: (oldV, newV) => ((num(newV) - num(oldV)) / Math.abs(num(oldV))) * 100,
    sum: (...a) => flat(a).reduce((x, y) => x + y, 0),
    avg: (...a) => { const l = flat(a); if (!l.length) throw new Error('avg 需要至少一个数'); return l.reduce((x, y) => x + y, 0) / l.length; },
    median: (...a) => { const l = flat(a).sort((x, y) => x - y); if (!l.length) throw new Error('median 需要至少一个数'); const m = Math.floor(l.length / 2); return l.length % 2 ? l[m] : (l[m - 1] + l[m]) / 2; },
    min: (...a) => Math.min(...flat(a)),
    max: (...a) => Math.max(...flat(a)),
    abs: (x) => Math.abs(num(x)),
    sqrt: (x) => Math.sqrt(num(x)),
    floor: (x) => Math.floor(num(x)),
    ceil: (x) => Math.ceil(num(x)),
    round: (x, digits = 0) => { const p = 10 ** num(digits); return Math.round((num(x) + Number.EPSILON) * p) / p; },
    today: () => fmtDate(new Date(Date.now() + 8 * 3600_000)), // 按北京时间
    days_between: (a, b) => Math.round((toDate(b) - toDate(a)) / DAY),
    add_days: (d, n) => fmtDate(new Date(toDate(d).getTime() + num(n) * DAY)),
    add_months: (d, n) => { const x = toDate(d); const day = x.getUTCDate(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + num(n)); const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate(); x.setUTCDate(Math.min(day, last)); return fmtDate(x); },
    weekday: (d) => ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][toDate(d).getUTCDay()],
    // 首尾两天都算；rest 为休息日（0=周日 … 6=周六），默认周六周日
    workdays_between: (a, b, rest) => {
        const restDays = restOf(rest);
        let [from, to] = [toDate(a), toDate(b)];
        if (from > to) [from, to] = [to, from];
        if ((to - from) / DAY > 36_600) throw new Error('日期跨度太大');
        let n = 0;
        for (let d = new Date(from); d <= to; d = new Date(d.getTime() + DAY)) if (!isRest(d, restDays)) n += 1;
        return n;
    },
    add_workdays: (d, n, rest) => {
        const restDays = restOf(rest);
        if (restDays.length >= 7) throw new Error('不能每天都是休息日');
        let left = Math.abs(Math.trunc(num(n)));
        if (left > 36_600) throw new Error('天数太大');
        const step = num(n) < 0 ? -DAY : DAY;
        let cur = toDate(d);
        while (left > 0) { cur = new Date(cur.getTime() + step); if (!isRest(cur, restDays)) left -= 1; }
        return fmtDate(cur);
    },
};

export function evaluate(expression) {
    const src = String(expression || '').trim();
    if (!src) throw new Error('表达式为空');
    if (src.length > 2000) throw new Error('表达式太长');
    const tokens = tokenize(src);
    let i = 0;
    const peek = () => tokens[i];
    const take = (v) => { if (peek()?.t === 'op' && peek().v === v) { i += 1; return true; } return false; };

    function primary() {
        const tok = tokens[i++];
        if (!tok) throw new Error('表达式不完整');
        if (tok.t === 'num' || tok.t === 'str') return tok.v;
        if (tok.t === 'id') {
            // 只认自己定义的函数：constructor、toString 这类原型链上的名字一律不算
            const fn = Object.hasOwn(FUNCS, tok.v) ? FUNCS[tok.v] : null;
            if (!fn) throw new Error(`不支持的函数：${tok.v}`);
            if (!take('(')) throw new Error(`${tok.v} 后面需要括号`);
            const args = [];
            if (!take(')')) {
                do { args.push(expr()); } while (take(','));
                if (!take(')')) throw new Error('括号没有闭合');
            }
            return fn(...args);
        }
        if (tok.v === '(') { const v = expr(); if (!take(')')) throw new Error('括号没有闭合'); return v; }
        if (tok.v === '-') return -num(unary());
        if (tok.v === '+') return num(unary());
        throw new Error(`这里不能出现 ${tok.v}`);
    }
    function unary() { return primary(); }
    function power() { const base = unary(); return take('^') ? num(base) ** num(power()) : base; }
    function term() {
        let v = power();
        for (;;) {
            if (take('*')) v = num(v) * num(power());
            else if (take('/')) { const d = num(power()); if (d === 0) throw new Error('除数为 0'); v = num(v) / d; }
            else if (take('%')) { const d = num(power()); if (d === 0) throw new Error('除数为 0'); v = num(v) % d; }
            else return v;
        }
    }
    function expr() {
        let v = term();
        for (;;) {
            if (take('+')) v = num(v) + num(term());
            else if (take('-')) v = num(v) - num(term());
            else return v;
        }
    }
    const value = expr();
    if (i < tokens.length) throw new Error('表达式多出了内容');
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('结果不是有限数字');
        return Number(value.toPrecision(15)); // 抹掉 0.1+0.2 这类二进制浮点尾巴
    }
    return value;
}
