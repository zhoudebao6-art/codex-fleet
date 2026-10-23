ALTER TABLE `invites` ADD `created_at` text;
--> statement-breakpoint
ALTER TABLE `invites` ADD `used_at` text;
--> statement-breakpoint
ALTER TABLE `invites` ADD `revoked_at` text;
--> statement-breakpoint
ALTER TABLE `invites` ADD `console_role` text DEFAULT 'operator' NOT NULL;
--> statement-breakpoint
ALTER TABLE `invites` ADD `console_access` text DEFAULT '{"mode":"groups","groupIds":[]}' NOT NULL;
--> statement-breakpoint
CREATE INDEX `invites_created` ON `invites` (`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `invites_name` ON `invites` (`name`);
