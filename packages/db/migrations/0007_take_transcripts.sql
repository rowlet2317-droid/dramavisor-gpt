CREATE TABLE take_transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  take_id uuid NOT NULL,
  audio_sha256 text NOT NULL,
  transcriber_version text NOT NULL,
  provider text NOT NULL,
  model_name text NOT NULL,
  language text NOT NULL,
  text text NOT NULL,
  timing_source text NOT NULL,
  status text NOT NULL DEFAULT 'current',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT take_transcripts_take_owner_fk FOREIGN KEY (take_id, owner_user_id)
    REFERENCES takes(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT take_transcripts_id_owner_unique UNIQUE (id, owner_user_id),
  CONSTRAINT take_transcripts_dedupe_unique UNIQUE
    (owner_user_id, take_id, audio_sha256, transcriber_version)
);

CREATE UNIQUE INDEX take_transcripts_one_current_take_unique
  ON take_transcripts(owner_user_id, take_id) WHERE status = 'current';
CREATE INDEX take_transcripts_owner_take_idx ON take_transcripts(owner_user_id, take_id);

CREATE TABLE transcript_words (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transcript_id uuid NOT NULL,
  ordinal integer NOT NULL,
  text text NOT NULL,
  start_ms integer NOT NULL,
  end_ms integer NOT NULL,
  confidence real,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transcript_words_transcript_owner_fk FOREIGN KEY (transcript_id, owner_user_id)
    REFERENCES take_transcripts(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT transcript_words_owner_ordinal_unique UNIQUE (owner_user_id, transcript_id, ordinal)
);

CREATE TABLE line_alignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transcript_id uuid NOT NULL,
  element_id text NOT NULL,
  transcript_start_ms integer,
  transcript_end_ms integer,
  similarity real NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT line_alignments_transcript_owner_fk FOREIGN KEY (transcript_id, owner_user_id)
    REFERENCES take_transcripts(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT line_alignments_owner_element_unique UNIQUE (owner_user_id, transcript_id, element_id)
);

CREATE TABLE transcript_uncertainty_regions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transcript_id uuid NOT NULL,
  ordinal integer NOT NULL,
  element_id text NOT NULL,
  start_ms integer,
  end_ms integer,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transcript_uncertainty_regions_transcript_owner_fk FOREIGN KEY (transcript_id, owner_user_id)
    REFERENCES take_transcripts(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT transcript_uncertainty_regions_owner_ordinal_unique UNIQUE
    (owner_user_id, transcript_id, ordinal)
);
