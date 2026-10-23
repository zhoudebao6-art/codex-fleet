CREATE TABLE skill_phase_retries (original_id TEXT NOT NULL,retry_id TEXT NOT NULL UNIQUE,retry_no INTEGER NOT NULL,spec TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(original_id,retry_no));
