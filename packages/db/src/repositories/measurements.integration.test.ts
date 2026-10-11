import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TakeMetrics } from "@drama/domain/audio-metrics";
import * as schema from "../schema";
import { lineAlignments, playModels, plays, practiceSessions, takeMetricLines, takeMetrics,
  takeTranscripts, takes, users } from "../schema";
import { MeasurementPublicationError, MeasurementRepository } from "./measurements";

const migrationNames = [
  "0001_foundation.sql", "0002_play_processing_status.sql", "0002_practice_sessions.sql",
  "0003_reviewable_parse_jobs.sql", "0004_job_lease_fencing.sql", "0005_grounded_study.sql",
  "0006_current_artifact_uniqueness.sql", "0007_take_transcripts.sql",
  "0008_ordered_transcript_evidence.sql", "0009_take_metrics.sql", "0015_take_audio_retention.sql",
  "0017_rehearsal_sessions.sql", "0018_rehearsal_events.sql", "0019_account_deletion.sql",
  "0020_rehearsal_linked_coaching.sql",
] as const;
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const otherOwnerUserId = "22222222-2222-4222-8222-222222222222";
const playId = "33333333-3333-4333-8333-333333333333";
const modelId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
const takeId = "66666666-6666-4666-8666-666666666666";
const otherTakeId = "77777777-7777-4777-8777-777777777777";
const transcriptId = "88888888-8888-4888-8888-888888888888";
const otherTranscriptId = "99999999-9999-4999-8999-999999999999";
const newerTranscriptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("MeasurementRepository", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let repository: MeasurementRepository<any>;

  beforeEach(async () => {
    client = new PGlite();
    for (const name of migrationNames) {
      await client.exec(await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
    }
    db = drizzle(client, { schema });
    repository = new MeasurementRepository(db);
    await seed();
  });

  afterEach(async () => client.close());

  it("publishes and reads the complete current measurement only within its owner scope", async () => {
    // Break caught: dropping owner predicates or line persistence leaks/incompletely stores actor evidence.
    const result = await repository.publishCurrent({ ownerUserId, takeId, transcriptId,
      measurementVersion: "measure-v1", metrics: fixtureMetrics() });

    expect(result.deduplicated).toBe(false);
    expect(result.measurement).toMatchObject({ ownerUserId, takeId, transcriptId,
      transcriptStatus: "current", measurementVersion: "measure-v1",
      metrics: expect.objectContaining({ durationMs: 2_000, technicalWarnings: ["CLIPPING"] }) });
    expect(result.lines).toEqual([expect.objectContaining({ ownerUserId, transcriptId,
      elementId: "line-1", speechDurationMs: 800, silenceDurationMs: 200, rmsDb: -18 })]);
    await expect(repository.getCurrentForTake(ownerUserId, takeId, "measure-v1"))
      .resolves.toMatchObject({ measurement: { id: result.measurement.id }, lines: result.lines });
    await expect(repository.getCurrentForTake(otherOwnerUserId, takeId, "measure-v1")).resolves.toBeNull();
  });

  it("returns the immutable publication on retry instead of creating competing rows", async () => {
    // Break caught: a lease retry after commit can duplicate or silently replace already-published evidence.
    const first = await repository.publishCurrent({ ownerUserId, takeId, transcriptId,
      measurementVersion: "measure-v1", metrics: fixtureMetrics() });
    const retryMetrics = fixtureMetrics();
    retryMetrics.durationMs = 9_999;

    const retry = await repository.publishCurrent({ ownerUserId, takeId, transcriptId,
      measurementVersion: "measure-v1", metrics: retryMetrics });

    expect(retry).toMatchObject({ deduplicated: true, measurement: { id: first.measurement.id,
      metrics: expect.objectContaining({ durationMs: 2_000 }) } });
    expect(await db.select().from(takeMetrics)).toHaveLength(1);
    expect(await db.select().from(takeMetricLines)).toHaveLength(1);
  });

  it("rejects cross-take and unaligned-line chains transactionally", async () => {
    // Break caught: TypeScript-only validation could publish metrics against unrelated transcript evidence.
    await expect(repository.publishCurrent({ ownerUserId, takeId, transcriptId: otherTranscriptId,
      measurementVersion: "measure-v1", metrics: fixtureMetrics() }))
      .rejects.toEqual(expect.objectContaining({ code: "STALE_TRANSCRIPT" }));
    const invalidMetrics = fixtureMetrics();
    invalidMetrics.lines[0] = { ...invalidMetrics.lines[0]!, elementId: "not-aligned" };
    await expect(repository.publishCurrent({ ownerUserId, takeId, transcriptId,
      measurementVersion: "measure-v1", metrics: invalidMetrics }))
      .rejects.toEqual(expect.objectContaining({ code: "INVALID_METRIC_CHAIN" }));
    expect(await db.select().from(takeMetrics)).toEqual([]);
    expect(await db.select().from(takeMetricLines)).toEqual([]);
  });

  it("rejects a stale transcript after a newer transcript becomes current", async () => {
    // Break caught: work computed from an earlier transcript must not publish after transcript re-promotion.
    await db.update(takeTranscripts).set({ status: "stale" }).where(eq(takeTranscripts.id, transcriptId));
    await db.update(takeTranscripts).set({ status: "current" }).where(eq(takeTranscripts.id, newerTranscriptId));

    await expect(repository.publishCurrent({ ownerUserId, takeId, transcriptId,
      measurementVersion: "measure-v1", metrics: fixtureMetrics() }))
      .rejects.toBeInstanceOf(MeasurementPublicationError);
    await expect(repository.publishCurrent({ ownerUserId, takeId, transcriptId,
      measurementVersion: "measure-v1", metrics: fixtureMetrics() }))
      .rejects.toEqual(expect.objectContaining({ code: "STALE_TRANSCRIPT" }));
    expect(await db.select().from(takeMetrics)).toEqual([]);
  });

  it("does not return a measurement when transcript promotion races its line read", async () => {
    // Break caught: separate READ COMMITTED statements can return an old metric after its transcript is stale.
    await repository.publishCurrent({ ownerUserId, takeId, transcriptId,
      measurementVersion: "measure-v1", metrics: fixtureMetrics() });
    await client.exec(`
      ALTER TABLE take_metric_lines RENAME TO take_metric_lines_storage;
      CREATE FUNCTION promote_during_metric_line_read(value uuid) RETURNS uuid AS $$
      BEGIN
        UPDATE take_transcripts SET status = 'stale' WHERE id = '${transcriptId}';
        UPDATE take_transcripts SET status = 'current' WHERE id = '${newerTranscriptId}';
        RETURN value;
      END;
      $$ LANGUAGE plpgsql VOLATILE;
      CREATE VIEW take_metric_lines AS
        SELECT promote_during_metric_line_read(id) AS id, owner_user_id, take_metric_id, transcript_id,
          element_id, start_ms, end_ms, speech_duration_ms, silence_duration_ms, rms_db, created_at
        FROM take_metric_lines_storage;
    `);

    await expect(repository.getCurrentForTake(ownerUserId, takeId, "measure-v1")).resolves.toBeNull();
    expect((await db.select().from(takeMetrics))[0]).toMatchObject({ transcriptStatus: "stale" });
  });

  async function seed() {
    await db.insert(users).values([
      { id: ownerUserId, email: "actor@example.com", passwordHash: "hash" },
      { id: otherOwnerUserId, email: "other@example.com", passwordHash: "hash" },
    ]);
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(playModels).values({ id: modelId, ownerUserId, playId, version: 1, status: "approved",
      model: {} as never, issues: [] });
    await db.insert(practiceSessions).values({ id: sessionId, ownerUserId, playId, playModelId: modelId,
      playModelVersion: 1, sceneId: "scene-1", roleId: "role-1", retentionChoice: "retain" });
    await db.insert(takes).values([
      { id: takeId, ownerUserId, practiceSessionId: sessionId, playId, playModelId: modelId,
        playModelVersion: 1, sceneId: "scene-1", roleId: "role-1", retentionChoice: "retain",
        durationMs: 2_000, mediaType: "audio/wav", objectKey: "take-a", state: "processing" },
      { id: otherTakeId, ownerUserId, practiceSessionId: sessionId, playId, playModelId: modelId,
        playModelVersion: 1, sceneId: "scene-1", roleId: "role-1", retentionChoice: "retain",
        durationMs: 2_000, mediaType: "audio/wav", objectKey: "take-b", state: "processing" },
    ]);
    await db.insert(takeTranscripts).values([
      transcript(transcriptId, takeId, "current", "hash-a", "v1"),
      transcript(newerTranscriptId, takeId, "stale", "hash-a", "v2"),
      transcript(otherTranscriptId, otherTakeId, "current", "hash-b", "v1"),
    ]);
    await db.insert(lineAlignments).values([
      alignment(transcriptId, "line-1"),
      alignment(newerTranscriptId, "line-1"),
      alignment(otherTranscriptId, "line-1"),
    ]);
  }
});

