CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_status AS ENUM ('active','disabled','deletion_pending');
CREATE TYPE ai_status AS ENUM ('enabled','suspended');
CREATE TYPE task_kind AS ENUM ('task','event');
CREATE TYPE importance AS ENUM ('normal','required','critical');
CREATE TYPE task_status AS ENUM ('active','paused','closed','cancelled');
CREATE TYPE time_mode AS ENUM ('point','window','deadline','fuzzy');
CREATE TYPE occurrence_status AS ENUM ('scheduled','open','in_progress','done','skipped','cancelled','elapsed');
CREATE TYPE miss_policy AS ENUM ('expire','carry_over');
CREATE TYPE reminder_trigger AS ENUM ('exact','relative_timestamp','local_date');
CREATE TYPE reminder_purpose AS ENUM ('user_reminder','follow_up','planning_review');
CREATE TYPE quiet_policy AS ENUM ('respect','bypass');
CREATE TYPE delivery_status AS ENUM ('pending','processing','sent','cancelled','failed','suppressed');
CREATE TYPE suppressed_reason AS ENUM ('superseded','access','quiet_stale','snooze_stale','no_longer_applicable');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id bigint NOT NULL UNIQUE,
  status user_status NOT NULL DEFAULT 'active',
  ai_status ai_status NOT NULL DEFAULT 'enabled',
  deletion_requested_at timestamptz,
  delete_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone varchar(128) NOT NULL DEFAULT 'Europe/Kyiv',
  pinned_language varchar(16),
  quiet_hours_enabled boolean NOT NULL DEFAULT true,
  weekday_quiet_start varchar(5) NOT NULL DEFAULT '22:00',
  weekday_quiet_end varchar(5) NOT NULL DEFAULT '08:00',
  weekend_quiet_start varchar(5) NOT NULL DEFAULT '23:00',
  weekend_quiet_end varchar(5) NOT NULL DEFAULT '09:00',
  notifications_snoozed_until timestamptz,
  morning_reference_time varchar(5) NOT NULL DEFAULT '09:00',
  evening_reference_time varchar(5) NOT NULL DEFAULT '20:00',
  morning_digest_enabled boolean NOT NULL DEFAULT false,
  evening_digest_enabled boolean NOT NULL DEFAULT false,
  weekly_review_enabled boolean NOT NULL DEFAULT false,
  weekly_review_weekday integer NOT NULL DEFAULT 7 CHECK (weekly_review_weekday BETWEEN 1 AND 7),
  weekly_review_time varchar(5) NOT NULL DEFAULT '20:00'
);
CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind varchar(16) NOT NULL DEFAULT 'personal',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspaces_owner_kind_idx ON workspaces(owner_user_id,kind);
CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role varchar(16) NOT NULL DEFAULT 'owner',
  PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id uuid NOT NULL,
  title text NOT NULL,
  why text,
  next_action text,
  kind task_kind NOT NULL DEFAULT 'task',
  importance importance NOT NULL DEFAULT 'normal',
  status task_status NOT NULL DEFAULT 'active',
  time_mode time_mode NOT NULL,
  timezone varchar(128) NOT NULL,
  planned_start_at timestamptz,
  planned_end_at timestamptz,
  planned_local_date date,
  due_at timestamptz,
  due_local_date date,
  fuzzy_horizon_text text,
  review_at timestamptz,
  recurrence_rule text,
  recurrence_timezone varchar(128),
  miss_policy miss_policy,
  habit_mode boolean NOT NULL DEFAULT false,
  minimum_action text,
  desired_action text,
  habit_trigger text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,created_by_user_id) REFERENCES workspace_members(workspace_id,user_id),
  CHECK (kind <> 'event' OR time_mode IN ('point','window')),
  CHECK (recurrence_rule IS NULL OR time_mode <> 'fuzzy'),
  CHECK (habit_mode = false OR (kind='task' AND recurrence_rule IS NOT NULL AND minimum_action IS NOT NULL AND desired_action IS NOT NULL)),
  CHECK (importance <> 'critical' OR time_mode <> 'deadline' OR due_at IS NOT NULL)
);
CREATE INDEX tasks_workspace_status_idx ON tasks(workspace_id,status);
CREATE TABLE task_checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  text text NOT NULL,
  sort_order integer NOT NULL,
  done boolean NOT NULL DEFAULT false,
  FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX checklist_task_idx ON task_checklist_items(workspace_id,task_id);
CREATE TABLE task_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  recurrence_key varchar(255),
  status occurrence_status NOT NULL,
  timezone varchar(128) NOT NULL,
  planned_start_at timestamptz,
  planned_end_at timestamptz,
  planned_local_date date,
  due_at timestamptz,
  due_local_date date,
  expires_at timestamptz,
  overdue boolean NOT NULL DEFAULT false,
  elapsed_at timestamptz,
  completed_at timestamptz,
  completed_late boolean NOT NULL DEFAULT false,
  skip_reason varchar(64),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  UNIQUE(task_id,recurrence_key),
  FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id) ON DELETE CASCADE,
  CHECK (planned_start_at IS NOT NULL OR planned_local_date IS NOT NULL OR due_at IS NOT NULL OR due_local_date IS NOT NULL)
);
CREATE INDEX occurrence_task_status_time_idx ON task_occurrences(workspace_id,task_id,status,planned_start_at);
CREATE TABLE task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  occurrence_id uuid,
  actor_user_id uuid,
  event_type varchar(64) NOT NULL,
  details text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,occurrence_id) REFERENCES task_occurrences(workspace_id,id),
  FOREIGN KEY(workspace_id,actor_user_id) REFERENCES workspace_members(workspace_id,user_id)
);
CREATE TABLE reminder_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  occurrence_id uuid,
  trigger_kind reminder_trigger NOT NULL,
  exact_at timestamptz,
  anchor varchar(32),
  offset_seconds integer,
  days_offset integer,
  local_time varchar(5),
  purpose reminder_purpose NOT NULL DEFAULT 'user_reminder',
  quiet_policy quiet_policy NOT NULL DEFAULT 'respect',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,occurrence_id) REFERENCES task_occurrences(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE reminder_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL,
  reminder_rule_id uuid NOT NULL,
  task_id uuid NOT NULL,
  occurrence_id uuid,
  intended_for timestamptz NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status delivery_status NOT NULL DEFAULT 'pending',
  suppressed_reason suppressed_reason,
  deduplication_key varchar(255) NOT NULL UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  sent_at timestamptz,
  telegram_message_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,recipient_user_id) REFERENCES workspace_members(workspace_id,user_id),
  FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,occurrence_id) REFERENCES task_occurrences(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,reminder_rule_id) REFERENCES reminder_rules(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX reminder_delivery_due_idx ON reminder_deliveries(status,scheduled_for);
CREATE TABLE telegram_updates (
  bot_identity varchar(64) NOT NULL,
  telegram_update_id bigint NOT NULL,
  chat_id bigint,
  telegram_message_id bigint,
  status varchar(32) NOT NULL DEFAULT 'received',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(bot_identity,telegram_update_id)
);
CREATE UNIQUE INDEX telegram_chat_message_uq ON telegram_updates(chat_id,telegram_message_id) WHERE telegram_message_id IS NOT NULL;
CREATE TABLE admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action varchar(64) NOT NULL,
  target_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata text,
  created_at timestamptz NOT NULL DEFAULT now()
);
