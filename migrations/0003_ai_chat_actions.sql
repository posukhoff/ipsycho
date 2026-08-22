CREATE TYPE message_role AS ENUM ('user','assistant');
CREATE TYPE action_group_status AS ENUM ('pending','applying','undoing','applied','undone','cancelled','expired','failed');

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role message_role NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'processed',
  content text NOT NULL,
  telegram_chat_id bigint,
  telegram_message_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id)
);
CREATE UNIQUE INDEX messages_workspace_chat_message_uq ON messages(workspace_id,telegram_chat_id,telegram_message_id) WHERE telegram_message_id IS NOT NULL;
CREATE INDEX messages_workspace_created_idx ON messages(workspace_id,created_at DESC);

CREATE TABLE ai_provider_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider varchar(32) NOT NULL,
  consent_version varchar(32) NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE(user_id,provider,consent_version)
);

CREATE TABLE action_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL,
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  status action_group_status NOT NULL,
  requires_confirmation boolean NOT NULL DEFAULT false,
  undo_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  undone_at timestamptz,
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,actor_user_id) REFERENCES workspace_members(workspace_id,user_id)
);
CREATE INDEX action_groups_workspace_status_idx ON action_groups(workspace_id,status,created_at DESC);

ALTER TABLE tasks ADD COLUMN source_action_group_id uuid;
ALTER TABLE tasks ADD CONSTRAINT tasks_source_action_group_workspace_fk
  FOREIGN KEY(workspace_id,source_action_group_id) REFERENCES action_groups(workspace_id,id);
CREATE INDEX tasks_source_action_group_idx ON tasks(workspace_id,source_action_group_id);

CREATE TABLE pending_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  group_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  action_type varchar(64) NOT NULL,
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,group_id) REFERENCES action_groups(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,actor_user_id) REFERENCES workspace_members(workspace_id,user_id)
);
CREATE INDEX pending_actions_group_idx ON pending_actions(workspace_id,group_id);

CREATE TABLE action_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  group_id uuid NOT NULL,
  action_type varchar(64) NOT NULL,
  entity_type varchar(64) NOT NULL,
  entity_id uuid NOT NULL,
  post_version integer,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,group_id) REFERENCES action_groups(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX action_events_group_idx ON action_events(workspace_id,group_id,created_at);

CREATE TABLE ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  provider varchar(32) NOT NULL,
  model varchar(128) NOT NULL,
  provider_request_id varchar(255),
  input_tokens integer,
  output_tokens integer,
  latency_ms integer NOT NULL,
  status varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id)
);
CREATE INDEX ai_usage_user_created_idx ON ai_usage(user_id,created_at DESC);
