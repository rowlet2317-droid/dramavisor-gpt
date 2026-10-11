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
  "0009_take_metrics.sql",
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
const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const leaseToken = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const leaseToken2 = "abababab-abab-4bab-8bab-abababababab";
const measureJobA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const measureJobB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const otherProcessJob = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const reviewJob = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const attemptedTranscript = "12121212-1212-4212-8212-121212121212";

describe("normalized audio artifact migration", () => {
  let client: PGlite;

  beforeEach(async () => {
    client = new PGlite();
    for (const name of baselineMigrations) await client.exec(await migration(name));
    await seedArtifactChains(client);
  });

  afterEach(async () => client.close());

  it("binds a deterministic canonical object to the exact owner/play/take/transcript chain", async () => {
    // Break caught: application-only checks allow an artifact to point at another actor or take.
    await client.exec(await migration("0010_normalized_audio_artifacts.sql"));
    await insertArtifact(client, ownerA, playId, takeA, transcriptA, canonicalKey(transcriptA));

    await expect(client.query(`UPDATE normalized_audio_artifacts
      SET storage_version_token = 'version:retargeted' WHERE transcript_id = $1`, [transcriptA]))
      .rejects.toMatchObject({ code: "23514" });

    await expect(insertArtifact(client, ownerB, playId, takeA, transcriptA,
      `users/${ownerB}/plays/${playId}/takes/${takeA}/transcripts/${transcriptA}/normalized.wav`))
      .rejects.toMatchObject({ code: "23503" });
    await expect(insertArtifact(client, ownerA, playId, takeA, transcriptB, canonicalKey(transcriptB)))
      .rejects.toMatchObject({ code: "23503" });
    await expect(insertArtifact(client, ownerA, playId, takeA, transcriptA,
      `users/${ownerA}/plays/${playId}/takes/${takeA}/normalized.wav`, "version:wrong-key"))
      .rejects.toMatchObject({ code: "23514" });
    await expect(insertArtifact(client, ownerA, playId, takeA, transcriptA, canonicalKey(transcriptA),
      "version:duplicate"))
      .rejects.toMatchObject({ code: "23505" });

    await client.query("UPDATE take_transcripts SET status = 'stale' WHERE id = $1", [transcriptA]);
    expect((await client.query<{ transcript_status: string }>(
      "SELECT transcript_status FROM normalized_audio_artifacts WHERE transcript_id = $1", [transcriptA],
    )).rows).toEqual([{ transcript_status: "stale" }]);
  });

  it("deduplicates cleanup work by the exact attempt, object, and written storage version", async () => {
    // Break caught: cleanup retries can otherwise target an object version written by a winning attempt.
    await client.exec(await migration("0010_normalized_audio_artifacts.sql"));
    await insertTakeOnlyStage(client, jobId, takeA, "process_take");
    const values = [ownerA, playId, takeA, transcriptA, jobId, 1, leaseToken,
      `${canonicalKey(transcriptA)}.staging/${leaseToken}`, "version:attempt-1"];
    await insertCleanup(client, values);
    await expect(insertCleanup(client, values)).rejects.toMatchObject({ code: "23505" });
    await expect(client.query(`UPDATE private_object_cleanup_tasks
      SET storage_version_token = 'version:retargeted' WHERE source_job_id = $1`, [jobId]))
      .rejects.toMatchObject({ code: "23514" });

    await expect(insertCleanup(client, [ownerA, playId, takeA, transcriptB, jobId, 1, leaseToken,
      `${canonicalKey(transcriptA)}.staging/${leaseToken}`, "version:attempt-1"]))
      .rejects.toMatchObject({ code: "23503" });
    await expect(insertCleanup(client, [ownerB, playId, takeA, transcriptA, jobId, 1, leaseToken,
      `${canonicalKey(transcriptA)}.staging/${leaseToken}`, "version:attempt-1"]))
      .rejects.toMatchObject({ code: "23503" });
    await expect(insertCleanup(client, [ownerA, playId, takeA, transcriptA, jobId, 1, leaseToken,
      `users/${ownerB}/plays/${playId}/takes/${takeA}/staging.wav`, "version:foreign-object"]))
      .rejects.toMatchObject({ code: "23514" });

    await expect(insertCleanup(client, [ownerA, playId, takeA, transcriptA, jobId, 2, leaseToken,
      `${canonicalKey(transcriptA)}.staging/${leaseToken}`, "version:wrong-attempt"]))
      .rejects.toMatchObject({ code: "23503" });
    await client.query("UPDATE jobs SET attempt_count = 2, lease_token = $1 WHERE id = $2",
      [leaseToken2, jobId]);

    await insertCleanup(client, [ownerA, playId, takeA, transcriptA, jobId, 2, leaseToken2,
      `${canonicalKey(transcriptA)}.staging/${leaseToken2}`, "version:attempt-1"]);
    await insertCleanup(client, [ownerA, playId, takeA, transcriptA, jobId, 2, leaseToken2,
      `${canonicalKey(transcriptA)}.staging/${leaseToken2}`, "version:attempt-2"]);
    expect(await count(client, "private_object_cleanup_tasks")).toBe(3);
  });

  it("binds job kind and deduplicates an exact owner/take/transcript/stage chain", async () => {
    // Break caught: a process job could masquerade as measurement or duplicate the same exact stage publication.
    await client.exec(await migration("0010_normalized_audio_artifacts.sql"));
    await client.query(`INSERT INTO jobs
      (id, owner_user_id, play_id, kind, status, dedupe_key)
      VALUES ($1, $2, $3, 'measure_take', 'queued', 'measure:valid'),
             ($4, $2, $3, 'measure_take', 'queued', 'measure:duplicate'),
             ($5, $2, $3, 'audio_review', 'queued', 'audio-review:valid')`,
    [measureJobA, ownerA, playId, measureJobB, reviewJob]);

    await expect(client.query(`INSERT INTO take_stage_job_chains
      (job_id, owner_user_id, play_id, take_id, transcript_id, transcript_status, stage_kind)
      VALUES ($1, $2, $3, $4, $5, 'current', 'measure_take')`,
    [jobId, ownerA, playId, takeA, transcriptA])).rejects.toMatchObject({ code: "23503" });
    await client.query(`INSERT INTO take_stage_job_chains
      (job_id, owner_user_id, play_id, take_id, transcript_id, transcript_status, stage_kind)
      VALUES ($1, $2, $3, $4, $5, 'current', 'measure_take')`,
    [measureJobA, ownerA, playId, takeA, transcriptA]);
    await expect(client.query(`INSERT INTO take_stage_job_chains
      (job_id, owner_user_id, play_id, take_id, transcript_id, transcript_status, stage_kind)
      VALUES ($1, $2, $3, $4, $5, 'current', 'measure_take')`,
    [measureJobB, ownerA, playId, takeA, transcriptA])).rejects.toMatchObject({ code: "23505" });
    await client.query(`INSERT INTO take_stage_job_chains
      (job_id, owner_user_id, play_id, take_id, transcript_id, transcript_status, stage_kind)
      VALUES ($1, $2, $3, $4, $5, 'current', 'audio_review')`,
    [reviewJob, ownerA, playId, takeA, transcriptA]);

    await expect(client.query(`INSERT INTO take_stage_job_chains
      (job_id, owner_user_id, play_id, take_id, transcript_id, transcript_status, stage_kind)
      VALUES ($1, $2, $3, $4, $5, 'current', 'measure_take')`,
    [measureJobB, ownerA, playId, takeA, transcriptB])).rejects.toMatchObject({ code: "23503" });
    await expect(client.query(`INSERT INTO take_stage_job_chains
      (job_id, owner_user_id, play_id, take_id, transcript_id, transcript_status, stage_kind)
      VALUES ($1, $2, $3, $4, NULL, NULL, 'measure_take')`,
    [measureJobB, ownerA, playId, takeA])).rejects.toMatchObject({ code: "23514" });
    await client.query("UPDATE take_transcripts SET status = 'stale' WHERE id = $1", [transcriptA]);
    await expect(client.query(`INSERT INTO take_stage_job_chains
      (job_id, owner_user_id, play_id, take_id, transcript_id, transcript_status, stage_kind)
      VALUES ($1, $2, $3, $4, $5, 'stale', 'measure_take')`,
    [measureJobB, ownerA, playId, takeA, transcriptA])).rejects.toMatchObject({ code: "23514" });
  });

  it("records cleanup after an attempted transcript transaction rolls back", async () => {
    // Break caught: cleanup journaling must not require evidence that vanished with the failed DB transaction.
    await client.exec(await migration("0010_normalized_audio_artifacts.sql"));
    await insertTakeOnlyStage(client, jobId, takeA, "process_take");
    await expect(client.transaction(async (transaction) => {
      await transaction.query("UPDATE take_transcripts SET status = 'stale' WHERE id = $1", [transcriptA]);
      await transaction.query(`INSERT INTO take_transcripts
        (id, owner_user_id, take_id, audio_sha256, transcriber_version, provider, model_name, language, text,
         timing_source, status)
        VALUES ($1, $2, $3, 'attempt-hash', 'transcribe-v2', 'fake', 'fake', 'en', 'attempt',
          'whisper_word_timestamps', 'current')`, [attemptedTranscript, ownerA, takeA]);
      throw new Error("handoff rollback");
    })).rejects.toThrow("handoff rollback");
    expect((await client.query("SELECT id FROM take_transcripts WHERE id = $1", [attemptedTranscript])).rows)
      .toEqual([]);

    await insertCleanup(client, [ownerA, playId, takeA, attemptedTranscript, jobId, 1, leaseToken,
      `${canonicalKey(attemptedTranscript)}.staging/${leaseToken}`, "version:attempted"], "attempted");
    expect((await client.query<{ transcript_status: string }>(`
      SELECT transcript_status FROM private_object_cleanup_tasks WHERE transcript_id = $1`,
    [attemptedTranscript])).rows).toEqual([{ transcript_status: "attempted" }]);
  });

  it("rejects cleanup attribution to an unrelated same-play job", async () => {
    // Break caught: owner/play-only job checks let one take's worker target another take's object.
    await client.exec(await migration("0010_normalized_audio_artifacts.sql"));
    await client.query(`INSERT INTO jobs
      (id, owner_user_id, play_id, kind, status, dedupe_key, attempt_count, lease_token)
      VALUES ($1, $2, $3, 'process_take', 'running', 'process:other', 1, $4)`,
    [otherProcessJob, ownerA, playId, leaseToken]);
    await insertTakeOnlyStage(client, otherProcessJob, takeB, "process_take");

    await expect(insertCleanup(client, [ownerA, playId, takeA, transcriptA, otherProcessJob, 1, leaseToken,
      `${canonicalKey(transcriptA)}.staging/${leaseToken}`, "version:unrelated"]))
      .rejects.toMatchObject({ code: "23503" });
  });

  it("cascades the artifact but preserves pending cleanup after transcript, take, and owner deletion", async () => {
    // Break caught: FK cascades can silently erase the only record of an external object that still needs deletion.
    await client.exec(await migration("0010_normalized_audio_artifacts.sql"));
    await insertTakeOnlyStage(client, jobId, takeA, "process_take");
    await insertArtifact(client, ownerA, playId, takeA, transcriptA, canonicalKey(transcriptA));
    await insertCleanup(client, [ownerA, playId, takeA, transcriptA, jobId, 1, leaseToken,
      `${canonicalKey(transcriptA)}.staging/${leaseToken}`, "version:attempt-1"]);

    await client.query("DELETE FROM take_transcripts WHERE id = $1", [transcriptA]);

    expect(await count(client, "normalized_audio_artifacts")).toBe(0);
    expect(await count(client, "private_object_cleanup_tasks")).toBe(1);
    await client.query("DELETE FROM takes WHERE id = $1", [takeA]);
    expect(await count(client, "private_object_cleanup_tasks")).toBe(1);
    await client.query("DELETE FROM users WHERE id = $1", [ownerA]);
    expect(await count(client, "private_object_cleanup_tasks")).toBe(1);
    await client.query("UPDATE private_object_cleanup_tasks SET status = 'completed'");
    expect((await client.query<{ status: string }>(
      "SELECT status FROM private_object_cleanup_tasks",
    )).rows).toEqual([{ status: "completed" }]);
  });

  it("rolls back without removing transcript or metric evidence", async () => {
    await client.exec(await migration("0010_normalized_audio_artifacts.sql"));
    await insertArtifact(client, ownerA, playId, takeA, transcriptA, canonicalKey(transcriptA));

    await client.exec(await readFile(
      new URL("../migrations/down/0010_normalized_audio_artifacts.sql", import.meta.url), "utf8"));

    expect(await count(client, "take_transcripts")).toBe(2);
    expect(await count(client, "take_metrics")).toBe(0);
    expect(await artifactTables(client)).toEqual([]);
  });

  it("restores the 0011 cleanup validator when rolling back only 0012", async () => {
    // Break caught: dropping lease history without restoring the validator leaves cleanup inserts referencing a missing table.
    await client.exec(await migration("0010_normalized_audio_artifacts.sql"));
    await client.exec(await migration("0011_stale_attempt_cleanup.sql"));
    await client.exec(await migration("0012_cleanup_attempt_history.sql"));
    await insertTakeOnlyStage(client, jobId, takeA, "process_take");

    await client.exec(await readFile(
      new URL("../migrations/down/0012_cleanup_attempt_history.sql", import.meta.url), "utf8"));

    await insertCleanup(client, [ownerA, playId, takeA, transcriptA, jobId, 1, leaseToken,
      `${canonicalKey(transcriptA)}.rollback/${leaseToken}`, "version:rollback"]);
    await expect(insertCleanup(client, [ownerA, playId, takeA, transcriptA, jobId, 2, leaseToken,
      `${canonicalKey(transcriptA)}.rollback/${leaseToken}`, "version:wrong-attempt"]))
      .rejects.toMatchObject({ code: "23503" });
  });

  it("upgrades 0013 with populated legacy normalized audio artifacts", async () => {
    // Break caught: an attempt-only 0013 constraint rejects exact legacy keys already stored by 0010.
    await client.exec(await migration("0010_normalized_audio_artifacts.sql"));
    await client.exec(await migration("0011_stale_attempt_cleanup.sql"));
    await client.exec(await migration("0012_cleanup_attempt_history.sql"));
    await insertArtifact(client, ownerA, playId, takeA, transcriptA, canonicalKey(transcriptA));

    await client.exec(await migration("0013_immutable_normalized_audio_keys.sql"));

    const immutableKey = `users/${ownerA}/plays/${playId}/takes/${takeB}`
      + `/transcripts/${transcriptB}/normalized/${leaseToken2}.wav`;
    await insertArtifact(client, ownerA, playId, takeB, transcriptB, immutableKey, "version:artifact-2");

    expect((await client.query<{ canonical_object_key: string }>(`
      SELECT canonical_object_key FROM normalized_audio_artifacts ORDER BY canonical_object_key`)).rows)
      .toEqual([
        { canonical_object_key: canonicalKey(transcriptA) },
        { canonical_object_key: immutableKey },
      ]);
  });

  it("rolls back 0013 with populated immutable normalized audio artifacts", async () => {
    // Break caught: restoring legacy-only equality invalidates immutable attempt keys written after 0013.
    await client.exec(await migration("0010_normalized_audio_artifacts.sql"));
    await client.exec(await migration("0011_stale_attempt_cleanup.sql"));
    await client.exec(await migration("0012_cleanup_attempt_history.sql"));
    await client.exec(await migration("0013_immutable_normalized_audio_keys.sql"));
    const immutableKey = `users/${ownerA}/plays/${playId}/takes/${takeA}`
      + `/transcripts/${transcriptA}/normalized/${leaseToken}.wav`;
    await insertArtifact(client, ownerA, playId, takeA, transcriptA, immutableKey);

    await client.exec(await readFile(
      new URL("../migrations/down/0013_immutable_normalized_audio_keys.sql", import.meta.url), "utf8"));

    const legacyKey = `users/${ownerA}/plays/${playId}/takes/${takeB}`
      + `/transcripts/${transcriptB}/normalized.wav`;
    await insertArtifact(client, ownerA, playId, takeB, transcriptB, legacyKey, "version:artifact-2");

    expect((await client.query<{ canonical_object_key: string }>(`
      SELECT canonical_object_key FROM normalized_audio_artifacts ORDER BY canonical_object_key`)).rows)
      .toEqual([
        { canonical_object_key: immutableKey },
        { canonical_object_key: legacyKey },
      ]);
  });

  it("leaves no partial artifact schema when the migration transaction rolls back", async () => {
    await expect(client.transaction(async (transaction) => {
      await transaction.exec(await migration("0010_normalized_audio_artifacts.sql"));
      throw new Error("force rollback");
    })).rejects.toThrow("force rollback");

    expect(await artifactTables(client)).toEqual([]);
  });
});

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
  await client.query(`INSERT INTO jobs
    (id, owner_user_id, play_id, kind, status, attempt_count, lease_token, lease_expires_at)
    VALUES ($1, $2, $3, 'process_take', 'running', 1, $4, now() + interval '5 minutes')`,
  [jobId, ownerA, playId, leaseToken]);
}

