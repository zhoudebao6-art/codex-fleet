CREATE TABLE `automation_flows` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `creator` text NOT NULL,
  `creator_kind` text NOT NULL,
  `project` text NOT NULL,
  `declaration` text NOT NULL,
  `declaration_hash` text NOT NULL,
  `status` text NOT NULL DEFAULT 'running',
  `current_step` integer NOT NULL DEFAULT 0,
  `error` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `last_checked_at` text NOT NULL,
  `completed_at` text
);
--> statement-breakpoint
CREATE INDEX `automation_flows_project_created` ON `automation_flows` (`project`, `created_at`);
--> statement-breakpoint
CREATE INDEX `automation_flows_status_checked` ON `automation_flows` (`status`, `last_checked_at`);
--> statement-breakpoint
CREATE TABLE `automation_steps` (
  `flow` text NOT NULL,
  `step_index` integer NOT NULL,
  `step_key` text NOT NULL,
  `task_id` text NOT NULL,
  `prepared_spec` text,
  `prepared_hash` text,
  `prepared_at` text,
  PRIMARY KEY (`flow`, `step_index`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_steps_task` ON `automation_steps` (`task_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_steps_key` ON `automation_steps` (`flow`, `step_key`);
