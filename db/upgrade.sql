-- 增量升级脚本：已经按旧版 init.sql 建过表的环境，执行本文件即可补齐新表（首次部署直接用 db/init.sql）。
-- 全部是 CREATE TABLE IF NOT EXISTS，可重复执行。

-- ===== 1.2.0：大字段分片 =====
CREATE TABLE IF NOT EXISTS `dh_chunks` (
  `ref` VARCHAR(64) NOT NULL,
  `idx` INT NOT NULL,
  `data` LONGTEXT NOT NULL,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`ref`, `idx`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===== 1.3.0：技能、自定义 HTML 工具、对话附件 =====
CREATE TABLE IF NOT EXISTS `agent_skills` (
  `id` VARCHAR(64) NOT NULL,
  `name` VARCHAR(191) NOT NULL DEFAULT '',
  `name_en` VARCHAR(191) NOT NULL DEFAULT '',
  `description` VARCHAR(1024) NOT NULL DEFAULT '',
  `description_en` VARCHAR(1024) NOT NULL DEFAULT '',
  `icon` VARCHAR(32) NOT NULL DEFAULT '',
  `body` LONGTEXT,
  `source` VARCHAR(32) NOT NULL DEFAULT 'chat',
  `created_by` VARCHAR(128) NOT NULL DEFAULT '',
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `custom_tools` (
  `slug` VARCHAR(64) NOT NULL,
  `owner_id` VARCHAR(128) NOT NULL DEFAULT '',
  `visibility` VARCHAR(16) NOT NULL DEFAULT 'private',
  `name` VARCHAR(191) NOT NULL DEFAULT '',
  `name_en` VARCHAR(191) NOT NULL DEFAULT '',
  `description` VARCHAR(1024) NOT NULL DEFAULT '',
  `description_en` VARCHAR(1024) NOT NULL DEFAULT '',
  `icon` VARCHAR(32) NOT NULL DEFAULT '',
  `tags_json` VARCHAR(1024) NOT NULL DEFAULT '[]',
  `html` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`slug`),
  KEY `idx_custom_tools_owner` (`owner_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `ai_chat_uploads` (
  `id` VARCHAR(64) NOT NULL,
  `owner_id` VARCHAR(128) NOT NULL DEFAULT '',
  `filename` VARCHAR(255) NOT NULL DEFAULT '',
  `mime_type` VARCHAR(128) NOT NULL DEFAULT '',
  `size_bytes` BIGINT NOT NULL DEFAULT 0,
  `text_content` LONGTEXT,
  `data_base64` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_ai_uploads_owner` (`owner_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===== 1.5.0：定时任务 =====
CREATE TABLE IF NOT EXISTS `agent_schedules` (
  `id` VARCHAR(64) NOT NULL,
  `owner_id` VARCHAR(128) NOT NULL,
  `instruction` TEXT,
  `kind` VARCHAR(16) NOT NULL DEFAULT 'once',
  `rule_json` VARCHAR(1024) NULL,
  `timezone` VARCHAR(64) NOT NULL DEFAULT '',
  `session_id` VARCHAR(128) NOT NULL DEFAULT '',
  `model_id` VARCHAR(128) NOT NULL DEFAULT '',
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `next_run_at` BIGINT NULL,
  `last_run_at` BIGINT NULL,
  `last_status` VARCHAR(16) NOT NULL DEFAULT '',
  `last_error` VARCHAR(512) NOT NULL DEFAULT '',
  `last_reply` TEXT,
  `run_count` INT NOT NULL DEFAULT 0,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_sched_due` (`status`, `next_run_at`),
  KEY `idx_sched_owner` (`owner_id`, `updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- ===== 1.6.0：没有新增表（消息中心、用量趋势、工具开关、技能历史都存 sys_kv_store，自定义 Logo 存 dh_blob_assets）=====

-- ===== 1.7.0：业务页面的统一记录表（专题分析、值班表、FRT 核算、PR 稽查共用）=====
CREATE TABLE IF NOT EXISTS `biz_records` (
  `kind` VARCHAR(32) NOT NULL,
  `id` VARCHAR(96) NOT NULL,
  `group_key` VARCHAR(64) NOT NULL DEFAULT '',
  `name` VARCHAR(255) NOT NULL DEFAULT '',
  `period` VARCHAR(32) NOT NULL DEFAULT '',
  `sort_key` VARCHAR(64) NOT NULL DEFAULT '',
  `content_hash` VARCHAR(64) NOT NULL DEFAULT '',
  `summary_json` LONGTEXT,
  `payload_json` LONGTEXT,
  `payload_bytes` BIGINT NOT NULL DEFAULT 0,
  `updated_by` VARCHAR(128) NOT NULL DEFAULT '',
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`kind`, `id`),
  KEY `idx_biz_sort` (`kind`, `group_key`, `sort_key`),
  KEY `idx_biz_hash` (`kind`, `group_key`, `content_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===== 团队版表（scripts/gen-team-tables.mjs 生成，勿手改）=====
-- ===== 1.9.0：账号绑定团队 =====

-- 非默认团队的工具页面数据存这里（默认团队继续用原表）；结构与原表相同，多一列 team_id。

CREATE TABLE IF NOT EXISTS `team_uiv_categories` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `description` VARCHAR(512) NOT NULL DEFAULT '',
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_uiv_cat_name` (`team_id`, `name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_uiv_scripts` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` VARCHAR(128) NOT NULL,
  `seq` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  `url` TEXT,
  `category` VARCHAR(191) NOT NULL DEFAULT '默认分类',
  `payload_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`team_id`, `id`),
  UNIQUE KEY `uk_uiv_scripts_seq` (`seq`),
  KEY `idx_uiv_scripts_cat` (`team_id`, `category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_dh_uiv_import_sessions` (
  `team_id` VARCHAR(64) NOT NULL,
  `session_id` VARCHAR(128) NOT NULL,
  `target` VARCHAR(64) NOT NULL DEFAULT 'sla',
  `source_label` VARCHAR(255) NOT NULL DEFAULT '',
  `payload_json` LONGTEXT,
  `expires_at` BIGINT NOT NULL DEFAULT 0,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`team_id`, `session_id`),
  KEY `idx_uiv_import_exp` (`team_id`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_sla_config_items` (
  `team_id` VARCHAR(64) NOT NULL,
  `item_key` VARCHAR(191) NOT NULL,
  `scope_key` VARCHAR(128) NOT NULL DEFAULT 'default',
  `value_json` LONGTEXT,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`team_id`, `item_key`, `scope_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_sla_categories` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `meta_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sla_cat_name` (`team_id`, `name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_sla_groups` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `group_key` VARCHAR(191) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `category` VARCHAR(191) NOT NULL DEFAULT '',
  `sort_order` INT NOT NULL DEFAULT 0,
  `meta_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sla_group_key` (`team_id`, `group_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_sla_group_items` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `group_key` VARCHAR(191) NOT NULL,
  `target_key` VARCHAR(191) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `meta_json` LONGTEXT,
  PRIMARY KEY (`id`),
  KEY `idx_sgi_group` (`team_id`, `group_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_sla_targets` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `target_key` VARCHAR(191) NOT NULL,
  `name` VARCHAR(255) NOT NULL DEFAULT '',
  `category` VARCHAR(191) NOT NULL DEFAULT '',
  `payload_json` LONGTEXT,
  `sort_order` INT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sla_target_key` (`team_id`, `target_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_sla_snapshots` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` VARCHAR(128) NOT NULL,
  `seq` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `category` VARCHAR(191) NOT NULL DEFAULT '',
  `name` VARCHAR(255) NOT NULL DEFAULT '',
  `snapshot_time` VARCHAR(64) NOT NULL DEFAULT '',
  `payload_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`team_id`, `id`),
  UNIQUE KEY `uk_sla_snap_seq` (`seq`),
  KEY `idx_sla_snap_time` (`team_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_upload_history` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `entry_key` VARCHAR(128) NOT NULL,
  `file_name` VARCHAR(255) NOT NULL DEFAULT '',
  `payload_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_upload_entry_key` (`team_id`, `entry_key`),
  KEY `idx_upload_hist_time` (`team_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_import_source_batches` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` VARCHAR(128) NOT NULL,
  `seq` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL DEFAULT '',
  `category` VARCHAR(191) NOT NULL DEFAULT '',
  `status` VARCHAR(64) NOT NULL DEFAULT 'ready',
  `meta_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`team_id`, `id`),
  UNIQUE KEY `uk_isb_seq` (`seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_import_source_files` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` VARCHAR(128) NOT NULL,
  `batch_id` VARCHAR(128) NOT NULL,
  `filename` VARCHAR(255) NOT NULL DEFAULT '',
  `category` VARCHAR(191) NOT NULL DEFAULT '',
  `size_bytes` BIGINT NOT NULL DEFAULT 0,
  `sha256` VARCHAR(128) NOT NULL DEFAULT '',
  `file_base64` LONGTEXT,
  `meta_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`team_id`, `id`),
  KEY `idx_isf_batch` (`team_id`, `batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_import_source_sheets` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` VARCHAR(128) NOT NULL,
  `file_id` VARCHAR(128) NOT NULL,
  `batch_id` VARCHAR(128) NOT NULL,
  `sheet_name` VARCHAR(255) NOT NULL DEFAULT '',
  `headers_json` LONGTEXT,
  `rows_json` LONGTEXT,
  `row_count` INT NOT NULL DEFAULT 0,
  `meta_json` LONGTEXT,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`team_id`, `id`),
  KEY `idx_iss_file` (`team_id`, `file_id`),
  KEY `idx_iss_batch` (`team_id`, `batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_import_source_presets` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` VARCHAR(128) NOT NULL,
  `preset_type` VARCHAR(64) NOT NULL,
  `name` VARCHAR(255) NOT NULL DEFAULT '',
  `payload_json` LONGTEXT,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`team_id`, `id`),
  KEY `idx_isp_type` (`team_id`, `preset_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_report_snapshots` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `snapshot_id` VARCHAR(128) NOT NULL,
  `month` INT NULL,
  `created_at` VARCHAR(32) NOT NULL DEFAULT '',
  `stored_at` BIGINT NOT NULL DEFAULT 0,
  `standard_total_score` DOUBLE NULL,
  `raw_data_json` LONGTEXT,
  `image_path` VARCHAR(255) NULL,
  `excel_path` VARCHAR(255) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_rs_snap_month` (`team_id`, `snapshot_id`, `month`),
  KEY `idx_rs_created` (`team_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_report_category_scores` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `snapshot_id` VARCHAR(128) NOT NULL,
  `month` INT NULL,
  `cat_name` VARCHAR(191) NOT NULL DEFAULT '',
  `base_score` DOUBLE NULL,
  `manual_score` DOUBLE NULL,
  `final_score` DOUBLE NULL,
  PRIMARY KEY (`id`),
  KEY `idx_rcs_snap` (`team_id`, `snapshot_id`, `month`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_report_metric_data` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `snapshot_id` VARCHAR(128) NOT NULL,
  `month` INT NULL,
  `cat_name` VARCHAR(191) NOT NULL DEFAULT '',
  `metric_label` VARCHAR(255) NOT NULL DEFAULT '',
  `weight` DOUBLE NULL,
  `target_val` VARCHAR(128) NULL,
  `raw_val` VARCHAR(255) NULL,
  `num_val` DOUBLE NULL,
  `is_failing` TINYINT NOT NULL DEFAULT 0,
  `gap` VARCHAR(128) NULL,
  `earned_score` DOUBLE NULL,
  `proportional_scoring` TINYINT NOT NULL DEFAULT 0,
  `completion_ratio` DOUBLE NULL,
  PRIMARY KEY (`id`),
  KEY `idx_rmd_snap` (`team_id`, `snapshot_id`, `month`),
  KEY `idx_rmd_metric` (`metric_label`(128))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_bigscreen_owners` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `owner_key` VARCHAR(255) NOT NULL,
  `cat_name` VARCHAR(191) NOT NULL DEFAULT '',
  `metric_label` VARCHAR(191) NOT NULL DEFAULT '',
  `owner_name` VARCHAR(191) NOT NULL DEFAULT '',
  `emp_id` VARCHAR(128) NOT NULL DEFAULT '',
  `avatar` VARCHAR(512) NOT NULL DEFAULT '',
  `updated_at` VARCHAR(32) NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_bo_owner_key` (`team_id`, `owner_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_monthly_logos` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` VARCHAR(128) NOT NULL,
  `filename` VARCHAR(255) NOT NULL DEFAULT '',
  `mime_type` VARCHAR(128) NOT NULL DEFAULT 'image/png',
  `image_base64` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`team_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_monthly_documents` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` VARCHAR(128) NOT NULL,
  `title` VARCHAR(255) NOT NULL DEFAULT '',
  `report_month` VARCHAR(32) NOT NULL DEFAULT '',
  `payload_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`team_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_monthly_drafts` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` VARCHAR(128) NOT NULL,
  `owner_id` VARCHAR(128) NOT NULL DEFAULT 'default',
  `title` VARCHAR(255) NOT NULL DEFAULT '',
  `archived` TINYINT NOT NULL DEFAULT 0,
  `payload_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`team_id`, `id`),
  KEY `idx_md_owner` (`team_id`, `owner_id`, `archived`, `updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_monthly_snapshots` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` VARCHAR(128) NOT NULL,
  `report_month` VARCHAR(32) NOT NULL DEFAULT '',
  `title` VARCHAR(255) NOT NULL DEFAULT '',
  `payload_json` LONGTEXT,
  `updated_by` VARCHAR(128) NOT NULL DEFAULT '',
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`team_id`, `id`),
  KEY `idx_ms_month` (`team_id`, `report_month`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_ai_report_documents` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` VARCHAR(128) NOT NULL,
  `report_month` VARCHAR(32) NOT NULL DEFAULT '',
  `name` VARCHAR(255) NOT NULL DEFAULT '',
  `updated_by` VARCHAR(128) NOT NULL DEFAULT '',
  `payload_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`team_id`, `id`),
  KEY `idx_ard_updated` (`team_id`, `updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_ai_report_images` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` VARCHAR(128) NOT NULL,
  `filename` VARCHAR(255) NOT NULL DEFAULT '',
  `mime_type` VARCHAR(128) NOT NULL DEFAULT 'image/png',
  `size_bytes` BIGINT NOT NULL DEFAULT 0,
  `data_base64` LONGTEXT,
  `deleted_at` BIGINT NULL,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`team_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_ai_report_image_deletions` (
  `team_id` VARCHAR(64) NOT NULL,
  `id` VARCHAR(128) NOT NULL,
  `image_id` VARCHAR(128) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `reason` VARCHAR(512) NOT NULL DEFAULT '',
  `created_by` VARCHAR(128) NOT NULL DEFAULT '',
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `resolved_at` BIGINT NULL,
  PRIMARY KEY (`team_id`, `id`),
  KEY `idx_arid_status` (`team_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_biz_records` (
  `team_id` VARCHAR(64) NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `id` VARCHAR(96) NOT NULL,
  `group_key` VARCHAR(64) NOT NULL DEFAULT '',
  `name` VARCHAR(255) NOT NULL DEFAULT '',
  `period` VARCHAR(32) NOT NULL DEFAULT '',
  `sort_key` VARCHAR(64) NOT NULL DEFAULT '',
  `content_hash` VARCHAR(64) NOT NULL DEFAULT '',
  `summary_json` LONGTEXT,
  `payload_json` LONGTEXT,
  `payload_bytes` BIGINT NOT NULL DEFAULT 0,
  `updated_by` VARCHAR(128) NOT NULL DEFAULT '',
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`team_id`, `kind`, `id`),
  KEY `idx_biz_sort` (`team_id`, `kind`, `group_key`, `sort_key`),
  KEY `idx_biz_hash` (`team_id`, `kind`, `group_key`, `content_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===== 团队版表结束 =====
