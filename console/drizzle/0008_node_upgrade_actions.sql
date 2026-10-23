CREATE TABLE `node_actions` (
  `id` text PRIMARY KEY NOT NULL,
  `node` text NOT NULL,
  `action` text NOT NULL,
  `installer` text NOT NULL,
  `status` text NOT NULL DEFAULT 'queued',
  `bytes` integer NOT NULL DEFAULT 0,
  `detail` text,
  `reported_version` text,
  `package_sha256` text,
  `ack_hash` text,
  `creator` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `node_actions_node_created` ON `node_actions` (`node`, `created_at`);
--> statement-breakpoint
CREATE INDEX `node_actions_node_status` ON `node_actions` (`node`, `status`);
