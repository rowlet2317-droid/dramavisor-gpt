DELETE FROM job_lease_attempt_history WHERE play_id IS NULL;
ALTER TABLE job_lease_attempt_history
  ALTER COLUMN play_id SET NOT NULL;
