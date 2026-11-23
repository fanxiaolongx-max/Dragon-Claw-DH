// DataFab（Gauss）看板 SQL → MySQL 改写，以及「看板--指标」+ SQL 的批量拆分。
import test from 'node:test';
import assert from 'node:assert/strict';
import { datafabToMysql, splitBoardSql, looksLikeDataFab } from '../src/services/sql-dialect.js';

const squash = (s) => s.replace(/\s+/g, ' ').trim();

test('三段式表名、双引号别名、divide、FROM 后表名转小写', () => {
    const { sql, notes } = datafabToMysql(`select region "地区"
,sum(plan_qty) "计划数"
,1-divide(sum(open_qty),sum(plan_qty),0) "完成率"
from "dbx"."schema_a"."Demo_Tasks" where name is not null group by region`);
    assert.equal(squash(sql), squash("select region `地区` ,sum(plan_qty) `计划数` ,1-COALESCE((sum(open_qty)) / NULLIF((sum(plan_qty)), 0), 0) `完成率` from `Demo_Tasks` where name is not null group by region"));
    assert.ok(notes.some((n) => /库.*模式.*表/.test(n)));
    const lower = datafabToMysql('select a from Demo_Tasks t join Other_X o on t.id = o.id');
    assert.match(lower.sql, /from demo_tasks t join other_x o/);
});

test('同一个 SELECT 里引用前面的中文别名：展开成表达式；紧贴右括号的别名也认', () => {
    const { sql } = datafabToMysql(`select region
,sum(a+b) "应完成"
,count(distinct id)"任务数"
,sum(case when done>0 then a else 0 end) "已完成"
,divide(已完成,应完成,1) "完成率"
,divide(已完成,任务数,0) "人均"
from demo_tasks group by region`);
    assert.match(sql, /count\(distinct id\) AS `任务数`/);
    assert.match(squash(sql), /COALESCE\(\(\(sum\(case when done>0 then a else 0 end\)\)\) \/ NULLIF\(\(\(sum\(a\+b\)\)\), 0\), 1\) AS `完成率`/);
    assert.match(squash(sql), /NULLIF\(\(\(count\(distinct id\)\)\), 0\), 0\) AS `人均`/);
    assert.doesNotMatch(sql, /\(已完成\)|\(应完成\)/);
});

test('子查询补别名、NULLS LAST、date_trunc；字符串里的内容不动', () => {
    const { sql, notes } = datafabToMysql(`select * from (select pid, row_number() over(partition by pid order by t asc nulls last) rk from "a"."b"."demo_tasks" where note <> 'divide(x,y,0) "q"') where rk=1`);
    assert.match(sql, /order by t IS NULL, t asc\)/);
    assert.match(sql, /\) AS dv_sub1 where rk=1/);
    assert.match(sql, /'divide\(x,y,0\) "q"'/, '字符串字面量原样保留');
    assert.equal(notes.length, 3);
    assert.match(datafabToMysql("select sum(case when date_trunc('day',end_at)>date_trunc('day',current_timestamp) then 1 else 0 end) n from t").sql, /DATE\(end_at\)>DATE\(current_timestamp\)/);
    assert.match(datafabToMysql("select date_trunc('month', d) m from t").sql, /DATE_FORMAT\(d, '%Y-%m-01'\)/);
    assert.equal(looksLikeDataFab('select 1 from t'), false);
    assert.equal(looksLikeDataFab('select divide(1,2,0) from t'), true);
});

test('批量拆分：普通段落和 Excel 复制出来的双引号单元格都认', () => {
    const text = [
        '看板A--指标一',
        'select region "地区", count(*) "数" from demo_tasks group by region',
        '',
        '',
        '"看板A--指标二',
        'select ',
        'region as ""地区"",',
        'sum(x) as ""合计""',
        'from ""db"".""s"".""demo_tasks"" group by region"\t\t\t',
        '\t\t',
        '  看板B--明细',
        'select id from demo_tasks',
        '说明文字没有 SQL--也没有标题格式',
    ].join('\n');
    const blocks = splitBoardSql(text);
    assert.deepEqual(blocks.map((b) => [b.board, b.metric]), [['看板A', '指标一'], ['看板A', '指标二'], ['看板B', '明细']]);
    assert.match(blocks[1].sql, /region as "地区",/);
    assert.match(blocks[1].sql, /from "db"\."s"\."demo_tasks" group by region$/);
    assert.match(datafabToMysql(blocks[1].sql).sql, /from `demo_tasks` group by region/);
});