function transcript(id: string, takeId: string, status: "current" | "stale", audioSha256: string,
  transcriberVersion: string) {
  return { id, ownerUserId, takeId, audioSha256, transcriberVersion, provider: "fake", modelName: "fake",
    language: "en", text: "A line", timingSource: "whisper_word_timestamps" as const, status };
}

function alignment(transcriptId: string, elementId: string) {
  return { ownerUserId, transcriptId, elementId, scriptOrdinal: 1, transcriptStartMs: 0,
    transcriptEndMs: 1_000, similarity: 1, status: "matched" as const };
}

function fixtureMetrics(): TakeMetrics {
  return {
    durationMs: 2_000,
    speechDurationMs: 1_400,
    silenceDurationMs: 600,
    pauses: [{ startMs: 800, endMs: 1_000, durationMs: 200 }],
    alignmentCoverage: 0.9,
    clippingRatio: 0.06,
    technicalWarnings: ["CLIPPING"],
    pace: { confidence: "high", score: 82, wordsPerMinute: 120, wordCount: 4 },
    loudness: { confidence: "medium", score: 74, rmsDb: -18, rangeDb: 7 },
    pitch: { confidence: "low", score: null, medianHz: 180, rangeHz: 40, voicedFrames: 80 },
    lines: [{ elementId: "line-1", startMs: 0, endMs: 1_000, speechDurationMs: 800,
      silenceDurationMs: 200, rmsDb: -18 }],
    wordsPerMinute: 120,
  };
}
