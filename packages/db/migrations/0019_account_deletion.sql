ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status text NOT NULL DEFAULT 'active';
ALTER TABLE users ADD CONSTRAINT users_account_status_valid CHECK (account_status IN ('active', 'deleting'));

CREATE TABLE IF NOT EXISTS account_deletions (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  object_inventory jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_deletion_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deletion_id uuid NOT NULL UNIQUE,
  object_count integer NOT NULL,
  completed_at timestamptz NOT NULL
);
