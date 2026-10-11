CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users (email);

CREATE TABLE invite_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invite_tokens_token_hash_unique ON invite_tokens (token_hash);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sessions_token_hash_unique ON sessions (token_hash);
CREATE INDEX sessions_owner_user_id_idx ON sessions (owner_user_id);

CREATE TABLE plays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plays_owner_user_id_idx ON plays (owner_user_id);
CREATE UNIQUE INDEX plays_id_owner_user_id_unique ON plays (id, owner_user_id);

CREATE TABLE source_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  play_id uuid NOT NULL,
  filename text NOT NULL,
  object_key text,
  source_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_files_play_owner_fk FOREIGN KEY (play_id, owner_user_id)
    REFERENCES plays(id, owner_user_id) ON DELETE CASCADE
);
CREATE INDEX source_files_owner_user_id_idx ON source_files (owner_user_id);
CREATE INDEX source_files_play_id_idx ON source_files (play_id);

CREATE TABLE play_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  play_id uuid NOT NULL,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  model jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT play_models_play_owner_fk FOREIGN KEY (play_id, owner_user_id)
    REFERENCES plays(id, owner_user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX play_models_play_version_unique ON play_models (play_id, version);
CREATE INDEX play_models_owner_user_id_idx ON play_models (owner_user_id);

CREATE TABLE analysis_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  play_id uuid NOT NULL,
  kind text NOT NULL,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analysis_artifacts_play_owner_fk FOREIGN KEY (play_id, owner_user_id)
    REFERENCES plays(id, owner_user_id) ON DELETE CASCADE
);
CREATE INDEX analysis_artifacts_owner_user_id_idx ON analysis_artifacts (owner_user_id);
CREATE INDEX analysis_artifacts_play_id_idx ON analysis_artifacts (play_id);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  play_id uuid,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_play_owner_fk FOREIGN KEY (play_id, owner_user_id)
    REFERENCES plays(id, owner_user_id) ON DELETE CASCADE
);
CREATE INDEX jobs_owner_user_id_idx ON jobs (owner_user_id);
CREATE INDEX jobs_status_available_at_idx ON jobs (status, available_at);
