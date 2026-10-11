ALTER TABLE analysis_artifacts
  ADD COLUMN prompt_version text,
  ADD COLUMN model_name text,
  ADD COLUMN play_model_version integer,
  ADD COLUMN generated_at timestamptz;

CREATE INDEX analysis_artifacts_current_kind_idx
  ON analysis_artifacts (owner_user_id, play_id, kind)
  WHERE status = 'current';

CREATE TABLE actor_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  play_id uuid NOT NULL,
  character_id text NOT NULL,
  notes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT actor_notes_play_owner_fk FOREIGN KEY (play_id, owner_user_id)
    REFERENCES plays(id, owner_user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX actor_notes_owner_play_character_unique
  ON actor_notes (owner_user_id, play_id, character_id);
