DROP TABLE IF EXISTS account_deletion_audits;
DROP TABLE IF EXISTS account_deletions;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_status_valid;
ALTER TABLE users DROP COLUMN IF EXISTS account_status;
