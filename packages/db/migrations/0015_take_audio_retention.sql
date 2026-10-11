ALTER TABLE practice_sessions
  ADD COLUMN practice_mode text NOT NULL DEFAULT 'complete_take';

ALTER TABLE practice_sessions
  ADD CONSTRAINT practice_sessions_practice_mode_check
  CHECK (practice_mode IN ('complete_take', 'guided_exercise'));

ALTER TABLE takes
  ADD COLUMN practice_mode text NOT NULL DEFAULT 'complete_take',
  ADD COLUMN audio_deleted_at timestamptz;

ALTER TABLE takes
  ADD CONSTRAINT takes_practice_mode_check
  CHECK (practice_mode IN ('complete_take', 'guided_exercise'));

CREATE INDEX takes_owner_mode_context_created_idx
  ON takes(owner_user_id, practice_mode, play_model_id, play_model_version, scene_id, role_id, created_at);
