ALTER TABLE task_occurrences
  ADD COLUMN default_reminders_suppressed boolean NOT NULL DEFAULT false;
