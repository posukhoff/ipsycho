-- The interface language Telegram reports for the user. Background pushes (briefings, reminders,
-- retry notices) have no update to read `from.language_code` from, so without this column every
-- user who never pinned a language got them in English while the chat itself answered in theirs.
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS telegram_language varchar(16);
