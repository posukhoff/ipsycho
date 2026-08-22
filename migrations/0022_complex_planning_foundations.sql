ALTER TABLE tasks
  ADD COLUMN recurrence_end_local_date date;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_recurrence_end_requires_rule_chk
  CHECK (recurrence_end_local_date IS NULL OR recurrence_rule IS NOT NULL);

CREATE TABLE task_recurrence_exclusions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  local_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, task_id, local_date),
  FOREIGN KEY (workspace_id, task_id)
    REFERENCES tasks(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX task_recurrence_exclusions_task_idx
  ON task_recurrence_exclusions(workspace_id, task_id, local_date);

ALTER TABLE conversation_topics
  ADD COLUMN review_state jsonb;
