import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrationFiles, discoverMigrationFiles, type MigrationDatabase } from "./migrations";
import { cueResponseEvidence, rehearsalEvents } from "./schema";

const migrationUrl = new URL("../migrations/0001_foundation.sql", import.meta.url);
const playStatusMigrationUrl = new URL("../migrations/0002_play_processing_status.sql", import.meta.url);
const reviewableJobsMigrationUrl = new URL("../migrations/0003_reviewable_parse_jobs.sql", import.meta.url);
const leaseFencingMigrationUrl = new URL("../migrations/0004_job_lease_fencing.sql", import.meta.url);
const groundedStudyMigrationUrl = new URL("../migrations/0005_grounded_study.sql", import.meta.url);
const currentArtifactMigrationUrl = new URL("../migrations/0006_current_artifact_uniqueness.sql", import.meta.url);
const practiceMigrationUrl = new URL("../migrations/0002_practice_sessions.sql", import.meta.url);
const transcriptMigrationUrl = new URL("../migrations/0007_take_transcripts.sql", import.meta.url);
const orderedEvidenceMigrationUrl = new URL("../migrations/0008_ordered_transcript_evidence.sql", import.meta.url);
const audioRetentionMigrationUrl = new URL("../migrations/0015_take_audio_retention.sql", import.meta.url);
const rehearsalLinkedCoachingMigrationUrl = new URL(
  "../migrations/0020_rehearsal_linked_coaching.sql", import.meta.url);
const rehearsalLinkedCoachingDownMigrationUrl = new URL(
  "../migrations/down/0020_rehearsal_linked_coaching.sql", import.meta.url);

