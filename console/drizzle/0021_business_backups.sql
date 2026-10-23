CREATE TABLE recovery_backups (id TEXT PRIMARY KEY NOT NULL,creator TEXT NOT NULL,created_at TEXT NOT NULL,schema_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'ready',verified_at TEXT);
--> statement-breakpoint
CREATE TABLE recovery_backup_rows (seq INTEGER PRIMARY KEY AUTOINCREMENT,backup_id TEXT NOT NULL,table_name TEXT NOT NULL,row_json TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX recovery_backup_rows_page ON recovery_backup_rows(backup_id,seq);
--> statement-breakpoint
CREATE INDEX recovery_backup_rows_table ON recovery_backup_rows(backup_id,table_name,seq);
