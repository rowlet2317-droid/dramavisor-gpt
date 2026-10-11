ALTER TABLE jobs
  ADD COLUMN lease_token uuid;

CREATE INDEX jobs_active_lease_idx
  ON jobs (owner_user_id, id, attempt_count, lease_token)
  WHERE status = 'running';
