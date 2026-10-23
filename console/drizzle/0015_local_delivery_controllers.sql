ALTER TABLE delivery_batches ADD COLUMN routing TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
CREATE TABLE delivery_handoffs (
 id TEXT PRIMARY KEY NOT NULL,
 batch_id TEXT NOT NULL,
 node TEXT NOT NULL,
 thread_id TEXT NOT NULL,
 task_id TEXT NOT NULL UNIQUE,
 job_ids TEXT NOT NULL,
 prompt TEXT NOT NULL,
 error TEXT,
 parent_id TEXT,
 created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX delivery_handoffs_batch ON delivery_handoffs(batch_id,node);
