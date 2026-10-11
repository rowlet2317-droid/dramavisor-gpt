CREATE TABLE job_lease_attempt_history (
  source_job_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  play_id uuid NOT NULL,
  attempt_count integer NOT NULL,
  lease_token uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_job_id, attempt_count, lease_token),
  FOREIGN KEY (source_job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE FUNCTION archive_job_lease_attempt() RETURNS trigger AS $$
BEGIN
  IF OLD.lease_token IS NOT NULL AND (OLD.attempt_count IS DISTINCT FROM NEW.attempt_count
    OR OLD.lease_token IS DISTINCT FROM NEW.lease_token) THEN
    INSERT INTO job_lease_attempt_history (source_job_id, owner_user_id, play_id, attempt_count, lease_token)
    VALUES (OLD.id, OLD.owner_user_id, OLD.play_id, OLD.attempt_count, OLD.lease_token)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_archive_lease_attempt
  BEFORE UPDATE OF attempt_count, lease_token ON jobs
  FOR EACH ROW EXECUTE FUNCTION archive_job_lease_attempt();

ALTER TABLE private_object_cleanup_tasks
  DROP CONSTRAINT private_object_cleanup_tasks_attempt_object_version_unique;
CREATE UNIQUE INDEX private_object_cleanup_tasks_source_object_version_unique
  ON private_object_cleanup_tasks(owner_user_id, source_job_id, object_key, storage_version_token);

CREATE OR REPLACE FUNCTION validate_private_object_cleanup_chain() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'private object cleanup attempt identity is immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM takes WHERE id = NEW.take_id AND owner_user_id = NEW.owner_user_id AND play_id = NEW.play_id
  ) OR NOT EXISTS (
    SELECT 1 FROM take_stage_job_chains AS stage
    JOIN jobs AS source_job ON source_job.id = stage.job_id AND source_job.owner_user_id = stage.owner_user_id
      AND source_job.play_id = stage.play_id AND source_job.kind = stage.stage_kind
    WHERE stage.job_id = NEW.source_job_id AND stage.owner_user_id = NEW.owner_user_id
      AND stage.play_id = NEW.play_id AND stage.take_id = NEW.take_id
      AND stage.stage_kind = 'process_take' AND stage.transcript_id IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM jobs AS source_job WHERE source_job.id = NEW.source_job_id
      AND source_job.owner_user_id = NEW.owner_user_id AND source_job.play_id = NEW.play_id
      AND source_job.attempt_count = NEW.source_attempt_count AND source_job.lease_token = NEW.source_lease_token
    UNION ALL
    SELECT 1 FROM job_lease_attempt_history WHERE source_job_id = NEW.source_job_id
      AND owner_user_id = NEW.owner_user_id AND play_id = NEW.play_id
      AND attempt_count = NEW.source_attempt_count AND lease_token = NEW.source_lease_token
  ) OR (NEW.transcript_status = 'attempted' AND EXISTS (
    SELECT 1 FROM take_transcripts WHERE id = NEW.transcript_id
      AND (owner_user_id <> NEW.owner_user_id OR take_id <> NEW.take_id)
  )) OR (NEW.transcript_status <> 'attempted' AND NOT EXISTS (
    SELECT 1 FROM take_transcripts WHERE id = NEW.transcript_id AND owner_user_id = NEW.owner_user_id
      AND take_id = NEW.take_id AND status = NEW.transcript_status
  )) THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'private object cleanup must snapshot one exact take stage and transcript attempt';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
