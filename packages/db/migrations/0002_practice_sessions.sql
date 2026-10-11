CREATE UNIQUE INDEX play_models_id_owner_user_id_unique
  ON play_models (id, owner_user_id);

CREATE TABLE practice_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  play_id uuid NOT NULL,
  play_model_id uuid NOT NULL,
  play_model_version integer NOT NULL,
  scene_id text NOT NULL,
  role_id text NOT NULL,
  selected_interpretation text,
  retention_choice text NOT NULL CHECK (retention_choice IN ('retain', 'delete_after_analysis')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT practice_sessions_play_owner_fk FOREIGN KEY (play_id, owner_user_id)
    REFERENCES plays(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT practice_sessions_model_owner_fk FOREIGN KEY (play_model_id, owner_user_id)
    REFERENCES play_models(id, owner_user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX practice_sessions_id_owner_user_id_unique
  ON practice_sessions (id, owner_user_id);
CREATE INDEX practice_sessions_owner_play_idx
  ON practice_sessions (owner_user_id, play_id);

CREATE TABLE takes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  practice_session_id uuid NOT NULL,
  play_id uuid NOT NULL,
  play_model_id uuid NOT NULL,
  play_model_version integer NOT NULL,
  scene_id text NOT NULL,
  role_id text NOT NULL,
  selected_interpretation text,
  retention_choice text NOT NULL CHECK (retention_choice IN ('retain', 'delete_after_analysis')),
  duration_ms integer NOT NULL CHECK (duration_ms > 0 AND duration_ms <= 1200000),
  media_type text NOT NULL CHECK (media_type IN ('audio/webm', 'audio/wav')),
  object_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('uploading', 'queued', 'processing', 'completed',
    'action_required', 'completed_with_limitations')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT takes_session_owner_fk FOREIGN KEY (practice_session_id, owner_user_id)
    REFERENCES practice_sessions(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT takes_play_owner_fk FOREIGN KEY (play_id, owner_user_id)
    REFERENCES plays(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT takes_model_owner_fk FOREIGN KEY (play_model_id, owner_user_id)
    REFERENCES play_models(id, owner_user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX takes_id_owner_user_id_unique ON takes (id, owner_user_id);
CREATE UNIQUE INDEX takes_object_key_unique ON takes (object_key);
CREATE INDEX takes_owner_play_state_idx ON takes (owner_user_id, play_id, state);

CREATE TABLE take_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  take_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('uploading', 'queued', 'processing', 'completed',
    'action_required', 'completed_with_limitations')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT take_events_take_owner_fk FOREIGN KEY (take_id, owner_user_id)
    REFERENCES takes(id, owner_user_id) ON DELETE CASCADE
);
CREATE INDEX take_events_owner_take_idx ON take_events (owner_user_id, take_id, created_at);
