DO $$ BEGIN
  CREATE TYPE topic_mode AS ENUM ('normal','analysis');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE conversation_topics
  ADD COLUMN IF NOT EXISTS mode topic_mode NOT NULL DEFAULT 'normal';

ALTER TABLE conversation_topics
  ADD COLUMN IF NOT EXISTS summary_expires_at timestamptz;

UPDATE conversation_topics
SET summary_expires_at = last_message_at + interval '90 days'
WHERE summary_expires_at IS NULL;

ALTER TABLE conversation_topics
  ALTER COLUMN summary_expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS conversation_topics_expiry_idx
  ON conversation_topics(summary_expires_at);

CREATE INDEX IF NOT EXISTS memory_items_content_fts_idx
  ON memory_items USING GIN (to_tsvector('simple', content));
