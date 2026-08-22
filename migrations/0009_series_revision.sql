ALTER TABLE tasks
  ADD COLUMN series_revision integer NOT NULL DEFAULT 1;

ALTER TABLE task_occurrences
  ADD COLUMN series_revision integer NOT NULL DEFAULT 1;

ALTER TABLE task_occurrences
  DROP CONSTRAINT IF EXISTS task_occurrences_task_id_recurrence_key_key;
DROP INDEX IF EXISTS occurrence_recurrence_key_uq;

CREATE UNIQUE INDEX occurrence_series_recurrence_key_uq
  ON task_occurrences(task_id, series_revision, recurrence_key)
  WHERE recurrence_key IS NOT NULL;
