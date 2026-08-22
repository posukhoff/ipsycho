CREATE TYPE topic_status AS ENUM ('active', 'paused', 'resolved', 'abandoned');
CREATE TYPE memory_item_type AS ENUM ('note', 'decision', 'preference', 'context');
CREATE TYPE goal_status AS ENUM ('active', 'paused', 'completed', 'cancelled');

CREATE TABLE conversation_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  title varchar(200) NOT NULL,
  summary text NOT NULL,
  status topic_status NOT NULL DEFAULT 'active',
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_topics_workspace_id_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT conversation_topics_user_membership_fk FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_members(workspace_id, user_id)
);
CREATE INDEX conversation_topics_workspace_user_status_idx
  ON conversation_topics(workspace_id, user_id, status, last_message_at);

CREATE TABLE memory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  type memory_item_type NOT NULL,
  content text NOT NULL,
  sensitive boolean NOT NULL DEFAULT false,
  source varchar(32) NOT NULL,
  source_message_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_items_workspace_id_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT memory_items_user_membership_fk FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_members(workspace_id, user_id)
);
CREATE INDEX memory_items_workspace_user_updated_idx
  ON memory_items(workspace_id, user_id, updated_at);

CREATE TABLE goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id uuid NOT NULL,
  source_action_group_id uuid,
  title varchar(500) NOT NULL,
  why text,
  status goal_status NOT NULL DEFAULT 'active',
  target_local_date date,
  review_enabled boolean NOT NULL DEFAULT true,
  next_review_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goals_workspace_id_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT goals_creator_membership_fk FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES workspace_members(workspace_id, user_id)
);
CREATE INDEX goals_workspace_status_idx ON goals(workspace_id, status, updated_at);

CREATE TABLE task_goals (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  goal_id uuid NOT NULL,
  source varchar(32) NOT NULL,
  confidence integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, task_id, goal_id),
  CONSTRAINT task_goals_task_workspace_fk FOREIGN KEY (workspace_id, task_id)
    REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT task_goals_goal_workspace_fk FOREIGN KEY (workspace_id, goal_id)
    REFERENCES goals(workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE messages ADD COLUMN topic_id uuid;
ALTER TABLE messages ADD CONSTRAINT messages_topic_workspace_fk
  FOREIGN KEY (workspace_id, topic_id) REFERENCES conversation_topics(workspace_id, id);
