import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";

export type MigrationFile = { name: string; sql: string };
type MigrationTransaction = {
  exec(sql: string): Promise<void>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
};
export type MigrationDatabase = MigrationTransaction & {
  transaction<T>(callback: (transaction: MigrationTransaction) => Promise<T>): Promise<T>;
};

const LEGACY_PLAN_1_MIGRATIONS = [
  "0001_foundation.sql",
  "0002_play_processing_status.sql",
  "0003_reviewable_parse_jobs.sql",
  "0004_job_lease_fencing.sql",
  "0005_grounded_study.sql",
  "0006_current_artifact_uniqueness.sql",
] as const;

export async function discoverMigrationFiles(directory: URL): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(new URL(name, directory), "utf8") })));
}

export async function applyMigrationFiles(database: MigrationDatabase, directory: URL): Promise<string[]> {
  await database.exec(`CREATE TABLE IF NOT EXISTS drama_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const migrations = await discoverMigrationFiles(directory);
  return database.transaction(async (transaction) => {
    const appliedRows = await transaction.query<{ name: string }>("SELECT name FROM drama_migrations");
    const applied = new Set(appliedRows.map(({ name }) => name));
    if (applied.size === 0) {
      const available = new Set(migrations.map(({ name }) => name));
      if (LEGACY_PLAN_1_MIGRATIONS.every((name) => available.has(name)) &&
        await isJournalLessPlan1Database(transaction)) {
        for (const name of LEGACY_PLAN_1_MIGRATIONS) {
          await transaction.query("INSERT INTO drama_migrations (name) VALUES ($1)", [name]);
          applied.add(name);
        }
      }
    }
    const names: string[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.name)) continue;
      await transaction.exec(migration.sql);
      await transaction.query("INSERT INTO drama_migrations (name) VALUES ($1)", [migration.name]);
      names.push(migration.name);
    }
    return names;
  });
}

async function isJournalLessPlan1Database(transaction: MigrationTransaction): Promise<boolean> {
  const [state] = await transaction.query<{
    foundation_complete: boolean;
    processing_status_complete: boolean;
    reviewable_jobs_complete: boolean;
    lease_fencing_complete: boolean;
    grounded_study_complete: boolean;
    artifact_uniqueness_complete: boolean;
    practice_schema_absent: boolean;
  }>(`SELECT
    (SELECT count(*) = 8 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN
        ('users', 'invite_tokens', 'sessions', 'plays', 'source_files', 'play_models',
         'analysis_artifacts', 'jobs')) AND
      (SELECT count(*) = 2 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN ('users_email_unique', 'plays_id_owner_user_id_unique'))
      AS foundation_complete,
    EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'plays' AND column_name = 'status')
      AS processing_status_complete,
    (SELECT count(*) = 8 FROM information_schema.columns
      WHERE table_schema = 'public' AND
        (table_name, column_name) IN
          (('play_models', 'issues'), ('play_models', 'source_job_dedupe_key'),
           ('analysis_artifacts', 'status'), ('jobs', 'attempt_count'), ('jobs', 'dedupe_key'),
           ('jobs', 'lease_expires_at'), ('jobs', 'error_code'), ('jobs', 'result_play_model_version_id'))) AND
      (SELECT count(*) = 3 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN
          ('play_models_source_job_dedupe_key_unique', 'jobs_dedupe_key_unique', 'jobs_claimable_idx'))
      AS reviewable_jobs_complete,
    EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'lease_token') AND
      EXISTS (SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'jobs_active_lease_idx')
      AS lease_fencing_complete,
    (SELECT count(*) = 4 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'analysis_artifacts' AND column_name IN
        ('prompt_version', 'model_name', 'play_model_version', 'generated_at')) AND
      EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'actor_notes') AND
      EXISTS (SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'actor_notes_owner_play_character_unique')
      AS grounded_study_complete,
    EXISTS (SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'analysis_artifacts_one_current_kind_unique')
      AS artifact_uniqueness_complete,
    NOT EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('practice_sessions', 'takes', 'take_events'))
      AS practice_schema_absent`);
  return Boolean(state && Object.values(state).every(Boolean));
}

export async function migrateDatabase(databaseUrl = process.env.DATABASE_URL,
  directory = new URL("../migrations/", import.meta.url)): Promise<string[]> {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const client = postgres(databaseUrl, { max: 1 });
  const database: MigrationDatabase = {
    exec: async (sql) => { await client.unsafe(sql); },
    query: async <T>(sql: string, params: unknown[] = []) =>
      Array.from(await client.unsafe(sql, params as never[])) as T[],
    transaction: async <T>(callback: (transaction: MigrationTransaction) => Promise<T>) =>
      await client.begin(async (transaction) => callback({
        exec: async (sql) => { await transaction.unsafe(sql); },
        query: async <TRow>(sql: string, params: unknown[] = []) =>
          Array.from(await transaction.unsafe(sql, params as never[])) as TRow[],
      })) as T,
  };
  try {
    return await applyMigrationFiles(database, directory);
  } finally {
    await client.end();
  }
}
