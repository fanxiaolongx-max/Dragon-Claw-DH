-- Dragon Claw 数字人平台版 MySQL 8.0 初始化建表脚本
-- 新平台从空表开始，严禁运行期 DDL；所有建表集中在此文件。

CREATE TABLE IF NOT EXISTS `sys_kv_store` (
  `kv_key` VARCHAR(191) NOT NULL,
  `kv_value` LONGTEXT,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`kv_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `debug_audit_test` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` VARCHAR(128) NOT NULL DEFAULT '',
  `msg` VARCHAR(512) NOT NULL DEFAULT '',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_metrics_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_type` VARCHAR(64) NOT NULL,
  `tool_id` VARCHAR(128) NOT NULL DEFAULT '',
  `user_id` VARCHAR(128) NOT NULL DEFAULT '',
  `meta_json` LONGTEXT,
  `created_at` BIGINT NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_pme_type_time` (`event_type`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dh_blob_assets` (
  `asset_key` VARCHAR(191) NOT NULL,
  `category` VARCHAR(64) NOT NULL DEFAULT 'general',
  `filename` VARCHAR(255) NOT NULL DEFAULT '',
  `mime_type` VARCHAR(128) NOT NULL DEFAULT 'application/octet-stream',
  `size_bytes` BIGINT NOT NULL DEFAULT 0,
  `data_base64` LONGTEXT,
  `meta_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`asset_key`),
  KEY `idx_blob_category` (`category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- AI 对话与模型配置
-- ============================================================

CREATE TABLE IF NOT EXISTS `ai_chat_sessions` (
  `id` VARCHAR(128) NOT NULL,
  `owner_id` VARCHAR(128) NOT NULL DEFAULT 'default',
  `title` VARCHAR(512) NOT NULL DEFAULT '新对话',
  `archived` TINYINT NOT NULL DEFAULT 0,
  `pinned` TINYINT NOT NULL DEFAULT 0,
  `summary` LONGTEXT,
  `metadata_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_ai_sessions_owner` (`owner_id`, `archived`, `updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `ai_chat_messages` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `session_id` VARCHAR(128) NOT NULL,
  `role` VARCHAR(32) NOT NULL,
  `content` LONGTEXT,
  `meta_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_ai_msgs_session` (`session_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `ai_settings_profiles` (
  `id` VARCHAR(128) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `provider` VARCHAR(64) NOT NULL DEFAULT 'openai',
  `is_active` TINYINT NOT NULL DEFAULT 0,
  `config_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- UIVF12 数据抓取与自动导入
-- ============================================================

CREATE TABLE IF NOT EXISTS `uiv_categories` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `description` VARCHAR(512) NOT NULL DEFAULT '',
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_uiv_cat_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `uiv_scripts` (
  `id` VARCHAR(128) NOT NULL,
  `seq` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  `url` TEXT,
  `category` VARCHAR(191) NOT NULL DEFAULT '默认分类',
  `payload_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_uiv_scripts_seq` (`seq`),
  KEY `idx_uiv_scripts_cat` (`category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dh_uiv_import_sessions` (
  `session_id` VARCHAR(128) NOT NULL,
  `target` VARCHAR(64) NOT NULL DEFAULT 'sla',
  `source_label` VARCHAR(255) NOT NULL DEFAULT '',
  `payload_json` LONGTEXT,
  `expires_at` BIGINT NOT NULL DEFAULT 0,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`session_id`),
  KEY `idx_uiv_import_exp` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- SLA 配置与数据导入源
-- ============================================================

CREATE TABLE IF NOT EXISTS `sla_config_items` (
  `item_key` VARCHAR(191) NOT NULL,
  `scope_key` VARCHAR(128) NOT NULL DEFAULT 'default',
  `value_json` LONGTEXT,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`item_key`, `scope_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sla_categories` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `meta_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sla_cat_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sla_groups` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `group_key` VARCHAR(191) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `category` VARCHAR(191) NOT NULL DEFAULT '',
  `sort_order` INT NOT NULL DEFAULT 0,
  `meta_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sla_group_key` (`group_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sla_group_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `group_key` VARCHAR(191) NOT NULL,
  `target_key` VARCHAR(191) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `meta_json` LONGTEXT,
  PRIMARY KEY (`id`),
  KEY `idx_sgi_group` (`group_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sla_targets` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `target_key` VARCHAR(191) NOT NULL,
  `name` VARCHAR(255) NOT NULL DEFAULT '',
  `category` VARCHAR(191) NOT NULL DEFAULT '',
  `payload_json` LONGTEXT,
  `sort_order` INT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sla_target_key` (`target_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sla_snapshots` (
  `id` VARCHAR(128) NOT NULL,
  `seq` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `category` VARCHAR(191) NOT NULL DEFAULT '',
  `name` VARCHAR(255) NOT NULL DEFAULT '',
  `snapshot_time` VARCHAR(64) NOT NULL DEFAULT '',
  `payload_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sla_snap_seq` (`seq`),
  KEY `idx_sla_snap_time` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `upload_history` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `entry_key` VARCHAR(128) NOT NULL,
  `file_name` VARCHAR(255) NOT NULL DEFAULT '',
  `payload_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_upload_entry_key` (`entry_key`),
  KEY `idx_upload_hist_time` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `import_source_batches` (
  `id` VARCHAR(128) NOT NULL,
  `seq` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL DEFAULT '',
  `category` VARCHAR(191) NOT NULL DEFAULT '',
  `status` VARCHAR(64) NOT NULL DEFAULT 'ready',
  `meta_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_isb_seq` (`seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `import_source_files` (
  `id` VARCHAR(128) NOT NULL,
  `batch_id` VARCHAR(128) NOT NULL,
  `filename` VARCHAR(255) NOT NULL DEFAULT '',
  `category` VARCHAR(191) NOT NULL DEFAULT '',
  `size_bytes` BIGINT NOT NULL DEFAULT 0,
  `sha256` VARCHAR(128) NOT NULL DEFAULT '',
  `file_base64` LONGTEXT,
  `meta_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_isf_batch` (`batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `import_source_sheets` (
  `id` VARCHAR(128) NOT NULL,
  `file_id` VARCHAR(128) NOT NULL,
  `batch_id` VARCHAR(128) NOT NULL,
  `sheet_name` VARCHAR(255) NOT NULL DEFAULT '',
  `headers_json` LONGTEXT,
  `rows_json` LONGTEXT,
  `row_count` INT NOT NULL DEFAULT 0,
  `meta_json` LONGTEXT,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_iss_file` (`file_id`),
  KEY `idx_iss_batch` (`batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `import_source_presets` (
  `id` VARCHAR(128) NOT NULL,
  `preset_type` VARCHAR(64) NOT NULL,
  `name` VARCHAR(255) NOT NULL DEFAULT '',
  `payload_json` LONGTEXT,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_isp_type` (`preset_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `monthly_logos` (
  `id` VARCHAR(128) NOT NULL,
  `filename` VARCHAR(255) NOT NULL DEFAULT '',
  `mime_type` VARCHAR(128) NOT NULL DEFAULT 'image/png',
  `image_base64` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `monthly_documents` (
  `id` VARCHAR(128) NOT NULL,
  `title` VARCHAR(255) NOT NULL DEFAULT '',
  `report_month` VARCHAR(32) NOT NULL DEFAULT '',
  `payload_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `monthly_drafts` (
  `id` VARCHAR(128) NOT NULL,
  `owner_id` VARCHAR(128) NOT NULL DEFAULT 'default',
  `title` VARCHAR(255) NOT NULL DEFAULT '',
  `archived` TINYINT NOT NULL DEFAULT 0,
  `payload_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_md_owner` (`owner_id`, `archived`, `updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 报表看板 / 催办 / 大屏
-- ============================================================

CREATE TABLE IF NOT EXISTS `report_snapshots` (
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
  KEY `idx_rs_snap_month` (`snapshot_id`, `month`),
  KEY `idx_rs_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `report_category_scores` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `snapshot_id` VARCHAR(128) NOT NULL,
  `month` INT NULL,
  `cat_name` VARCHAR(191) NOT NULL DEFAULT '',
  `base_score` DOUBLE NULL,
  `manual_score` DOUBLE NULL,
  `final_score` DOUBLE NULL,
  PRIMARY KEY (`id`),
  KEY `idx_rcs_snap` (`snapshot_id`, `month`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `report_metric_data` (
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
  KEY `idx_rmd_snap` (`snapshot_id`, `month`),
  KEY `idx_rmd_metric` (`metric_label`(128))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `bigscreen_owners` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `owner_key` VARCHAR(255) NOT NULL,
  `cat_name` VARCHAR(191) NOT NULL DEFAULT '',
  `metric_label` VARCHAR(191) NOT NULL DEFAULT '',
  `owner_name` VARCHAR(191) NOT NULL DEFAULT '',
  `emp_id` VARCHAR(128) NOT NULL DEFAULT '',
  `avatar` VARCHAR(512) NOT NULL DEFAULT '',
  `updated_at` VARCHAR(32) NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_bo_owner_key` (`owner_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 月报快照 & AI 月报编辑器 (ai-report.html)
-- ============================================================

CREATE TABLE IF NOT EXISTS `monthly_snapshots` (
  `id` VARCHAR(128) NOT NULL,
  `report_month` VARCHAR(32) NOT NULL DEFAULT '',
  `title` VARCHAR(255) NOT NULL DEFAULT '',
  `payload_json` LONGTEXT,
  `updated_by` VARCHAR(128) NOT NULL DEFAULT '',
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_ms_month` (`report_month`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `ai_report_documents` (
  `id` VARCHAR(128) NOT NULL,
  `report_month` VARCHAR(32) NOT NULL DEFAULT '',
  `name` VARCHAR(255) NOT NULL DEFAULT '',
  `updated_by` VARCHAR(128) NOT NULL DEFAULT '',
  `payload_json` LONGTEXT,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `updated_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_ard_updated` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `ai_report_images` (
  `id` VARCHAR(128) NOT NULL,
  `filename` VARCHAR(255) NOT NULL DEFAULT '',
  `mime_type` VARCHAR(128) NOT NULL DEFAULT 'image/png',
  `size_bytes` BIGINT NOT NULL DEFAULT 0,
  `data_base64` LONGTEXT,
  `deleted_at` BIGINT NULL,
  `created_at` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `ai_report_image_deletions` (
  `id` VARCHAR(128) NOT NULL,
  `image_id` VARCHAR(128) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `reason` VARCHAR(512) NOT NULL DEFAULT '',
  `created_by` VARCHAR(128) NOT NULL DEFAULT '',
  `created_at` BIGINT NOT NULL DEFAULT 0,
  `resolved_at` BIGINT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_arid_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
