CREATE TABLE `local_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_salt` text NOT NULL,
	`password_hash` text NOT NULL,
	`member_id` text NOT NULL,
	`iterations` integer DEFAULT 100000 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_accounts_username` ON `local_accounts` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `local_accounts_member` ON `local_accounts` (`member_id`);--> statement-breakpoint
CREATE TABLE `login_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`window_start` integer NOT NULL,
	`blocked_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `login_sessions` (
	`hash` text PRIMARY KEY NOT NULL,
	`account` text NOT NULL,
	`expires` text NOT NULL,
	`created` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_sessions_account` ON `login_sessions` (`account`);