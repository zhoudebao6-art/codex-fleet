CREATE TABLE `project_workspaces` (
  `id` text PRIMARY KEY NOT NULL,
  `node` text NOT NULL,
  `project` text NOT NULL,
  `name` text NOT NULL,
  `root` text,
  `root_key` text,
  `source` text NOT NULL,
  `source_thread_id` text,
  `controller_thread_id` text,
  `automation_note` text NOT NULL DEFAULT '',
  `status` text NOT NULL DEFAULT 'pending',
  `error` text,
  `creator` text NOT NULL,
  `create_hash` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `project_workspaces_node_status` ON `project_workspaces` (`node`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_workspaces_node_root` ON `project_workspaces` (`node`, `root_key`);
