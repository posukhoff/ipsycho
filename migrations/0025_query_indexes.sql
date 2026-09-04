-- Indexes for the predicates the application actually runs. task_events and reminder_rules had
-- none beyond their primary keys, so every chat turn and every reminder rebuild scanned them.
-- Plain CREATE INDEX (not CONCURRENTLY) because the migration runner wraps each file in a
-- transaction; the tables of a private, allowlisted bot are small enough for the brief lock.

CREATE INDEX IF NOT EXISTS task_events_ws_occurrence_type_idx
  ON task_events(workspace_id, occurrence_id, event_type, created_at);
CREATE INDEX IF NOT EXISTS task_events_ws_task_created_idx
  ON task_events(workspace_id, task_id, created_at);
CREATE INDEX IF NOT EXISTS task_events_result_check_idx
  ON task_events(event_type, created_at) WHERE occurrence_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_events_details_purge_idx
  ON task_events(created_at) WHERE details IS NOT NULL;

CREATE INDEX IF NOT EXISTS reminder_rules_ws_task_idx
  ON reminder_rules(workspace_id, task_id) WHERE active;
CREATE INDEX IF NOT EXISTS reminder_rules_ws_occurrence_idx
  ON reminder_rules(workspace_id, occurrence_id) WHERE active;

CREATE INDEX IF NOT EXISTS reminder_deliveries_ws_occurrence_idx
  ON reminder_deliveries(workspace_id, occurrence_id) WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS reminder_deliveries_ws_rule_idx
  ON reminder_deliveries(workspace_id, reminder_rule_id) WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS reminder_deliveries_recipient_sched_idx
  ON reminder_deliveries(recipient_user_id, status, scheduled_for);
CREATE INDEX IF NOT EXISTS reminder_deliveries_ws_task_idx
  ON reminder_deliveries(workspace_id, task_id);

CREATE INDEX IF NOT EXISTS messages_user_role_created_idx
  ON messages(user_id, role, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_ws_pending_group_idx
  ON messages(workspace_id, pending_group_id) WHERE pending_group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS pending_actions_expiry_idx
  ON pending_actions(expires_at);

-- Expression must stay byte-for-byte what TasksRepository.searchActiveTasks emits.
CREATE INDEX IF NOT EXISTS tasks_fts_idx
  ON tasks USING GIN (to_tsvector('simple', title || ' ' || coalesce(context, '')));

CREATE INDEX IF NOT EXISTS occurrences_live_idx
  ON task_occurrences(status) WHERE status IN ('scheduled', 'open', 'in_progress');
CREATE INDEX IF NOT EXISTS tasks_recurring_active_idx
  ON tasks(status) WHERE recurrence_rule IS NOT NULL;

-- Duplicates the primary key (workspace_id, task_id, local_date).
DROP INDEX IF EXISTS task_recurrence_exclusions_task_idx;
