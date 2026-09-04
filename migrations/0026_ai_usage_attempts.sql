-- One AiService call may make two provider requests (one structured-output repair). Attempts and
-- cached prompt tokens were invisible, so the hourly call limit and the cost estimate undercounted
-- exactly the calls that cost the most.
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 1;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS cached_input_tokens integer;
