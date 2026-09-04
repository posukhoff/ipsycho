-- A Telegram send whose outcome is unknown (the request may have reached Telegram before the
-- connection failed) is recorded as ambiguous instead of being retried into a duplicate.
ALTER TYPE delivery_status ADD VALUE IF NOT EXISTS 'ambiguous';
ALTER TYPE suppressed_reason ADD VALUE IF NOT EXISTS 'orphaned';
