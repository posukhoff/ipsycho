ALTER TABLE task_occurrences
  ADD COLUMN needs_reminder_rebuild boolean NOT NULL DEFAULT false;
