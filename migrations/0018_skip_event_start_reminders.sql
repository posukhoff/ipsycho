ALTER TABLE user_settings
  ALTER COLUMN event_reminder_offsets_minutes SET DEFAULT '[-60,-15]'::jsonb;

UPDATE user_settings
SET event_reminder_offsets_minutes = (
  SELECT COALESCE(jsonb_agg(value ORDER BY ordinal), '[]'::jsonb)
  FROM jsonb_array_elements(event_reminder_offsets_minutes) WITH ORDINALITY AS offsets(value, ordinal)
  WHERE value <> '0'::jsonb
);

UPDATE reminder_deliveries AS delivery
SET status = 'suppressed', suppressed_reason = 'no_longer_applicable'
FROM reminder_rules AS rule
JOIN tasks AS task
  ON task.workspace_id = rule.workspace_id AND task.id = rule.task_id
JOIN task_occurrences AS occurrence
  ON occurrence.workspace_id = task.workspace_id AND occurrence.task_id = task.id
WHERE delivery.reminder_rule_id = rule.id
  AND occurrence.id = delivery.occurrence_id
  AND delivery.status = 'pending'
  AND task.kind = 'event'
  AND rule.purpose = 'user_reminder'
  AND delivery.intended_for = occurrence.planned_start_at;
