-- Final structural invariant: exactly one reminder trigger form is populated.
ALTER TABLE reminder_rules
  ADD CONSTRAINT reminder_rules_trigger_shape_chk CHECK (
    (trigger_kind = 'exact'
      AND exact_at IS NOT NULL
      AND anchor IS NULL
      AND offset_seconds IS NULL
      AND days_offset IS NULL
      AND local_time IS NULL)
    OR
    (trigger_kind = 'relative_timestamp'
      AND exact_at IS NULL
      AND anchor IS NOT NULL
      AND offset_seconds IS NOT NULL
      AND days_offset IS NULL
      AND local_time IS NULL)
    OR
    (trigger_kind = 'local_date'
      AND exact_at IS NULL
      AND anchor IS NOT NULL
      AND offset_seconds IS NULL
      AND days_offset IS NOT NULL
      AND local_time IS NOT NULL)
  );

-- Goals created by an action group must stay inside the same workspace.
ALTER TABLE goals
  ADD CONSTRAINT goals_source_action_group_workspace_fk
  FOREIGN KEY (workspace_id, source_action_group_id)
  REFERENCES action_groups(workspace_id, id);

CREATE INDEX goals_source_action_group_idx
  ON goals(workspace_id, source_action_group_id);
