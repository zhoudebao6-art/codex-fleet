ALTER TABLE members ADD COLUMN group_access TEXT NOT NULL DEFAULT '{"mode":"groups","groupIds":[]}';
--> statement-breakpoint
UPDATE members SET group_access='{"mode":"all","groupIds":[]}';
--> statement-breakpoint
ALTER TABLE nodes ADD COLUMN console_role TEXT NOT NULL DEFAULT 'operator';
--> statement-breakpoint
ALTER TABLE nodes ADD COLUMN console_access TEXT NOT NULL DEFAULT '{"mode":"groups","groupIds":[]}';
--> statement-breakpoint
UPDATE nodes SET console_access='{"mode":"all","groupIds":[]}';
--> statement-breakpoint
INSERT OR IGNORE INTO settings(key,value) SELECT 'bootstrap_initialized','true' WHERE EXISTS(SELECT 1 FROM local_accounts);
--> statement-breakpoint
CREATE TABLE file_group_grants (
  project TEXT NOT NULL,
  sha TEXT NOT NULL,
  group_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project,sha,group_id)
);
