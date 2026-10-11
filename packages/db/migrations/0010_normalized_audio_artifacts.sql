ALTER TABLE takes
  ADD CONSTRAINT takes_id_owner_play_unique UNIQUE (id, owner_user_id, play_id);

ALTER TABLE jobs
  ADD CONSTRAINT jobs_id_owner_play_kind_unique UNIQUE (id, owner_user_id, play_id, kind);

CREATE TABLE take_stage_job_chains (
  job_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  play_id uuid NOT NULL,
  take_id uuid NOT NULL,
  transcript_id uuid,
  transcript_status text,
  stage_kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT take_stage_job_chains_transcript_status_check
    CHECK (transcript_status IS NULL OR transcript_status IN ('current', 'stale')),
  CONSTRAINT take_stage_job_chains_transcript_completeness_check
    CHECK ((transcript_id IS NULL) = (transcript_status IS NULL)),
  CONSTRAINT take_stage_job_chains_stage_kind_check
    CHECK (length(btrim(stage_kind)) > 0),
  CONSTRAINT take_stage_job_chains_job_fk
    FOREIGN KEY (job_id, owner_user_id, play_id, stage_kind)
    REFERENCES jobs(id, owner_user_id, play_id, kind) ON DELETE CASCADE,
  CONSTRAINT take_stage_job_chains_take_fk
    FOREIGN KEY (take_id, owner_user_id, play_id)
    REFERENCES takes(id, owner_user_id, play_id) ON DELETE CASCADE,
  CONSTRAINT take_stage_job_chains_transcript_fk
    FOREIGN KEY (transcript_id, owner_user_id, take_id, transcript_status)
    REFERENCES take_transcripts(id, owner_user_id, take_id, status)
    ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX take_stage_job_chains_owner_take_idx
  ON take_stage_job_chains(owner_user_id, take_id, stage_kind);
CREATE UNIQUE INDEX take_stage_job_chains_exact_transcript_stage_unique
  ON take_stage_job_chains(owner_user_id, take_id, transcript_id, stage_kind)
  WHERE transcript_id IS NOT NULL;
CREATE UNIQUE INDEX take_stage_job_chains_exact_take_stage_unique
  ON take_stage_job_chains(owner_user_id, take_id, stage_kind)
  WHERE transcript_id IS NULL;

CREATE FUNCTION enforce_current_take_stage_job() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id OR
    OLD.play_id IS DISTINCT FROM NEW.play_id OR
    OLD.take_id IS DISTINCT FROM NEW.take_id OR
    OLD.transcript_id IS DISTINCT FROM NEW.transcript_id OR
    OLD.job_id IS DISTINCT FROM NEW.job_id OR
    OLD.stage_kind IS DISTINCT FROM NEW.stage_kind
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'take stage job evidence identity is immutable';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.transcript_status <> 'current' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'take stage jobs may only be enqueued for a current transcript';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.stage_kind = 'measure_take' AND NEW.transcript_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'measurement jobs require an exact current transcript';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER take_stage_job_chains_require_current_transcript
  BEFORE INSERT OR UPDATE OF job_id, owner_user_id, play_id, take_id, transcript_id, stage_kind
  ON take_stage_job_chains
  FOR EACH ROW EXECUTE FUNCTION enforce_current_take_stage_job();

CREATE TABLE normalized_audio_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  play_id uuid NOT NULL,
  take_id uuid NOT NULL,
  transcript_id uuid NOT NULL,
  transcript_status text NOT NULL DEFAULT 'current',
  canonical_object_key text NOT NULL,
  content_sha256 text NOT NULL,
  storage_version_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT normalized_audio_artifacts_transcript_status_check
    CHECK (transcript_status IN ('current', 'stale')),
  CONSTRAINT normalized_audio_artifacts_content_sha256_check
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT normalized_audio_artifacts_storage_version_check
    CHECK (length(btrim(storage_version_token)) > 0),
  CONSTRAINT normalized_audio_artifacts_canonical_key_check CHECK (
    canonical_object_key =
      'users/' || owner_user_id::text ||
      '/plays/' || play_id::text ||
      '/takes/' || take_id::text ||
      '/transcripts/' || transcript_id::text ||
      '/normalized.wav'
  ),
  CONSTRAINT normalized_audio_artifacts_take_chain_fk
    FOREIGN KEY (take_id, owner_user_id, play_id)
    REFERENCES takes(id, owner_user_id, play_id) ON DELETE CASCADE,
  CONSTRAINT normalized_audio_artifacts_transcript_chain_fk
    FOREIGN KEY (transcript_id, owner_user_id, take_id, transcript_status)
    REFERENCES take_transcripts(id, owner_user_id, take_id, status)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT normalized_audio_artifacts_one_per_transcript_unique
    UNIQUE (owner_user_id, take_id, transcript_id),
  CONSTRAINT normalized_audio_artifacts_canonical_object_key_unique
    UNIQUE (canonical_object_key)
);

