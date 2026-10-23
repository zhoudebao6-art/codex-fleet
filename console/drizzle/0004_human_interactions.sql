CREATE TABLE `task_interactions` (
  `id` text PRIMARY KEY NOT NULL,
  `task` text NOT NULL,
  `node` text NOT NULL,
  `attempt` text NOT NULL,
  `kind` text NOT NULL,
  `method` text NOT NULL,
  `request` text NOT NULL,
  `request_hash` text NOT NULL,
  `status` text NOT NULL DEFAULT 'pending',
  `expires_at` text NOT NULL,
  `created_at` text NOT NULL,
  `response` text,
  `response_hash` text,
  `answered_by` text,
  `answered_at` text,
  `resolved_at` text
);
--> statement-breakpoint
CREATE INDEX `task_interactions_task_created` ON `task_interactions` (`task`, `created_at`);
--> statement-breakpoint
CREATE TABLE `node_maintenance` (
  `node` text PRIMARY KEY NOT NULL,
  `expires_at` text NOT NULL,
  `reason` text NOT NULL,
  `updated_at` text NOT NULL
);
