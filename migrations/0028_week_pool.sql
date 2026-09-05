-- A task with no date lives in the pool. Once a week the user takes some of them for the coming
-- week; the mark is the Monday of that week as a local date, so a stale mark is unrepresentable
-- and no job has to clear anything. The date itself, not a boolean, is what makes "picked last
-- week and never started" visible next time.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS picked_week_start date;
CREATE INDEX IF NOT EXISTS tasks_week_pick_idx ON tasks(workspace_id, picked_week_start) WHERE picked_week_start IS NOT NULL;
