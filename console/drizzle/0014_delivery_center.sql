CREATE TABLE delivery_batches (
 id TEXT PRIMARY KEY NOT NULL,
 creator TEXT NOT NULL,
 creator_kind TEXT NOT NULL,
 controller TEXT NOT NULL,
 project TEXT NOT NULL,
 declaration TEXT NOT NULL,
 declaration_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'baseline',
 baseline TEXT,
 error TEXT,
 collected TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE delivery_jobs (
 id TEXT PRIMARY KEY NOT NULL,
 batch_id TEXT NOT NULL,
 phase TEXT NOT NULL,
 item_index INTEGER NOT NULL,
 node TEXT NOT NULL,
 attempt INTEGER NOT NULL DEFAULT 0,
 task_id TEXT NOT NULL UNIQUE,
 spec TEXT NOT NULL,
 verified TEXT,
 created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX delivery_batches_controller_status ON delivery_batches(controller,status,created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX delivery_jobs_attempt ON delivery_jobs(batch_id,phase,item_index,attempt);
