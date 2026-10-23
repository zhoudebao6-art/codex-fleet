CREATE TABLE `artifact_refs` (
	`task` text NOT NULL,
	`sha` text NOT NULL,
	`name` text NOT NULL,
	`direction` text DEFAULT 'output' NOT NULL,
	PRIMARY KEY(`task`, `sha`, `name`, `direction`)
);
--> statement-breakpoint
CREATE TABLE `device_sessions` (
	`hash` text PRIMARY KEY NOT NULL,
	`node` text NOT NULL,
	`expires` text NOT NULL,
	`created` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `device_sessions_node` ON `device_sessions` (`node`);--> statement-breakpoint
CREATE TABLE `device_tickets` (
	`hash` text PRIMARY KEY NOT NULL,
	`node` text NOT NULL,
	`expires` text NOT NULL,
	`consumed_session` text
);
--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`node` text NOT NULL,
	`task` text,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_id` ON `events` (`id`);--> statement-breakpoint
CREATE INDEX `events_task_seq` ON `events` (`task`,`seq`);--> statement-breakpoint
CREATE TABLE `file_chunks` (
	`project` text NOT NULL,
	`sha` text NOT NULL,
	`offset` integer NOT NULL,
	`size` integer NOT NULL,
	`key` text NOT NULL,
	`digest` text NOT NULL,
	PRIMARY KEY(`project`, `sha`, `offset`)
);
--> statement-breakpoint
CREATE TABLE `files` (
	`id` text NOT NULL,
	`project` text NOT NULL,
	`sha` text NOT NULL,
	`size` integer NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`offset` integer DEFAULT 0 NOT NULL,
	`owner` text NOT NULL,
	`created` text NOT NULL,
	`updated` text NOT NULL,
	PRIMARY KEY(`project`, `sha`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_id` ON `files` (`id`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`name` text NOT NULL,
	`projects` text NOT NULL,
	`account_group` text NOT NULL,
	`expires` text NOT NULL,
	`used_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token` ON `invites` (`token_hash`);--> statement-breakpoint
CREATE TABLE `knowledge` (
	`project` text NOT NULL,
	`key` text NOT NULL,
	`version` integer NOT NULL,
	`body` text NOT NULL,
	`source_task` text NOT NULL,
	`author` text NOT NULL,
	`created` text NOT NULL,
	PRIMARY KEY(`project`, `key`, `version`)
);
--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`created` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_email` ON `members` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `members_user` ON `members` (`user_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`task` text NOT NULL,
	`sender` text NOT NULL,
	`text` text NOT NULL,
	`created` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_task` ON `messages` (`task`,`created`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`projects` text NOT NULL,
	`account_group` text NOT NULL,
	`max_running` integer DEFAULT 1 NOT NULL,
	`last_seen` text,
	`capabilities` text DEFAULT '{}' NOT NULL,
	`revoked` integer DEFAULT 0 NOT NULL,
	`fingerprint` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_name` ON `nodes` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_token` ON `nodes` (`token_hash`);--> statement-breakpoint
CREATE TABLE `receipts` (
	`node` text NOT NULL,
	`id` text NOT NULL,
	`body_hash` text NOT NULL,
	PRIMARY KEY(`node`, `id`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`creator` text NOT NULL,
	`target` text NOT NULL,
	`project` text NOT NULL,
	`status` text NOT NULL,
	`spec` text NOT NULL,
	`spec_hash` text NOT NULL,
	`attempt` text,
	`created` text NOT NULL,
	`updated` text NOT NULL,
	`result` text,
	`thread_id` text
);
--> statement-breakpoint
CREATE INDEX `tasks_target_status` ON `tasks` (`target`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_project_created` ON `tasks` (`project`,`created`);