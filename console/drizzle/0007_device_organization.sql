CREATE TABLE `device_groups` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `sort_order` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_groups_name` ON `device_groups` (`name`);
--> statement-breakpoint
ALTER TABLE `nodes` ADD `display_name` text;
--> statement-breakpoint
ALTER TABLE `nodes` ADD `display_group_id` text;
--> statement-breakpoint
CREATE INDEX `nodes_display_group` ON `nodes` (`display_group_id`);
--> statement-breakpoint
ALTER TABLE `invites` ADD `display_group_id` text;
--> statement-breakpoint
ALTER TABLE `invites` ADD `display_name` text;
