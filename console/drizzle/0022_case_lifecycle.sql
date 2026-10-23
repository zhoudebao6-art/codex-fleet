CREATE TABLE case_flow_registry (
 id TEXT NOT NULL, version INTEGER NOT NULL, declaration TEXT NOT NULL,
 declaration_hash TEXT NOT NULL, creator TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(id,version)
);
CREATE TABLE case_dossiers (
 id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, project TEXT NOT NULL,
 creator TEXT NOT NULL, creator_kind TEXT NOT NULL, controller TEXT,
 node_ids TEXT NOT NULL DEFAULT '[]', declaration TEXT NOT NULL, declaration_hash TEXT NOT NULL,
 flow_snapshot TEXT NOT NULL, current_revision INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX case_dossiers_project_created ON case_dossiers(project,created_at,id);
CREATE INDEX case_dossiers_status ON case_dossiers(status,updated_at);
CREATE TABLE case_revisions (
 case_id TEXT NOT NULL, id TEXT NOT NULL, number INTEGER NOT NULL,
 request TEXT NOT NULL, request_hash TEXT NOT NULL, actor TEXT NOT NULL,
 status TEXT NOT NULL, accepted_at TEXT NOT NULL, applied_at TEXT,
 version_id TEXT, PRIMARY KEY(case_id,id), UNIQUE(case_id,number)
);
CREATE TABLE case_versions (
 id TEXT PRIMARY KEY NOT NULL, case_id TEXT NOT NULL, number INTEGER NOT NULL,
 revision_number INTEGER NOT NULL, adapter TEXT NOT NULL, batch_id TEXT,
 source_version_id TEXT, source_snapshot TEXT NOT NULL DEFAULT '{}',
 request_hash TEXT NOT NULL, status TEXT NOT NULL, verification TEXT NOT NULL DEFAULT 'pending',
 files TEXT NOT NULL DEFAULT '[]', evidence TEXT, error TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(case_id,number), UNIQUE(case_id,revision_number), UNIQUE(batch_id)
);
CREATE TABLE case_jobs (
 version_id TEXT NOT NULL, phase TEXT NOT NULL, task_id TEXT NOT NULL,
 attempt INTEGER NOT NULL DEFAULT 0,
 node TEXT NOT NULL, spec TEXT NOT NULL, verified TEXT, created_at TEXT NOT NULL,
 PRIMARY KEY(version_id,phase,attempt), UNIQUE(task_id)
);
CREATE TABLE case_execution_locks (case_id TEXT PRIMARY KEY NOT NULL, token TEXT NOT NULL, expires_at TEXT NOT NULL);
