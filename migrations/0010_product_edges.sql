ALTER TABLE user_settings
  ADD COLUMN digest_timezone varchar(128) NOT NULL DEFAULT 'Europe/Kyiv',
  ADD COLUMN quiet_hours_timezone varchar(128) NOT NULL DEFAULT 'Europe/Kyiv';

UPDATE user_settings
SET digest_timezone = timezone,
    quiet_hours_timezone = timezone;

ALTER TABLE conversation_topics
  ADD COLUMN clarification_count integer NOT NULL DEFAULT 0 CHECK (clarification_count >= 0);
