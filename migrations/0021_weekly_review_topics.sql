ALTER TABLE conversation_topics
  DROP CONSTRAINT IF EXISTS conversation_topics_review_kind_chk;

ALTER TABLE conversation_topics
  ADD CONSTRAINT conversation_topics_review_kind_chk
  CHECK (review_kind IS NULL OR review_kind IN ('evening', 'weekly'));
