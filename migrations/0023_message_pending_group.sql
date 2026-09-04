ALTER TABLE messages
  ADD COLUMN pending_group_id uuid;

ALTER TABLE messages
  ADD CONSTRAINT messages_pending_group_workspace_fk
  FOREIGN KEY (workspace_id, pending_group_id)
  REFERENCES action_groups(workspace_id, id)
  ON DELETE SET NULL (pending_group_id);

CREATE INDEX messages_workspace_user_role_created_idx
  ON messages(workspace_id, user_id, role, created_at DESC);
