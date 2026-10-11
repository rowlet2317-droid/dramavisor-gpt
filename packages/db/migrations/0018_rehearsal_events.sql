CREATE TABLE IF NOT EXISTS rehearsal_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rehearsal_session_id uuid NOT NULL,
  sequence integer NOT NULL,
  type text NOT NULL,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rehearsal_events_session_owner_fk
    FOREIGN KEY (rehearsal_session_id, owner_user_id)
    REFERENCES rehearsal_sessions(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT rehearsal_events_sequence_positive CHECK (sequence > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rehearsal_events_session_sequence_unique
  ON rehearsal_events (owner_user_id, rehearsal_session_id, sequence);
CREATE INDEX IF NOT EXISTS rehearsal_events_owner_session_idx
  ON rehearsal_events (owner_user_id, rehearsal_session_id, sequence);

CREATE TABLE IF NOT EXISTS character_voice_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rehearsal_session_id uuid NOT NULL,
  character_id text NOT NULL,
  voice text NOT NULL,
  engine text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT character_voice_assignments_session_owner_fk
    FOREIGN KEY (rehearsal_session_id, owner_user_id)
    REFERENCES rehearsal_sessions(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT character_voice_assignments_engine_valid CHECK (engine IN ('realtime', 'tts'))
);

CREATE UNIQUE INDEX IF NOT EXISTS character_voice_assignments_session_character_unique
  ON character_voice_assignments (owner_user_id, rehearsal_session_id, character_id);
CREATE INDEX IF NOT EXISTS character_voice_assignments_owner_session_idx
  ON character_voice_assignments (owner_user_id, rehearsal_session_id);
