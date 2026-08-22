ALTER TABLE conversation_topics
  ADD COLUMN IF NOT EXISTS review_kind varchar(16);

ALTER TABLE conversation_topics
  ADD CONSTRAINT conversation_topics_review_kind_chk
  CHECK (review_kind IS NULL OR review_kind = 'evening');
