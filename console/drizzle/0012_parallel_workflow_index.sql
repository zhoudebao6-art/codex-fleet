CREATE INDEX IF NOT EXISTS tasks_workflow_identity ON tasks(creator,project,json_extract(spec,'$.workflowId'),created);
