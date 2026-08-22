CREATE TABLE registration_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token varchar(64) NOT NULL UNIQUE,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT registration_invites_expiry_ck CHECK (expires_at > created_at)
);

CREATE INDEX registration_invites_open_idx
  ON registration_invites(expires_at)
  WHERE used_at IS NULL;