describe("foundation migration", { timeout: 10_000 }, () => {
  let client: PGlite;

  beforeEach(() => {
    client = new PGlite();
  });

  afterEach(async () => {
    await client.close();
  });

  it("creates every foundation table in PostgreSQL", async () => {
    await client.exec(await readFile(migrationUrl, "utf8"));

    const result = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    expect(result.rows.map((row) => row.table_name)).toEqual([
      "analysis_artifacts",
      "invite_tokens",
      "jobs",
      "play_models",
      "plays",
      "sessions",
      "source_files",
      "users",
    ]);
  });

  it("enforces play and child ownership integrity", async () => {
    await client.exec(await readFile(migrationUrl, "utf8"));
    const userA = "11111111-1111-4111-8111-111111111111";
    const userB = "22222222-2222-4222-8222-222222222222";
    const playId = "33333333-3333-4333-8333-333333333333";
    await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3), ($4, $5, $6)", [
      userA, "a@example.com", "hash-a", userB, "b@example.com", "hash-b",
    ]);
    await client.query("INSERT INTO plays (id, owner_user_id, title) VALUES ($1, $2, $3)", [
      playId, userA, "Private Play",
    ]);

    await expect(client.query(
      "INSERT INTO plays (owner_user_id, title) VALUES ($1, $2)",
      ["44444444-4444-4444-8444-444444444444", "Orphan"],
    )).rejects.toMatchObject({ code: "23503" });
    await expect(client.query(
      "INSERT INTO source_files (owner_user_id, play_id, filename) VALUES ($1, $2, $3)",
      [userB, playId, "cross-owner.txt"],
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("adds processing status when upgrading an existing foundation database", async () => {
    await client.exec(await readFile(migrationUrl, "utf8"));
    const userId = "11111111-1111-4111-8111-111111111111";
    const playId = "33333333-3333-4333-8333-333333333333";
    await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [
      userId, "actor@example.com", "hash",
    ]);
    await client.query("INSERT INTO plays (id, owner_user_id, title) VALUES ($1, $2, $3)", [
      playId, userId, "Private Play",
    ]);

    await client.exec(await readFile(playStatusMigrationUrl, "utf8"));

    const result = await client.query<{ status: string }>("SELECT status FROM plays WHERE id = $1", [playId]);
    expect(result.rows).toEqual([{ status: "processing" }]);
  });

  it("additively upgrades existing jobs for leases, dedupe, and review state", async () => {
    await client.exec(await readFile(migrationUrl, "utf8"));
    await client.exec(await readFile(playStatusMigrationUrl, "utf8"));
    const userId = "11111111-1111-4111-8111-111111111111";
    const jobId = "22222222-2222-4222-8222-222222222222";
    await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [
      userId, "actor@example.com", "hash",
    ]);
    await client.query("INSERT INTO jobs (id, owner_user_id, kind) VALUES ($1, $2, $3)", [
      jobId, userId, "existing_job",
    ]);

    await client.exec(await readFile(reviewableJobsMigrationUrl, "utf8"));
    await client.exec(await readFile(leaseFencingMigrationUrl, "utf8"));

    const result = await client.query<{
      id: string;
      attempt_count: number;
      dedupe_key: string | null;
      lease_expires_at: Date | null;
      lease_token: string | null;
    }>("SELECT id, attempt_count, dedupe_key, lease_expires_at, lease_token FROM jobs WHERE owner_user_id = $1", [userId]);
    expect(result.rows).toEqual([{
      id: jobId,
      attempt_count: 0,
      dedupe_key: null,
      lease_expires_at: null,
      lease_token: null,
    }]);
  });

  it("additively adds study provenance and separate actor notes", async () => {
    await client.exec(await readFile(migrationUrl, "utf8"));
    await client.exec(await readFile(playStatusMigrationUrl, "utf8"));
    await client.exec(await readFile(reviewableJobsMigrationUrl, "utf8"));
    await client.exec(await readFile(leaseFencingMigrationUrl, "utf8"));
    const userId = "11111111-1111-4111-8111-111111111111";
    const playId = "22222222-2222-4222-8222-222222222222";
    const artifactId = "33333333-3333-4333-8333-333333333333";
    await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [
      userId, "actor@example.com", "hash",
    ]);
    await client.query("INSERT INTO plays (id, owner_user_id, title) VALUES ($1, $2, $3)", [
      playId, userId, "Private Play",
    ]);
    await client.query("INSERT INTO analysis_artifacts (id, owner_user_id, play_id, kind, content) VALUES ($1, $2, $3, $4, $5)", [
      artifactId, userId, playId, "existing", {},
    ]);

    await client.exec(await readFile(groundedStudyMigrationUrl, "utf8"));

    const artifact = await client.query<{ prompt_version: string | null; model_name: string | null;
      play_model_version: number | null; generated_at: Date | null }>(
      "SELECT prompt_version, model_name, play_model_version, generated_at FROM analysis_artifacts WHERE id = $1",
      [artifactId],
    );
    expect(artifact.rows).toEqual([{ prompt_version: null, model_name: null, play_model_version: null,
      generated_at: null }]);
    const tables = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'actor_notes'",
    );
    expect(tables.rows).toEqual([{ table_name: "actor_notes" }]);
  });

  it("keeps the newest duplicate artifact current before enforcing one current artifact per kind", async () => {
    for (const url of [migrationUrl, playStatusMigrationUrl, reviewableJobsMigrationUrl,
      leaseFencingMigrationUrl, groundedStudyMigrationUrl]) await client.exec(await readFile(url, "utf8"));
    const userId = "11111111-1111-4111-8111-111111111111";
    const playId = "22222222-2222-4222-8222-222222222222";
    await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [
      userId, "actor@example.com", "hash",
    ]);
    await client.query("INSERT INTO plays (id, owner_user_id, title) VALUES ($1, $2, $3)", [
      playId, userId, "Private Play",
    ]);
    await client.query(`INSERT INTO analysis_artifacts
      (id, owner_user_id, play_id, kind, content, status, created_at)
      VALUES ($1, $2, $3, 'role_workbook:alex', '{}', 'current', '2026-08-01'),
             ($4, $2, $3, 'role_workbook:alex', '{}', 'current', '2026-08-02')`, [
      "33333333-3333-4333-8333-333333333333", userId, playId,
      "44444444-4444-4444-8444-444444444444",
    ]);

    await client.exec(await readFile(currentArtifactMigrationUrl, "utf8"));

    const statuses = await client.query<{ id: string; status: string }>(
      "SELECT id, status FROM analysis_artifacts ORDER BY created_at",
    );
    expect(statuses.rows).toEqual([
      { id: "33333333-3333-4333-8333-333333333333", status: "stale" },
      { id: "44444444-4444-4444-8444-444444444444", status: "current" },
    ]);
    await expect(client.query(`INSERT INTO analysis_artifacts
      (owner_user_id, play_id, kind, content, status) VALUES ($1, $2, 'role_workbook:alex', '{}', 'current')`,
    [userId, playId])).rejects.toThrow();
  });

  it("discovers both migrations sharing the 0002 prefix in deterministic filename order", async () => {
    const files = await discoverMigrationFiles(new URL("../migrations/", import.meta.url));

    expect(files.map((file) => file.name)).toEqual([
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
      "0010_normalized_audio_artifacts.sql",
      "0011_stale_attempt_cleanup.sql",
      "0012_cleanup_attempt_history.sql",
      "0013_immutable_normalized_audio_keys.sql",
      "0014_coaching_reports.sql",
      "0015_take_audio_retention.sql",
      "0016_global_job_lease_history.sql",
      "0017_rehearsal_sessions.sql",
      "0018_rehearsal_events.sql",
      "0019_account_deletion.sql",
      "0020_rehearsal_linked_coaching.sql",
    ]);
  });

  it("applies and journals the production duplicate-prefix migration sequence idempotently", async () => {
    const database = migrationDatabase(client);

    const firstRun = await applyMigrationFiles(database, new URL("../migrations/", import.meta.url));
    const secondRun = await applyMigrationFiles(database, new URL("../migrations/", import.meta.url));

    expect(firstRun).toEqual(["0001_foundation.sql", "0002_play_processing_status.sql",
      "0002_practice_sessions.sql", "0003_reviewable_parse_jobs.sql", "0004_job_lease_fencing.sql",
      "0005_grounded_study.sql", "0006_current_artifact_uniqueness.sql", "0007_take_transcripts.sql",
      "0008_ordered_transcript_evidence.sql", "0009_take_metrics.sql",
      "0010_normalized_audio_artifacts.sql", "0011_stale_attempt_cleanup.sql",
      "0012_cleanup_attempt_history.sql", "0013_immutable_normalized_audio_keys.sql",
      "0014_coaching_reports.sql", "0015_take_audio_retention.sql", "0016_global_job_lease_history.sql",
      "0017_rehearsal_sessions.sql", "0018_rehearsal_events.sql", "0019_account_deletion.sql",
      "0020_rehearsal_linked_coaching.sql"]);
    expect(secondRun).toEqual([]);
    const journal = await client.query<{ name: string }>("SELECT name FROM drama_migrations ORDER BY name");
    expect(journal.rows.map(({ name }) => name)).toEqual(firstRun);
    const tables = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('practice_sessions', 'takes', 'take_events')
      ORDER BY table_name
    `);
    expect(tables.rows.map((row) => row.table_name)).toEqual(["practice_sessions", "take_events", "takes"]);
  });

  it("adopts a journal-less Plan 1 database before applying the practice migration", async () => {
    for (const url of [migrationUrl, playStatusMigrationUrl, reviewableJobsMigrationUrl,
      leaseFencingMigrationUrl, groundedStudyMigrationUrl, currentArtifactMigrationUrl]) {
      await client.exec(await readFile(url, "utf8"));
    }
    const database = migrationDatabase(client);

    const firstRun = await applyMigrationFiles(database, new URL("../migrations/", import.meta.url));
    const secondRun = await applyMigrationFiles(database, new URL("../migrations/", import.meta.url));

    expect(firstRun).toEqual(["0002_practice_sessions.sql", "0007_take_transcripts.sql",
      "0008_ordered_transcript_evidence.sql", "0009_take_metrics.sql",
      "0010_normalized_audio_artifacts.sql", "0011_stale_attempt_cleanup.sql",
      "0012_cleanup_attempt_history.sql", "0013_immutable_normalized_audio_keys.sql",
      "0014_coaching_reports.sql", "0015_take_audio_retention.sql", "0016_global_job_lease_history.sql",
      "0017_rehearsal_sessions.sql", "0018_rehearsal_events.sql", "0019_account_deletion.sql",
      "0020_rehearsal_linked_coaching.sql"]);
    expect(secondRun).toEqual([]);
    const journal = await client.query<{ name: string }>("SELECT name FROM drama_migrations ORDER BY name");
    expect(journal.rows.map(({ name }) => name)).toEqual([
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
      "0010_normalized_audio_artifacts.sql",
      "0011_stale_attempt_cleanup.sql",
      "0012_cleanup_attempt_history.sql",
      "0013_immutable_normalized_audio_keys.sql",
      "0014_coaching_reports.sql",
      "0015_take_audio_retention.sql",
      "0016_global_job_lease_history.sql",
      "0017_rehearsal_sessions.sql",
      "0018_rehearsal_events.sql",
      "0019_account_deletion.sql",
      "0020_rehearsal_linked_coaching.sql",
    ]);
    const tables = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('practice_sessions', 'takes', 'take_events')
      ORDER BY table_name
    `);
    expect(tables.rows.map((row) => row.table_name)).toEqual(["practice_sessions", "take_events", "takes"]);
  });

  it("creates owner-consistent practice tables and rejects cross-owner related rows", async () => {
    for (const url of [migrationUrl, playStatusMigrationUrl, practiceMigrationUrl]) {
      await client.exec(await readFile(url, "utf8"));
    }
    const userA = "11111111-1111-4111-8111-111111111111";
    const userB = "22222222-2222-4222-8222-222222222222";
    const playId = "33333333-3333-4333-8333-333333333333";
    const modelId = "44444444-4444-4444-8444-444444444444";
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const takeId = "66666666-6666-4666-8666-666666666666";
    await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, 'a@example.com', 'a'), ($2, 'b@example.com', 'b')", [userA, userB]);
    await client.query("INSERT INTO plays (id, owner_user_id, title) VALUES ($1, $2, 'Private Play')", [playId, userA]);
    await client.query("INSERT INTO play_models (id, owner_user_id, play_id, version, status, model) VALUES ($1, $2, $3, 1, 'approved', '{}')", [modelId, userA, playId]);
    await client.query(`INSERT INTO practice_sessions
      (id, owner_user_id, play_id, play_model_id, play_model_version, scene_id, role_id, retention_choice)
      VALUES ($1, $2, $3, $4, 1, 'scene-1', 'role-1', 'retain')`, [sessionId, userA, playId, modelId]);
    await client.query(`INSERT INTO takes
      (id, owner_user_id, practice_session_id, play_id, play_model_id, play_model_version, scene_id, role_id,
       retention_choice, duration_ms, media_type, object_key, state)
      VALUES ($1, $2, $3, $4, $5, 1, 'scene-1', 'role-1', 'retain', 1000, 'audio/wav', 'private', 'queued')`,
    [takeId, userA, sessionId, playId, modelId]);

    await expect(client.query(`INSERT INTO take_events (owner_user_id, take_id, state)
      VALUES ($1, $2, 'queued')`, [userB, takeId])).rejects.toMatchObject({ code: "23503" });
    await expect(client.query(`INSERT INTO takes
      (owner_user_id, practice_session_id, play_id, play_model_id, play_model_version, scene_id, role_id,
       retention_choice, duration_ms, media_type, object_key, state)
      VALUES ($1, $2, $3, $4, 1, 'scene-1', 'role-1', 'retain', 1000, 'audio/wav', 'private-2', 'queued')`,
    [userB, sessionId, playId, modelId])).rejects.toMatchObject({ code: "23503" });
  });

  it("adds nullable rehearsal linkage and owner-scoped cue evidence, then reverses cleanly", async () => {
    // Break caught: a take/session or event/evidence FK that omits owner/session permits cross-tenant evidence chains.
    await applyMigrationFiles(migrationDatabase(client), new URL("../migrations/", import.meta.url));
    const ownerA = "11111111-1111-4111-8111-111111111111";
    const ownerB = "22222222-2222-4222-8222-222222222222";
    const playA = "33333333-3333-4333-8333-333333333333";
    const modelA = "44444444-4444-4444-8444-444444444444";
    const practiceA = "55555555-5555-4555-8555-555555555555";
    const playB = "12121212-1212-4121-8121-121212121212";
    const modelB = "13131313-1313-4131-8131-131313131313";
    const practiceB = "14141414-1414-4141-8141-141414141414";
    const rehearsalA = "66666666-6666-4666-8666-666666666666";
    const legacyTake = "77777777-7777-4777-8777-777777777777";
    const linkedTake = "88888888-8888-4888-8888-888888888888";
    const cueEvent = "99999999-9999-4999-8999-999999999999";
    const actorEvent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const rehearsalB = "abababab-abab-4bab-8bab-abababababab";
    const linkedTakeB = "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc";
    const cueEventB = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    const actorEventB = "dededede-dede-4ede-8ede-dededededede";
    await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, 'a@example.com', 'a'), ($2, 'b@example.com', 'b')", [ownerA, ownerB]);
    await client.query("INSERT INTO plays (id, owner_user_id, title) VALUES ($1, $2, 'Private Play')",
      [playA, ownerA]);
    await client.query(`INSERT INTO play_models
      (id, owner_user_id, play_id, version, status, model) VALUES ($1, $2, $3, 1, 'approved', '{}')`,
    [modelA, ownerA, playA]);
    await client.query(`INSERT INTO practice_sessions
      (id, owner_user_id, play_id, play_model_id, play_model_version, scene_id, role_id, retention_choice)
      VALUES ($1, $2, $3, $4, 1, 'scene-1', 'role-1', 'retain')`,
    [practiceA, ownerA, playA, modelA]);
    await client.query("INSERT INTO plays (id, owner_user_id, title) VALUES ($1, $2, 'Other Private Play')",
      [playB, ownerB]);
    await client.query(`INSERT INTO play_models
      (id, owner_user_id, play_id, version, status, model) VALUES ($1, $2, $3, 1, 'approved', '{}')`,
    [modelB, ownerB, playB]);
    await client.query(`INSERT INTO practice_sessions
      (id, owner_user_id, play_id, play_model_id, play_model_version, scene_id, role_id, retention_choice)
      VALUES ($1, $2, $3, $4, 1, 'scene-1', 'role-1', 'retain')`,
    [practiceB, ownerB, playB, modelB]);
    await client.query(`INSERT INTO rehearsal_sessions
      (id, owner_user_id, play_id, play_model_id, play_model_version, scene_id, actor_role_id, model,
       grant_expires_at, state)
      VALUES ($1, $2, $3, $4, 1, 'scene-1', 'role-1', 'realtime', now(), 'completed')`,
    [rehearsalA, ownerA, playA, modelA]);
    await client.query(`INSERT INTO takes
      (id, owner_user_id, practice_session_id, play_id, play_model_id, play_model_version, scene_id, role_id,
       retention_choice, duration_ms, media_type, object_key, state)
      VALUES ($1, $2, $3, $4, $5, 1, 'scene-1', 'role-1', 'retain', 1000, 'audio/wav', 'legacy', 'queued')`,
    [legacyTake, ownerA, practiceA, playA, modelA]);

    expect((await client.query<{ rehearsal_session_id: string | null }>(
      "SELECT rehearsal_session_id FROM takes WHERE id = $1", [legacyTake])).rows)
      .toEqual([{ rehearsal_session_id: null }]);
    await client.query(`INSERT INTO takes
      (id, owner_user_id, practice_session_id, play_id, play_model_id, play_model_version, scene_id, role_id,
       retention_choice, duration_ms, media_type, object_key, state, rehearsal_session_id)
      VALUES ($1, $2, $3, $4, $5, 1, 'scene-1', 'role-1', 'retain', 1000, 'audio/wav', 'linked', 'queued', $6)`,
    [linkedTake, ownerA, practiceA, playA, modelA, rehearsalA]);
    await expect(client.query(`UPDATE takes SET owner_user_id = $1, practice_session_id = $2,
      play_id = $3, play_model_id = $4 WHERE id = $5`, [ownerB, practiceB, playB, modelB, linkedTake]))
      .rejects.toMatchObject({ code: "23503" });
    await client.query(`INSERT INTO rehearsal_events
      (id, owner_user_id, rehearsal_session_id, sequence, type, event, created_at)
      VALUES ($1, $2, $3, 1, 'ai_speech_finished', '{}', '2026-08-25T12:00:00.000Z'),
             ($4, $2, $3, 2, 'actor_line_final', '{}', '2026-08-25T12:00:00.740Z')`,
    [cueEvent, ownerA, rehearsalA, actorEvent]);
    await client.query(`INSERT INTO rehearsal_sessions
      (id, owner_user_id, play_id, play_model_id, play_model_version, scene_id, actor_role_id, model,
       grant_expires_at, state)
      VALUES ($1, $2, $3, $4, 1, 'scene-1', 'role-1', 'realtime', now(), 'completed')`,
    [rehearsalB, ownerA, playA, modelA]);
    await client.query(`INSERT INTO takes
      (id, owner_user_id, practice_session_id, play_id, play_model_id, play_model_version, scene_id, role_id,
       retention_choice, duration_ms, media_type, object_key, state, rehearsal_session_id)
      VALUES ($1, $2, $3, $4, $5, 1, 'scene-1', 'role-1', 'retain', 1000, 'audio/wav', 'linked-b',
       'queued', $6)`, [linkedTakeB, ownerA, practiceA, playA, modelA, rehearsalB]);
    await client.query(`INSERT INTO rehearsal_events
      (id, owner_user_id, rehearsal_session_id, sequence, type, event, created_at)
      VALUES ($1, $2, $3, 1, 'ai_speech_finished', '{}', '2026-08-25T12:00:01.000Z'),
             ($4, $2, $3, 2, 'actor_line_final', '{}', '2026-08-25T12:00:01.740Z')`,
    [cueEventB, ownerA, rehearsalB, actorEventB]);
    await client.query(`INSERT INTO cue_response_evidence
      (owner_user_id, take_id, rehearsal_session_id, measurement_version, cue_event_id, actor_event_id,
       clock_id, delay_ms, confidence, score)
      VALUES ($1, $2, $3, 'cue-response-v1', $4, $5, 'provider:rehearsal', 740, 'high', 85)`,
    [ownerA, linkedTake, rehearsalA, cueEvent, actorEvent]);
    await client.query(`INSERT INTO cue_response_evidence
      (owner_user_id, take_id, rehearsal_session_id, measurement_version, confidence)
      VALUES ($1, $2, $3, 'low-valid', 'low')`, [ownerA, linkedTake, rehearsalA]);
    const invalidEvidence = [
      { version: " ", cue: null, actor: null, clock: null, delay: null, confidence: "low", score: null },
      { version: "invalid-confidence", cue: cueEvent, actor: actorEvent, clock: "provider:real", delay: 740,
        confidence: "certain", score: 85 },
      { version: "low-with-score", cue: cueEvent, actor: actorEvent, clock: "provider:real", delay: 740,
        confidence: "low", score: 85 },
      { version: "high-missing-source", cue: cueEvent, actor: null, clock: "provider:real", delay: 740,
        confidence: "high", score: 85 },
      { version: "blank-clock", cue: cueEvent, actor: actorEvent, clock: " ", delay: 740,
        confidence: "high", score: 85 },
      { version: "negative-delay", cue: cueEvent, actor: actorEvent, clock: "provider:real", delay: -1,
        confidence: "high", score: 85 },
      { version: "score-range", cue: cueEvent, actor: actorEvent, clock: "provider:real", delay: 740,
        confidence: "high", score: 101 },
    ];
    for (const row of invalidEvidence) {
      await expect(client.query(`INSERT INTO cue_response_evidence
        (owner_user_id, take_id, rehearsal_session_id, measurement_version, cue_event_id, actor_event_id,
         clock_id, delay_ms, confidence, score) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [ownerA, linkedTake, rehearsalA, row.version, row.cue, row.actor, row.clock, row.delay,
        row.confidence, row.score])).rejects.toMatchObject({ code: "23514" });
    }
    await expect(client.query(`UPDATE rehearsal_events SET timing_source = 'provider-derived'
      WHERE id = $1`, [cueEvent])).rejects.toMatchObject({ code: "23514" });
    await expect(client.query(`UPDATE rehearsal_events SET received_at_ms = -1,
      received_clock_id = 'server:unix-epoch-ms' WHERE id = $1`, [cueEvent]))
      .rejects.toMatchObject({ code: "23514" });
    await client.query(`UPDATE rehearsal_events SET received_at_ms = 10000,
      received_clock_id = 'server:unix-epoch-ms', timing_source = 'provider-derived', timing_at_ms = 10000,
      timing_clock_id = 'provider:real' WHERE id = $1`, [cueEvent]);
    const constraintRows = await client.query<{ conname: string }>(`SELECT conname FROM pg_constraint
      WHERE contype = 'c' AND conrelid IN ('cue_response_evidence'::regclass, 'rehearsal_events'::regclass)
      ORDER BY conname`);
    const declaredChecks = [...getTableConfig(cueResponseEvidence).checks,
      ...getTableConfig(rehearsalEvents).checks].map(({ name }) => name).sort();
    expect(constraintRows.rows.map(({ conname }) => conname)
      .filter((name) => declaredChecks.includes(name))).toEqual(declaredChecks);
    await expect(client.query(`INSERT INTO cue_response_evidence
      (owner_user_id, take_id, rehearsal_session_id, measurement_version, cue_event_id, actor_event_id,
       clock_id, delay_ms, confidence, score)
      VALUES ($1, $2, $3, 'cue-response-v2', $4, $5, 'provider:rehearsal', 740, 'high', 85)`,
    [ownerB, linkedTake, rehearsalA, cueEvent, actorEvent])).rejects.toMatchObject({ code: "23503" });
    await expect(client.query(`INSERT INTO cue_response_evidence
      (owner_user_id, take_id, rehearsal_session_id, measurement_version, cue_event_id, actor_event_id,
       clock_id, delay_ms, confidence, score)
      VALUES ($1, $2, $3, 'cross-take', $4, $5, 'provider:rehearsal', 740, 'high', 85)`,
    [ownerA, linkedTakeB, rehearsalA, cueEvent, actorEvent])).rejects.toMatchObject({ code: "23503" });
    await expect(client.query(`INSERT INTO cue_response_evidence
      (owner_user_id, take_id, rehearsal_session_id, measurement_version, cue_event_id, actor_event_id,
       clock_id, delay_ms, confidence, score)
      VALUES ($1, $2, $3, 'cross-session', $4, $5, 'provider:rehearsal', 740, 'high', 85)`,
    [ownerA, linkedTake, rehearsalB, cueEventB, actorEventB])).rejects.toMatchObject({ code: "23503" });
    await expect(client.query(`INSERT INTO cue_response_evidence
      (owner_user_id, take_id, rehearsal_session_id, measurement_version, cue_event_id, actor_event_id,
       clock_id, delay_ms, confidence, score)
      VALUES ($1, $2, $3, 'cross-event-session', $4, $5, 'provider:rehearsal', 740, 'high', 85)`,
    [ownerA, linkedTake, rehearsalA, cueEventB, actorEvent])).rejects.toMatchObject({ code: "23503" });

    await client.exec(await readFile(rehearsalLinkedCoachingDownMigrationUrl, "utf8"));
    expect((await client.query<{ count: number }>(`SELECT count(*)::int AS count
      FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'cue_response_evidence'`))
      .rows).toEqual([{ count: 0 }]);
    expect((await client.query<{ count: number }>(`SELECT count(*)::int AS count
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'takes'
      AND column_name = 'rehearsal_session_id'`)).rows).toEqual([{ count: 0 }]);
    expect((await client.query<{ count: number }>(`SELECT count(*)::int AS count
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rehearsal_events'
      AND column_name IN ('received_at_ms', 'received_clock_id', 'timing_source', 'timing_at_ms',
        'timing_clock_id')`)).rows).toEqual([{ count: 0 }]);
    await client.exec(await readFile(rehearsalLinkedCoachingMigrationUrl, "utf8"));
    expect((await client.query<{ rehearsal_session_id: string | null }>(
      "SELECT rehearsal_session_id FROM takes WHERE id = $1", [legacyTake])).rows)
      .toEqual([{ rehearsal_session_id: null }]);
  });

  it("backfills complete-take mode and adds an audio deletion marker", async () => {
    for (const url of [migrationUrl, playStatusMigrationUrl, practiceMigrationUrl]) {
      await client.exec(await readFile(url, "utf8"));
    }
    const userId = "11111111-1111-4111-8111-111111111111";
    const playId = "22222222-2222-4222-8222-222222222222";
    const modelId = "33333333-3333-4333-8333-333333333333";
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const takeId = "55555555-5555-4555-8555-555555555555";
    await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, 'actor@example.com', 'hash')",
      [userId]);
    await client.query("INSERT INTO plays (id, owner_user_id, title) VALUES ($1, $2, 'Private Play')",
      [playId, userId]);
    await client.query("INSERT INTO play_models (id, owner_user_id, play_id, version, status, model) VALUES ($1, $2, $3, 1, 'approved', '{}')", [modelId, userId, playId]);
    await client.query(`INSERT INTO practice_sessions
      (id, owner_user_id, play_id, play_model_id, play_model_version, scene_id, role_id, retention_choice)
      VALUES ($1, $2, $3, $4, 1, 'scene-1', 'role-1', 'retain')`, [sessionId, userId, playId, modelId]);
    await client.query(`INSERT INTO takes
      (id, owner_user_id, practice_session_id, play_id, play_model_id, play_model_version, scene_id, role_id,
       retention_choice, duration_ms, media_type, object_key, state)
      VALUES ($1, $2, $3, $4, $5, 1, 'scene-1', 'role-1', 'retain', 1000, 'audio/wav', 'private', 'queued')`,
    [takeId, userId, sessionId, playId, modelId]);

    await client.exec(await readFile(audioRetentionMigrationUrl, "utf8"));

    const result = await client.query<{ session_mode: string; take_mode: string; audio_deleted_at: Date | null }>(`
      SELECT session.practice_mode AS session_mode, take.practice_mode AS take_mode, take.audio_deleted_at
      FROM practice_sessions session JOIN takes take ON take.practice_session_id = session.id
      WHERE take.id = $1`, [takeId]);
    expect(result.rows).toEqual([{ session_mode: "complete_take", take_mode: "complete_take",
      audio_deleted_at: null }]);
    await expect(client.query("UPDATE takes SET practice_mode = 'unknown' WHERE id = $1", [takeId]))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("creates owner-scoped transcript evidence and rejects cross-owner words", async () => {
    // Break caught: a child row keyed only by transcript id could leak evidence across owner partitions.
    for (const url of [migrationUrl, playStatusMigrationUrl, practiceMigrationUrl, transcriptMigrationUrl]) {
      await client.exec(await readFile(url, "utf8"));
    }
    const userA = "11111111-1111-4111-8111-111111111111";
    const userB = "22222222-2222-4222-8222-222222222222";
    const playId = "33333333-3333-4333-8333-333333333333";
    const modelId = "44444444-4444-4444-8444-444444444444";
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const takeId = "66666666-6666-4666-8666-666666666666";
    const transcriptId = "77777777-7777-4777-8777-777777777777";
    await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, 'a@example.com', 'a'), ($2, 'b@example.com', 'b')", [userA, userB]);
    await client.query("INSERT INTO plays (id, owner_user_id, title) VALUES ($1, $2, 'Private Play')", [playId, userA]);
    await client.query("INSERT INTO play_models (id, owner_user_id, play_id, version, status, model) VALUES ($1, $2, $3, 1, 'approved', '{}')", [modelId, userA, playId]);
    await client.query(`INSERT INTO practice_sessions
      (id, owner_user_id, play_id, play_model_id, play_model_version, scene_id, role_id, retention_choice)
      VALUES ($1, $2, $3, $4, 1, 'scene-1', 'role-1', 'retain')`, [sessionId, userA, playId, modelId]);
    await client.query(`INSERT INTO takes
      (id, owner_user_id, practice_session_id, play_id, play_model_id, play_model_version, scene_id, role_id,
       retention_choice, duration_ms, media_type, object_key, state)
      VALUES ($1, $2, $3, $4, $5, 1, 'scene-1', 'role-1', 'retain', 1000, 'audio/wav', 'private', 'queued')`,
    [takeId, userA, sessionId, playId, modelId]);
    await client.query(`INSERT INTO take_transcripts
      (id, owner_user_id, take_id, audio_sha256, transcriber_version, provider, model_name, language, text,
       timing_source)
      VALUES ($1, $2, $3, 'abc', 'v1', 'openai', 'gpt-transcribe', 'en', 'We begin', 'unavailable')`,
    [transcriptId, userA, takeId]);

    await expect(client.query(`INSERT INTO transcript_words
      (owner_user_id, transcript_id, ordinal, text, start_ms, end_ms)
      VALUES ($1, $2, 1, 'We', 0, 100)`, [userB, transcriptId])).rejects.toMatchObject({ code: "23503" });
  });

  it("additively backfills durable line order and permits canonical words without timing", async () => {
    // Break caught: an upgrade must order existing evidence and allow explicit unavailable token timing.
    for (const url of [migrationUrl, playStatusMigrationUrl, practiceMigrationUrl, transcriptMigrationUrl]) {
      await client.exec(await readFile(url, "utf8"));
    }
    const userId = "11111111-1111-4111-8111-111111111111";
    const playId = "22222222-2222-4222-8222-222222222222";
    const modelId = "33333333-3333-4333-8333-333333333333";
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const takeId = "55555555-5555-4555-8555-555555555555";
    const transcriptId = "66666666-6666-4666-8666-666666666666";
    await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, 'actor@example.com', 'hash')",
      [userId]);
    await client.query("INSERT INTO plays (id, owner_user_id, title) VALUES ($1, $2, 'Private Play')",
      [playId, userId]);
    await client.query("INSERT INTO play_models (id, owner_user_id, play_id, version, status, model) VALUES ($1, $2, $3, 1, 'approved', '{}')", [modelId, userId, playId]);
    await client.query(`INSERT INTO practice_sessions
      (id, owner_user_id, play_id, play_model_id, play_model_version, scene_id, role_id, retention_choice)
      VALUES ($1, $2, $3, $4, 1, 'scene-1', 'role-1', 'retain')`, [sessionId, userId, playId, modelId]);
    await client.query(`INSERT INTO takes
      (id, owner_user_id, practice_session_id, play_id, play_model_id, play_model_version, scene_id, role_id,
       retention_choice, duration_ms, media_type, object_key, state)
      VALUES ($1, $2, $3, $4, $5, 1, 'scene-1', 'role-1', 'retain', 1000, 'audio/wav', 'private', 'queued')`,
    [takeId, userId, sessionId, playId, modelId]);
    await client.query(`INSERT INTO take_transcripts
      (id, owner_user_id, take_id, audio_sha256, transcriber_version, provider, model_name, language, text,
       timing_source) VALUES ($1, $2, $3, 'abc', 'v1', 'openai', 'model', 'en', 'text', 'unavailable')`,
    [transcriptId, userId, takeId]);
    await client.query(`INSERT INTO line_alignments
      (id, owner_user_id, transcript_id, element_id, similarity, status, created_at)
      VALUES ('88888888-8888-4888-8888-888888888888', $1, $2, 'later', 1, 'matched', '2026-08-12'),
             ('77777777-7777-4777-8777-777777777777', $1, $2, 'earlier', 1, 'matched', '2026-08-12')`,
    [userId, transcriptId]);

    await client.exec(await readFile(orderedEvidenceMigrationUrl, "utf8"));

    const alignments = await client.query<{ element_id: string; script_ordinal: number }>(
      "SELECT element_id, script_ordinal FROM line_alignments ORDER BY script_ordinal",
    );
    expect(alignments.rows).toEqual([
      { element_id: "earlier", script_ordinal: 1 },
      { element_id: "later", script_ordinal: 2 },
    ]);
    await expect(client.query(`INSERT INTO transcript_words
      (owner_user_id, transcript_id, ordinal, text, start_ms, end_ms) VALUES ($1, $2, 1, 'canonical', NULL, NULL)`,
    [userId, transcriptId])).resolves.toBeDefined();
  });
});

function migrationDatabase(client: PGlite): MigrationDatabase {
  return {
    exec: (sql) => client.exec(sql).then(() => undefined),
    query: async <T>(sql: string, params: unknown[] = []) =>
      (await client.query<T>(sql, params)).rows,
    transaction: (callback) => client.transaction(async (transaction) => callback({
      exec: (sql) => transaction.exec(sql).then(() => undefined),
      query: async <T>(sql: string, params: unknown[] = []) =>
        (await transaction.query<T>(sql, params)).rows,
    })),
  };
}
