CREATE TABLE delivery_relays (
 task_id TEXT PRIMARY KEY NOT NULL,
 batch_id TEXT NOT NULL,
 source_id TEXT NOT NULL UNIQUE,
 node TEXT NOT NULL,
 thread_id TEXT NOT NULL,
 created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX delivery_relays_batch ON delivery_relays(batch_id);
