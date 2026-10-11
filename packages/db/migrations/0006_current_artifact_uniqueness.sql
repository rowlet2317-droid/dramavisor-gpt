WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY owner_user_id, play_id, kind
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS current_rank
  FROM analysis_artifacts
  WHERE status = 'current'
)
UPDATE analysis_artifacts AS artifact
SET status = 'stale', updated_at = now()
FROM ranked
WHERE artifact.id = ranked.id AND ranked.current_rank > 1;

DROP INDEX IF EXISTS analysis_artifacts_current_kind_idx;
CREATE UNIQUE INDEX analysis_artifacts_one_current_kind_unique
  ON analysis_artifacts (owner_user_id, play_id, kind)
  WHERE status = 'current';
