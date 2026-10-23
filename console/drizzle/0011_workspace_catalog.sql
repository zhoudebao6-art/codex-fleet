ALTER TABLE project_workspaces ADD COLUMN source_project_id text;
--> statement-breakpoint
ALTER TABLE project_workspaces ADD COLUMN auto_imported integer NOT NULL DEFAULT 0;