function canonicalKey(transcriptId: string) {
  return `users/${ownerA}/plays/${playId}/takes/${takeA}/transcripts/${transcriptId}/normalized.wav`;
}

async function insertArtifact(client: PGlite, ownerUserId: string, targetPlayId: string, takeId: string,
  transcriptId: string, objectKey: string, versionToken = "version:artifact-1") {
  return client.query(`INSERT INTO normalized_audio_artifacts
    (owner_user_id, play_id, take_id, transcript_id, transcript_status, canonical_object_key,
     content_sha256, storage_version_token)
    VALUES ($1, $2, $3, $4, 'current', $5, $6, $7)`,
  [ownerUserId, targetPlayId, takeId, transcriptId, objectKey, "a".repeat(64), versionToken]);
}

async function insertCleanup(client: PGlite, values: unknown[],
  transcriptStatus: "current" | "stale" | "attempted" = "current") {
  return client.query(`INSERT INTO private_object_cleanup_tasks
    (owner_user_id, play_id, take_id, transcript_id, source_job_id, source_attempt_count,
     source_lease_token, object_key, storage_version_token, failure_code, transcript_status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'DB_PUBLICATION_FAILED', $10)`,
  [...values, transcriptStatus]);
}

async function insertTakeOnlyStage(client: PGlite, sourceJobId: string, takeId: string, stageKind: string) {
  return client.query(`INSERT INTO take_stage_job_chains
    (job_id, owner_user_id, play_id, take_id, stage_kind)
    VALUES ($1, $2, $3, $4, $5)`, [sourceJobId, ownerA, playId, takeId, stageKind]);
}

async function artifactTables(client: PGlite) {
  const result = await client.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      AND table_name IN ('normalized_audio_artifacts', 'private_object_cleanup_tasks',
        'take_stage_job_chains')
    ORDER BY table_name`);
  return result.rows.map(({ table_name }) => table_name);
}

async function count(client: PGlite, table: string) {
  const result = await client.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}`);
  return result.rows[0]!.count;
}
