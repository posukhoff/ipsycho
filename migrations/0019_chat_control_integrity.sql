ALTER TABLE user_settings
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_version_positive CHECK (version > 0);
