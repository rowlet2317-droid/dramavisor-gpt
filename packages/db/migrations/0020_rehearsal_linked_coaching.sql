ALTER TABLE takes ADD COLUMN rehearsal_session_id uuid NULL;

ALTER TABLE rehearsal_events
  ADD COLUMN received_at_ms bigint NULL,
  ADD COLUMN received_clock_id text NULL,
  ADD COLUMN timing_source text NULL,
  ADD COLUMN timing_at_ms bigint NULL,
  ADD COLUMN timing_clock_id text NULL;

ALTER TABLE rehearsal_events ADD CONSTRAINT rehearsal_events_receipt_timing_check CHECK (
  (received_at_ms IS NULL AND received_clock_id IS NULL)
  OR (received_at_ms IS NOT NULL AND received_at_ms >= 0
    AND received_clock_id IS NOT NULL AND length(btrim(received_clock_id)) > 0)
);

ALTER TABLE rehearsal_events ADD CONSTRAINT rehearsal_events_selected_timing_check CHECK (
  (timing_source IS NULL AND timing_at_ms IS NULL AND timing_clock_id IS NULL)
  OR (timing_source IN ('provider-derived', 'server-receipt') AND timing_at_ms IS NOT NULL
    AND timing_at_ms >= 0 AND timing_clock_id IS NOT NULL AND length(btrim(timing_clock_id)) > 0)
);

ALTER TABLE takes ADD CONSTRAINT takes_rehearsal_owner_fk
  FOREIGN KEY (rehearsal_session_id, owner_user_id)
  REFERENCES rehearsal_sessions(id, owner_user_id);

ALTER TABLE takes ADD CONSTRAINT takes_id_owner_rehearsal_unique
  UNIQUE (id, owner_user_id, rehearsal_session_id);

ALTER TABLE rehearsal_events ADD CONSTRAINT rehearsal_events_id_owner_session_unique
  UNIQUE (id, owner_user_id, rehearsal_session_id);

CREATE TABLE cue_response_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  take_id uuid NOT NULL,
  rehearsal_session_id uuid NOT NULL,
  measurement_version text NOT NULL,
  cue_event_id uuid,
  actor_event_id uuid,
  clock_id text,
  delay_ms integer,
  confidence text NOT NULL,
  score integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cue_response_evidence_version_check CHECK (length(btrim(measurement_version)) > 0),
  CONSTRAINT cue_response_evidence_clock_check CHECK (clock_id IS NULL OR length(btrim(clock_id)) > 0),
  CONSTRAINT cue_response_evidence_delay_check CHECK (delay_ms IS NULL OR delay_ms >= 0),
  CONSTRAINT cue_response_evidence_confidence_check CHECK (confidence IN ('high', 'medium', 'low')),
  CONSTRAINT cue_response_evidence_score_check CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  CONSTRAINT cue_response_evidence_qualified_check CHECK (
    (confidence = 'low' AND score IS NULL)
    OR (confidence IN ('high', 'medium') AND score IS NOT NULL AND delay_ms IS NOT NULL
      AND clock_id IS NOT NULL AND cue_event_id IS NOT NULL AND actor_event_id IS NOT NULL)
  ),
  CONSTRAINT cue_response_evidence_take_chain_fk
    FOREIGN KEY (take_id, owner_user_id, rehearsal_session_id)
    REFERENCES takes(id, owner_user_id, rehearsal_session_id) ON DELETE CASCADE,
  CONSTRAINT cue_response_evidence_cue_event_chain_fk
    FOREIGN KEY (cue_event_id, owner_user_id, rehearsal_session_id)
    REFERENCES rehearsal_events(id, owner_user_id, rehearsal_session_id) ON DELETE CASCADE,
  CONSTRAINT cue_response_evidence_actor_event_chain_fk
    FOREIGN KEY (actor_event_id, owner_user_id, rehearsal_session_id)
    REFERENCES rehearsal_events(id, owner_user_id, rehearsal_session_id) ON DELETE CASCADE,
  CONSTRAINT cue_response_evidence_owner_take_version_unique
    UNIQUE (owner_user_id, take_id, measurement_version)
);

CREATE INDEX cue_response_evidence_owner_take_idx
  ON cue_response_evidence (owner_user_id, take_id, measurement_version);