CREATE INDEX normalized_audio_artifacts_owner_take_status_idx
  ON normalized_audio_artifacts(owner_user_id, take_id, transcript_status);

CREATE FUNCTION enforce_current_normalized_audio_artifact() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id OR
    OLD.play_id IS DISTINCT FROM NEW.play_id OR
    OLD.take_id IS DISTINCT FROM NEW.take_id OR
    OLD.transcript_id IS DISTINCT FROM NEW.transcript_id OR
    OLD.canonical_object_key IS DISTINCT FROM NEW.canonical_object_key OR
    OLD.content_sha256 IS DISTINCT FROM NEW.content_sha256 OR
    OLD.storage_version_token IS DISTINCT FROM NEW.storage_version_token
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'normalized audio artifact evidence is immutable';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.transcript_status <> 'current' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'normalized audio may only be registered for a current transcript';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER normalized_audio_artifacts_require_current_transcript
  BEFORE INSERT OR UPDATE OF owner_user_id, play_id, take_id, transcript_id, canonical_object_key,
    content_sha256, storage_version_token
  ON normalized_audio_artifacts
  FOR EACH ROW EXECUTE FUNCTION enforce_current_normalized_audio_artifact();

CREATE TABLE private_object_cleanup_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  play_id uuid NOT NULL,
  take_id uuid NOT NULL,
  transcript_id uuid NOT NULL,
  transcript_status text NOT NULL DEFAULT 'current',
  source_job_id uuid NOT NULL,
  source_attempt_count integer NOT NULL,
  source_lease_token uuid NOT NULL,
  object_key text NOT NULL,
  storage_version_token text NOT NULL,
  failure_code text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT private_object_cleanup_tasks_transcript_status_check
    CHECK (transcript_status IN ('current', 'stale', 'attempted')),
  CONSTRAINT private_object_cleanup_tasks_attempt_count_check
    CHECK (source_attempt_count > 0),
  CONSTRAINT private_object_cleanup_tasks_object_key_check
    CHECK (
      length(btrim(object_key)) > 0 AND
      position('://' in object_key) = 0 AND
      object_key LIKE (
        'users/' || owner_user_id::text ||
        '/plays/' || play_id::text ||
        '/takes/' || take_id::text || '/%'
      )
    ),
  CONSTRAINT private_object_cleanup_tasks_storage_version_check
    CHECK (length(btrim(storage_version_token)) > 0),
  CONSTRAINT private_object_cleanup_tasks_failure_code_check
    CHECK (length(btrim(failure_code)) > 0),
  CONSTRAINT private_object_cleanup_tasks_status_check
    CHECK (status IN ('queued', 'completed', 'action_required')),
  CONSTRAINT private_object_cleanup_tasks_attempt_object_version_unique
    UNIQUE (owner_user_id, source_job_id, source_attempt_count, source_lease_token,
      object_key, storage_version_token)
);

CREATE INDEX private_object_cleanup_tasks_claimable_idx
  ON private_object_cleanup_tasks(status, created_at) WHERE status = 'queued';
CREATE INDEX private_object_cleanup_tasks_owner_take_idx
  ON private_object_cleanup_tasks(owner_user_id, take_id, created_at);

CREATE FUNCTION validate_private_object_cleanup_chain() RETURNS trigger AS $$
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

CREATE TRIGGER private_object_cleanup_tasks_validate_chain
  BEFORE INSERT OR UPDATE OF owner_user_id, play_id, take_id, transcript_id, transcript_status,
    source_job_id, source_attempt_count, source_lease_token, object_key, storage_version_token, failure_code
  ON private_object_cleanup_tasks
  FOR EACH ROW EXECUTE FUNCTION validate_private_object_cleanup_chain();
