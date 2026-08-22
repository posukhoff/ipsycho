WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY source_message_id ORDER BY created_at, id) AS position
  FROM action_groups
  WHERE source_message_id IS NOT NULL
    AND status IN ('pending', 'applying', 'undoing', 'applied')
)
UPDATE action_groups AS target
SET source_message_id = NULL
FROM ranked
WHERE target.id = ranked.id
  AND ranked.position > 1;

CREATE UNIQUE INDEX action_groups_active_source_message_uq
  ON action_groups(source_message_id)
  WHERE source_message_id IS NOT NULL
    AND status IN ('pending', 'applying', 'undoing', 'applied');
