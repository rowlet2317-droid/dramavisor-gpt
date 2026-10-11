import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const baselineMigrations = [
  "0001_foundation.sql",
  "0002_play_processing_status.sql",
  "0002_practice_sessions.sql",
  "0003_reviewable_parse_jobs.sql",
  "0004_job_lease_fencing.sql",
  "0005_grounded_study.sql",
  "0006_current_artifact_uniqueness.sql",
  "0007_take_transcripts.sql",
  "0008_ordered_transcript_evidence.sql",
] as const;
const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";
const playId = "33333333-3333-4333-8333-333333333333";
const modelId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
const takeA = "66666666-6666-4666-8666-666666666666";
const takeB = "77777777-7777-4777-8777-777777777777";
const transcriptA = "88888888-8888-4888-8888-888888888888";
const transcriptB = "99999999-9999-4999-8999-999999999999";

describe("take metrics migration", () => {
  let client: PGlite;

  beforeEach(async () => {
    client = new PGlite();
    await applyBaseline(client);
    await seedArtifactChains(client);
  });

  afterEach(async () => client.close());

  it("upgrades existing transcript data and enforces the complete owner/take/transcript chain", async () => {
    // Break caught: metrics linked only by transcript id can cross owner or take boundaries.
    await client.exec(await migration("0009_take_metrics.sql"));

    const tables = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('take_metrics', 'take_metric_lines')
      ORDER BY table_name
    `);
    expect(tables.rows.map(({ table_name }) => table_name)).toEqual(["take_metric_lines", "take_metrics"]);
    expect(await count(client, "take_transcripts")).toBe(2);

    const metricId = await insertMetric(client, ownerA, takeA, transcriptA);
    await client.query(`INSERT INTO take_metric_lines
      (owner_user_id, take_metric_id, transcript_id, element_id, start_ms, end_ms,
       speech_duration_ms, silence_duration_ms, rms_db)
      VALUES ($1, $2, $3, 'line-a', 0, 1000, 800, 200, -18)`, [ownerA, metricId, transcriptA]);
    await expect(client.query(`DELETE FROM line_alignments
      WHERE owner_user_id = $1 AND transcript_id = $2 AND element_id = 'line-a'`, [ownerA, transcriptA]))
      .rejects.toMatchObject({ code: "23503" });

    await expect(insertMetric(client, ownerB, takeA, transcriptA, "owner-cross"))
      .rejects.toMatchObject({ code: "23503" });
    await expect(insertMetric(client, ownerA, takeA, transcriptB, "take-cross"))
      .rejects.toMatchObject({ code: "23503" });
    await expect(client.query(`INSERT INTO take_metric_lines
      (owner_user_id, take_metric_id, transcript_id, element_id, start_ms, end_ms,
       speech_duration_ms, silence_duration_ms, rms_db)
      VALUES ($1, $2, $3, 'line-b', 0, 1000, 800, 200, -18)`, [ownerA, metricId, transcriptB]))
      .rejects.toMatchObject({ code: "23503" });
  });

  it("deduplicates a measurement version and follows transcript promotion state", async () => {
    // Break caught: retries or stale transcript publication can create two competing current measurements.
    await client.exec(await migration("0009_take_metrics.sql"));
    await expect(insertMetric(client, ownerA, takeA, transcriptA, "  "))
      .rejects.toMatchObject({ code: "23514" });
    await insertMetric(client, ownerA, takeA, transcriptA);

    await expect(insertMetric(client, ownerA, takeA, transcriptA))
      .rejects.toMatchObject({ code: "23505" });
    await client.query("UPDATE take_transcripts SET status = 'stale' WHERE id = $1", [transcriptA]);
    expect((await client.query<{ transcript_status: string }>(
      "SELECT transcript_status FROM take_metrics WHERE transcript_id = $1", [transcriptA],
    )).rows).toEqual([{ transcript_status: "stale" }]);
    await expect(insertMetric(client, ownerA, takeA, transcriptA, "measure-v2"))
      .rejects.toMatchObject({ code: "23503" });
    await expect(client.query(`INSERT INTO take_metrics
      (owner_user_id, take_id, transcript_id, transcript_status, measurement_version, metrics)
      VALUES ($1, $2, $3, 'stale', 'measure-v2', '{}')`, [ownerA, takeA, transcriptA]))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("rolls the schema back without removing existing transcript evidence", async () => {
    // Break caught: a rollback that drops or corrupts prerequisite transcript evidence is not reversible.
    await client.exec(await migration("0009_take_metrics.sql"));
    await insertMetric(client, ownerA, takeA, transcriptA);

    await client.exec(await readFile(new URL("../migrations/down/0009_take_metrics.sql", import.meta.url), "utf8"));

    expect(await count(client, "take_transcripts")).toBe(2);
    const tables = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('take_metrics', 'take_metric_lines')
    `);
    expect(tables.rows).toEqual([]);
  });

  it("leaves no partial schema when the migration transaction rolls back", async () => {
    // Break caught: a failed deploy must not strand half of the measurement schema.
    await expect(client.transaction(async (transaction) => {
      await transaction.exec(await migration("0009_take_metrics.sql"));
      throw new Error("force rollback");
    })).rejects.toThrow("force rollback");

    const tables = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('take_metrics', 'take_metric_lines')
    `);
    expect(tables.rows).toEqual([]);
  });
});

async function applyBaseline(client: PGlite) {
  for (const name of baselineMigrations) await client.exec(await migration(name));
}

async function migration(name: string) {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

async function seedArtifactChains(client: PGlite) {
  await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, 'a@example.com', 'a'), ($2, 'b@example.com', 'b')", [ownerA, ownerB]);
  await client.query("INSERT INTO plays (id, owner_user_id, title) VALUES ($1, $2, 'Private Play')",
    [playId, ownerA]);
  await client.query(`INSERT INTO play_models
    (id, owner_user_id, play_id, version, status, model) VALUES ($1, $2, $3, 1, 'approved', '{}')`,
  [modelId, ownerA, playId]);
  await client.query(`INSERT INTO practice_sessions
    (id, owner_user_id, play_id, play_model_id, play_model_version, scene_id, role_id, retention_choice)
    VALUES ($1, $2, $3, $4, 1, 'scene-1', 'role-1', 'retain')`,
  [sessionId, ownerA, playId, modelId]);
  await client.query(`INSERT INTO takes
    (id, owner_user_id, practice_session_id, play_id, play_model_id, play_model_version, scene_id, role_id,
     retention_choice, duration_ms, media_type, object_key, state)
    VALUES ($1, $2, $3, $4, $5, 1, 'scene-1', 'role-1', 'retain', 1000, 'audio/wav', 'take-a', 'processing'),
           ($6, $2, $3, $4, $5, 1, 'scene-1', 'role-1', 'retain', 1000, 'audio/wav', 'take-b', 'processing')`,
  [takeA, ownerA, sessionId, playId, modelId, takeB]);
  await client.query(`INSERT INTO take_transcripts
    (id, owner_user_id, take_id, audio_sha256, transcriber_version, provider, model_name, language, text,
     timing_source, status)
    VALUES ($1, $2, $3, 'hash-a', 'transcribe-v1', 'fake', 'fake', 'en', 'A', 'whisper_word_timestamps', 'current'),
           ($4, $2, $5, 'hash-b', 'transcribe-v1', 'fake', 'fake', 'en', 'B', 'whisper_word_timestamps', 'current')`,
  [transcriptA, ownerA, takeA, transcriptB, takeB]);
  await client.query(`INSERT INTO line_alignments
    (owner_user_id, transcript_id, element_id, script_ordinal, transcript_start_ms, transcript_end_ms,
     similarity, status)
    VALUES ($1, $2, 'line-a', 1, 0, 1000, 1, 'matched'),
           ($1, $3, 'line-b', 1, 0, 1000, 1, 'matched')`, [ownerA, transcriptA, transcriptB]);
}

async function insertMetric(client: PGlite, ownerUserId: string, takeId: string, transcriptId: string,
  measurementVersion = "measure-v1") {
  const result = await client.query<{ id: string }>(`INSERT INTO take_metrics
    (owner_user_id, take_id, transcript_id, transcript_status, measurement_version, metrics)
    VALUES ($1, $2, $3, 'current', $4, '{}') RETURNING id`,
  [ownerUserId, takeId, transcriptId, measurementVersion]);
  return result.rows[0]!.id;
}

async function count(client: PGlite, table: string) {
  const result = await client.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}`);
  return result.rows[0]!.count;
}
