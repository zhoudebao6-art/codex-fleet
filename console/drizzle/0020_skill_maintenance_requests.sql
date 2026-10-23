CREATE TABLE skill_maintenance_requests (
 id TEXT PRIMARY KEY NOT NULL, controller TEXT NOT NULL, project TEXT NOT NULL,
 creator TEXT NOT NULL, declaration TEXT NOT NULL, declaration_hash TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'submitted', task_id TEXT, attempt INTEGER NOT NULL DEFAULT 0,
 assessment TEXT, cycle_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX skill_maintenance_pending ON skill_maintenance_requests(controller,state,created_at);
