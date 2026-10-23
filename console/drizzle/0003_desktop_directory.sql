CREATE TABLE `desktop_threads` (
  `node` text NOT NULL,
  `thread_id` text NOT NULL,
  `project` text NOT NULL,
  `title` text NOT NULL,
  `preview` text NOT NULL DEFAULT '',
  `cwd` text NOT NULL DEFAULT '',
  `archived` integer NOT NULL DEFAULT 0,
  `source` text NOT NULL DEFAULT 'unknown',
  `created_at` text,
  `updated_at` text NOT NULL,
  `observed_at` text NOT NULL,
  `status` text NOT NULL DEFAULT 'unknown',
  `status_source` text NOT NULL DEFAULT 'stored_metadata',
  `last_activity_at` text,
  `active_flags` text NOT NULL DEFAULT '[]',
  `parent_thread_id` text,
  `fleet_task_id` text,
  `details` text NOT NULL DEFAULT '{}',
  `detail_updated_at` text,
  `detail_received_at` text,
  `received_at` text NOT NULL,
  `pinned` integer NOT NULL DEFAULT 0,
  `pinned_by` text,
  `pinned_at` text,
  PRIMARY KEY (`node`, `thread_id`)
);
--> statement-breakpoint
CREATE INDEX `desktop_threads_project_order` ON `desktop_threads` (`project`, `pinned`, `updated_at`, `node`, `thread_id`);
--> statement-breakpoint
CREATE INDEX `desktop_threads_node_order` ON `desktop_threads` (`node`, `pinned`, `updated_at`, `thread_id`);
--> statement-breakpoint
CREATE TABLE `desktop_inventories` (
  `node` text PRIMARY KEY NOT NULL,
  `scanned_at` text NOT NULL,
  `received_at` text NOT NULL,
  `complete` integer NOT NULL DEFAULT 0,
  `count` integer NOT NULL DEFAULT 0,
  `error` text,
  `detail_errors` text NOT NULL DEFAULT '[]'
);
--> statement-breakpoint
CREATE TABLE `desktop_read_requests` (
  `node` text NOT NULL,
  `thread_id` text NOT NULL,
  `created` text NOT NULL,
  PRIMARY KEY (`node`, `thread_id`)
);
