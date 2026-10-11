DROP TABLE IF EXISTS private_object_cleanup_tasks;
DROP TABLE IF EXISTS normalized_audio_artifacts;
DROP TABLE IF EXISTS take_stage_job_chains;
DROP FUNCTION IF EXISTS validate_private_object_cleanup_chain();
DROP FUNCTION IF EXISTS enforce_current_normalized_audio_artifact();
DROP FUNCTION IF EXISTS enforce_current_take_stage_job();
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_id_owner_play_kind_unique;
ALTER TABLE takes DROP CONSTRAINT IF EXISTS takes_id_owner_play_unique;
