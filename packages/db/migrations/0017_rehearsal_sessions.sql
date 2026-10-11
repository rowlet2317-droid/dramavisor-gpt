CREATE TABLE IF NOT EXISTS rehearsal_sessions (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  play_id uuid NOT NULL,
  play_model_id uuid NOT NULL,
  play_model_version integer NOT NULL,
  scene_id text NOT NULL,
  actor_role_id text NOT NULL,
  model text NOT NULL,
  grant_expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'grant_issued',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rehearsal_sessions_play_owner_fk FOREIGN KEY (play_id, owner_user_id)
    REFERENCES plays(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT rehearsal_sessions_model_owner_fk FOREIGN KEY (play_model_id, owner_user_id)
    REFERENCES play_models(id, owner_user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS rehearsal_sessions_id_owner_user_id_unique
  ON rehearsal_sessions (id, owner_user_id);
CREATE INDEX IF NOT EXISTS rehearsal_sessions_owner_play_idx
  ON rehearsal_sessions (owner_user_id, play_id);
