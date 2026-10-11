DROP INDEX IF EXISTS takes_owner_mode_context_created_idx;
ALTER TABLE takes DROP CONSTRAINT IF EXISTS takes_practice_mode_check;
ALTER TABLE takes DROP COLUMN IF EXISTS audio_deleted_at;
ALTER TABLE takes DROP COLUMN IF EXISTS practice_mode;
ALTER TABLE practice_sessions DROP CONSTRAINT IF EXISTS practice_sessions_practice_mode_check;
ALTER TABLE practice_sessions DROP COLUMN IF EXISTS practice_mode;
