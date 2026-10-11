ALTER TABLE play_models
  ADD COLUMN issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN source_job_dedupe_key text;

CREATE UNIQUE INDEX play_models_source_job_dedupe_key_unique
  ON play_models (source_job_dedupe_key)
  WHERE source_job_dedupe_key IS NOT NULL;

ALTER TABLE analysis_artifacts
  ADD COLUMN status text NOT NULL DEFAULT 'current';

ALTER TABLE jobs
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN dedupe_key text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN error_code text,
  ADD COLUMN result_play_model_version_id uuid REFERENCES play_models(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX jobs_dedupe_key_unique
  ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX jobs_claimable_idx
  ON jobs (status, available_at, lease_expires_at);
