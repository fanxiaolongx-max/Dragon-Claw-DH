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
