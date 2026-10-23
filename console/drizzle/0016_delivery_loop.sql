ALTER TABLE delivery_batches ADD COLUMN loop_policy TEXT NOT NULL DEFAULT '{}';
--> statement-breakpoint
CREATE TABLE delivery_recovery (
 id TEXT PRIMARY KEY NOT NULL,
 batch_id TEXT NOT NULL,
 job_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'diagnosing',
 detail TEXT NOT NULL,
 task_id TEXT,
 response TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(batch_id,job_id,kind)
);
--> statement-breakpoint
CREATE INDEX delivery_recovery_batch ON delivery_recovery(batch_id,state);
