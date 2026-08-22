ALTER TABLE user_settings
  ADD COLUMN onboarding_completed_at timestamptz,
  ADD COLUMN ai_monthly_warning_usd numeric(10,2) NOT NULL DEFAULT 5.00,
  ADD COLUMN last_ai_spend_warning_month varchar(7),
  ADD COLUMN event_reminder_offsets_minutes jsonb NOT NULL DEFAULT '[-60,-15,0]'::jsonb,
  ADD COLUMN planned_task_reminder_offset_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN critical_post_due_minutes integer NOT NULL DEFAULT 60 CHECK (critical_post_due_minutes >= 15),
  ADD COLUMN seen_normal_minutes integer NOT NULL DEFAULT 60 CHECK (seen_normal_minutes >= 15),
  ADD COLUMN seen_required_minutes integer NOT NULL DEFAULT 30 CHECK (seen_required_minutes >= 15),
  ADD COLUMN seen_critical_minutes integer NOT NULL DEFAULT 15 CHECK (seen_critical_minutes >= 15),
  ADD COLUMN pending_input jsonb;

ALTER TABLE tasks
  ADD COLUMN habit_offer_sent_at timestamptz;

ALTER TABLE reminder_rules
  ADD COLUMN origin varchar(16) NOT NULL DEFAULT 'default';

ALTER TABLE messages
  ADD COLUMN ai_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN ai_next_retry_at timestamptz,
  ADD COLUMN ai_last_error_at timestamptz;

ALTER TABLE ai_usage
  ADD COLUMN pricing_revision varchar(64),
  ADD COLUMN estimated_cost_usd numeric(12,6);

CREATE TABLE briefing_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL,
  kind varchar(32) NOT NULL CHECK (kind IN ('morning','evening','weekly','evening_weekly')),
  local_date date NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status delivery_status NOT NULL DEFAULT 'pending',
  suppressed_reason suppressed_reason,
  deduplication_key varchar(255) NOT NULL UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  sent_at timestamptz,
  telegram_message_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,recipient_user_id) REFERENCES workspace_members(workspace_id,user_id)
);
CREATE INDEX briefing_delivery_due_idx ON briefing_deliveries(status, scheduled_for);
CREATE INDEX briefing_delivery_user_date_idx ON briefing_deliveries(recipient_user_id, local_date, kind);

CREATE INDEX messages_waiting_retry_idx ON messages(status, ai_next_retry_at, created_at)
  WHERE status='waiting_ai';
