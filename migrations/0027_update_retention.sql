-- telegram_updates is the idempotency ledger for incoming updates. Rows now expire after seven
-- days (maintenance deletes by created_at) and the chat/message uniqueness is scoped per bot so a
-- staging and a production bot sharing a database never collide.
CREATE INDEX IF NOT EXISTS telegram_updates_created_at_idx ON telegram_updates(created_at);
DROP INDEX IF EXISTS telegram_chat_message_uq;
CREATE UNIQUE INDEX IF NOT EXISTS telegram_chat_message_uq ON telegram_updates(bot_identity, chat_id, telegram_message_id) WHERE telegram_message_id IS NOT NULL;
