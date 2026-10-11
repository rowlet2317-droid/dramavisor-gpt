ALTER TABLE transcript_words ALTER COLUMN start_ms DROP NOT NULL;
ALTER TABLE transcript_words ALTER COLUMN end_ms DROP NOT NULL;

ALTER TABLE line_alignments ADD COLUMN script_ordinal integer;

WITH ordered AS (
  SELECT id, row_number() OVER (
    PARTITION BY owner_user_id, transcript_id
    ORDER BY created_at, id
  )::integer AS script_ordinal
  FROM line_alignments
)
UPDATE line_alignments
SET script_ordinal = ordered.script_ordinal
FROM ordered
WHERE line_alignments.id = ordered.id;

ALTER TABLE line_alignments ALTER COLUMN script_ordinal SET NOT NULL;
CREATE UNIQUE INDEX line_alignments_owner_script_ordinal_unique
  ON line_alignments(owner_user_id, transcript_id, script_ordinal);
