CREATE TABLE delivery_dispatch_fallbacks (
 job_id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE skill_cycles (
 id TEXT PRIMARY KEY NOT NULL, controller TEXT NOT NULL, project TEXT NOT NULL,
 declaration TEXT NOT NULL, declaration_hash TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'repair',
 attempt INTEGER NOT NULL DEFAULT 0, error TEXT, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE skill_cycle_steps (
 id TEXT PRIMARY KEY NOT NULL, cycle_id TEXT NOT NULL, phase TEXT NOT NULL,
 node TEXT NOT NULL, attempt INTEGER NOT NULL, spec TEXT NOT NULL, proof TEXT, created_at TEXT NOT NULL,
 UNIQUE(cycle_id,phase,attempt)
);
--> statement-breakpoint
CREATE TABLE skill_deployments (
 node TEXT NOT NULL, profile TEXT NOT NULL, commit_sha TEXT NOT NULL,
 cycle_id TEXT NOT NULL, directory TEXT NOT NULL, receipt_sha TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(node,profile,commit_sha)
);

--> statement-breakpoint
CREATE TABLE skill_recovery_links (cycle_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, issue_id TEXT NOT NULL UNIQUE, successor_id TEXT UNIQUE, created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX skill_cycles_one_active_profile ON skill_cycles(controller,json_extract(declaration,'$.profile')) WHERE state IN('repair','review','publish','canary','sync','paused');
