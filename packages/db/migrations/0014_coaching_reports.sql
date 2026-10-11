CREATE TABLE coaching_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  play_id uuid NOT NULL,
  take_id uuid NOT NULL,
  transcript_id uuid NOT NULL,
  transcript_status text NOT NULL DEFAULT 'current',
  measurement_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  audio_review_status text NOT NULL DEFAULT 'pending',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  report jsonb,
  synthesis_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coaching_reports_transcript_status_check CHECK (transcript_status IN ('current', 'stale')),
  CONSTRAINT coaching_reports_status_check
    CHECK (status IN ('processing', 'completed', 'completed_with_limitations', 'action_required')),
  CONSTRAINT coaching_reports_audio_review_status_check
    CHECK (audio_review_status IN ('pending', 'completed', 'failed')),
  CONSTRAINT coaching_reports_evidence_array_check CHECK (jsonb_typeof(evidence) = 'array'),
  CONSTRAINT coaching_reports_report_object_check CHECK (report IS NULL OR jsonb_typeof(report) = 'object'),
  CONSTRAINT coaching_reports_take_chain_fk
    FOREIGN KEY (take_id, owner_user_id, play_id)
    REFERENCES takes(id, owner_user_id, play_id) ON DELETE CASCADE,
  CONSTRAINT coaching_reports_transcript_chain_fk
    FOREIGN KEY (transcript_id, owner_user_id, take_id, transcript_status)
    REFERENCES take_transcripts(id, owner_user_id, take_id, status)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT coaching_reports_measurement_chain_fk
    FOREIGN KEY (measurement_id, owner_user_id, transcript_id)
    REFERENCES take_metrics(id, owner_user_id, transcript_id) ON DELETE CASCADE,
  CONSTRAINT coaching_reports_owner_take_transcript_unique UNIQUE (owner_user_id, take_id, transcript_id)
);

CREATE INDEX coaching_reports_owner_take_status_idx
  ON coaching_reports(owner_user_id, take_id, status);

CREATE FUNCTION enforce_current_coaching_report_publication() RETURNS trigger AS $$
BEGIN
  IF NEW.transcript_status <> 'current' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'coaching reports may only be published for a current transcript';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER coaching_reports_require_current_transcript
  BEFORE INSERT ON coaching_reports
  FOR EACH ROW EXECUTE FUNCTION enforce_current_coaching_report_publication();
