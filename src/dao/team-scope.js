// 团队隔离的范围定义（数据访问层用）。
//
// 默认团队（团队标识为空）就是上线前的全部数据：继续读写原来的表和键，现有数据零迁移。
// 其他团队的工具页面数据写到「团队版表」team_<表名>（多一列 team_id，主键 / 唯一键都带上团队），
// 键值配置在键名前加 team:<团队>: 前缀。平台级的东西（管理员名单、页面开放、模型配置、对话、
// 消息中心、共享对话、保险箱、数据治理…）不分团队。
//
// 团队版表的建表语句由 scripts/gen-team-tables.mjs 按 init.sql 里的原表生成，写进 init.sql 和 upgrade.sql。

/** 工具页面数据所在的表：非默认团队改读写 team_<表名> */
export const TEAM_TABLES = Object.freeze([
    // 数据抓取
    'uiv_categories', 'uiv_scripts', 'dh_uiv_import_sessions',
    // 数据导入
    'sla_config_items', 'sla_categories', 'sla_groups', 'sla_group_items', 'sla_targets', 'sla_snapshots', 'upload_history',
    'import_source_batches', 'import_source_files', 'import_source_sheets', 'import_source_presets',
    // 报表看板、大屏、月报、AI 月报
    'report_snapshots', 'report_category_scores', 'report_metric_data', 'bigscreen_owners',
    'monthly_logos', 'monthly_documents', 'monthly_drafts', 'monthly_snapshots',
    'ai_report_documents', 'ai_report_images', 'ai_report_image_deletions',
    // 业务工具的统一记录表（只有下面 TEAM_BIZ_KINDS 里的种类按团队分）
    'biz_records',
]);

export const teamTableName = (table) => `team_${table}`;

/**
 * biz_records 里属于工具页面的记录种类（按团队隔离）；其余种类（共享对话、保险箱、审计、跟进提醒、
 * 需求广场、数据治理、NetCare 表标注…）是平台级或按人私有的，不分团队。
 */
export const TEAM_BIZ_KINDS = Object.freeze(new Set([
    'ai_bi_board', 'duty_roster', 'frt_snapshot', 'praudit_config', 'topic_snapshot',
    'meeting_attendance_snapshot', 'operation_incentive_snapshot',
    'survey_template', 'survey_submission', 'reward_rule', 'reward_application',
    'drp_item', 'drp_audit',
]));

/** 工具页面的键值配置：非默认团队加前缀 */
const TEAM_KV_EXACT = new Set([
    'expedite_notify_directory', 'sla_copied_fields', 'ai_report_default_id', 'yuxiang_template_mapping',
    'source_presentations_map', 'source_categories_map', 'ai_report_image_meta_map', 'ai_report_image_deletion_proposals',
    'sla_audit_log', 'monthly_default_template', 'sla_fast_mapping_templates', 'sla_metric_rule_changes',
    'import_settings', 'snapshot_rows_index', 'topic_customer_mapping', 'monthly_quick_metrics_map', 'uiv_batch_scope',
]);
const TEAM_KV_PREFIXES = ['snapshot_rows:', 'report_config:', 'department_reward_penalty:', 'meeting_attendance:'];

export function isTeamKvKey(key) {
    const k = String(key || '');
    return TEAM_KV_EXACT.has(k) || TEAM_KV_PREFIXES.some((p) => k.startsWith(p));
}

export const TEAM_KV_PREFIX = 'team:';
export const teamKvKey = (team, key) => `${TEAM_KV_PREFIX}${team}:${key}`;

/** 团队标识：小写字母、数字、- _，1~40 位；空字符串 = 默认团队 */
export const TEAM_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
