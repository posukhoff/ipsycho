ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS profile_invited_at timestamptz;
