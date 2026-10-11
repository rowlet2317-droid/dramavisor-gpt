CREATE OR REPLACE FUNCTION validate_private_object_cleanup_chain() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'private object cleanup attempt identity is immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM takes
    WHERE id = NEW.take_id AND owner_user_id = NEW.owner_user_id AND play_id = NEW.play_id
  ) OR NOT EXISTS (
    SELECT 1 FROM take_stage_job_chains AS stage
    JOIN jobs AS source_job ON
      source_job.id = stage.job_id AND source_job.owner_user_id = stage.owner_user_id
      AND source_job.play_id = stage.play_id AND source_job.kind = stage.stage_kind
    WHERE stage.job_id = NEW.source_job_id AND stage.owner_user_id = NEW.owner_user_id
      AND stage.play_id = NEW.play_id AND stage.take_id = NEW.take_id
      AND source_job.attempt_count = NEW.source_attempt_count
      AND source_job.lease_token = NEW.source_lease_token
      AND (stage.transcript_id IS NULL OR
        (stage.transcript_id = NEW.transcript_id AND stage.transcript_status = NEW.transcript_status))
  ) OR (
    NEW.transcript_status = 'attempted' AND
    EXISTS (SELECT 1 FROM take_transcripts WHERE id = NEW.transcript_id)
  ) OR (
    NEW.transcript_status <> 'attempted' AND NOT EXISTS (
      SELECT 1 FROM take_transcripts
      WHERE id = NEW.transcript_id AND owner_user_id = NEW.owner_user_id
        AND take_id = NEW.take_id AND status = NEW.transcript_status
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'private object cleanup must snapshot one exact take stage and transcript attempt';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
