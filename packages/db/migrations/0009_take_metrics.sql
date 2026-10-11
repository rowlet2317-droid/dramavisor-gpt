ALTER TABLE take_transcripts
  ADD CONSTRAINT take_transcripts_metric_chain_unique
  UNIQUE (id, owner_user_id, take_id, status);

CREATE TABLE take_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  take_id uuid NOT NULL,
  transcript_id uuid NOT NULL,
  transcript_status text NOT NULL DEFAULT 'current',
  measurement_version text NOT NULL,
  metrics jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT take_metrics_transcript_status_check
    CHECK (transcript_status IN ('current', 'stale')),
  CONSTRAINT take_metrics_payload_object_check
    CHECK (jsonb_typeof(metrics) = 'object'),
  CONSTRAINT take_metrics_measurement_version_check
    CHECK (length(btrim(measurement_version)) > 0),
  CONSTRAINT take_metrics_current_transcript_fk
    FOREIGN KEY (transcript_id, owner_user_id, take_id, transcript_status)
    REFERENCES take_transcripts(id, owner_user_id, take_id, status)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT take_metrics_id_owner_transcript_unique
    UNIQUE (id, owner_user_id, transcript_id),
  CONSTRAINT take_metrics_publication_dedupe_unique
    UNIQUE (owner_user_id, take_id, transcript_id, measurement_version)
);

CREATE INDEX take_metrics_owner_take_status_idx
  ON take_metrics(owner_user_id, take_id, transcript_status);

CREATE FUNCTION enforce_current_take_metric_publication() RETURNS trigger AS $$
BEGIN
  IF NEW.transcript_status <> 'current' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'take metrics may only be published for a current transcript';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER take_metrics_require_current_transcript
  BEFORE INSERT ON take_metrics
  FOR EACH ROW EXECUTE FUNCTION enforce_current_take_metric_publication();

CREATE TABLE take_metric_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  take_metric_id uuid NOT NULL,
  transcript_id uuid NOT NULL,
  element_id text NOT NULL,
  start_ms integer NOT NULL,
  end_ms integer NOT NULL,
  speech_duration_ms integer NOT NULL,
  silence_duration_ms integer NOT NULL,
  rms_db real NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT take_metric_lines_window_check
    CHECK (start_ms >= 0 AND end_ms >= start_ms),
  CONSTRAINT take_metric_lines_duration_check
    CHECK (speech_duration_ms >= 0 AND silence_duration_ms >= 0),
  CONSTRAINT take_metric_lines_metric_chain_fk
    FOREIGN KEY (take_metric_id, owner_user_id, transcript_id)
    REFERENCES take_metrics(id, owner_user_id, transcript_id) ON DELETE CASCADE,
  CONSTRAINT take_metric_lines_alignment_chain_fk
    FOREIGN KEY (owner_user_id, transcript_id, element_id)
    REFERENCES line_alignments(owner_user_id, transcript_id, element_id),
  CONSTRAINT take_metric_lines_owner_element_unique
    UNIQUE (owner_user_id, take_metric_id, element_id)
);

CREATE INDEX take_metric_lines_owner_metric_idx
  ON take_metric_lines(owner_user_id, take_metric_id);
