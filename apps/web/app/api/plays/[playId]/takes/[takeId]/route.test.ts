import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { coachingReports, jobs, playModels, plays, practiceSessions, takeMetrics, takeTranscripts, takes, users }
  from "@drama/db/schema";
import type { CoachingEvidence, CoachingReport } from "@drama/domain/coaching";

import { createTakeReportHandler } from "./handler";

const migrations = ["0001_foundation.sql", "0002_play_processing_status.sql", "0002_practice_sessions.sql",
  "0003_reviewable_parse_jobs.sql", "0004_job_lease_fencing.sql", "0005_grounded_study.sql",
  "0006_current_artifact_uniqueness.sql", "0007_take_transcripts.sql", "0008_ordered_transcript_evidence.sql",
  "0009_take_metrics.sql", "0010_normalized_audio_artifacts.sql", "0011_stale_attempt_cleanup.sql",
  "0012_cleanup_attempt_history.sql", "0013_immutable_normalized_audio_keys.sql", "0014_coaching_reports.sql",
  "0015_take_audio_retention.sql", "0017_rehearsal_sessions.sql", "0018_rehearsal_events.sql",
  "0019_account_deletion.sql", "0020_rehearsal_linked_coaching.sql"];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const playId = "33333333-3333-4333-8333-333333333333";
const modelId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
const currentTakeId = "66666666-6666-4666-8666-666666666666";
const previousTakeId = "77777777-7777-4777-8777-777777777777";

describe("GET coaching take report", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    for (const name of migrations) {
      await client.exec(await readFile(new URL(`../../../../../../../../packages/db/migrations/${name}`,
        import.meta.url), "utf8"));
    }
    db = drizzle(client, { schema });
    await db.insert(users).values([
      { id: ownerUserId, email: "owner@example.com", passwordHash: "hash" },
      { id: otherUserId, email: "other@example.com", passwordHash: "hash" },
    ]);
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(playModels).values({ id: modelId, ownerUserId, playId, version: 1,
      status: "approved", model: { id: "model:v1", title: "Private Play", language: "en",
        characters: [], acts: [] }, issues: [] });
    await db.insert(practiceSessions).values({ id: sessionId, ownerUserId, playId, playModelId: modelId,
      playModelVersion: 1, sceneId: "scene", roleId: "alex", retentionChoice: "retain" });
    await insertCompletedTake(previousTakeId, "2026-08-20T12:00:00Z", 82);
    await insertCompletedTake(currentTakeId, "2026-08-21T12:00:00Z", 94);
  });

  afterEach(async () => client.close());

  it("returns evidence-linked coaching and the latest comparable score deltas without storage keys", async () => {
    const response = await handler(ownerUserId)(new Request("http://localhost/take"), context());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      take: { id: currentTakeId, state: "completed", durationMs: 1_000, mediaType: "audio/wav" },
      coaching: { status: "completed", report: expect.any(Object), evidence: expect.any(Array) },
      comparison: { previousTakeId, scores: { line_accuracy: { previous: 82, current: 94, delta: 12 },
        cue_responsiveness: null } },
      scriptLines: [],
      audioUrl: `/api/plays/${playId}/takes/${currentTakeId}/audio`,
    });
    expect(JSON.stringify(body)).not.toContain("objectKey");
  });

  it("returns the latest safe pipeline error when an older failed report has none", async () => {
    const transcriptId = currentTakeId.replace(/^./, "a");
    const measurementId = currentTakeId.replace(/^./, "b");
    await client.query("UPDATE takes SET state = 'action_required' WHERE id = $1", [currentTakeId]);
    await client.query("UPDATE coaching_reports SET status = 'action_required', synthesis_error_code = NULL WHERE take_id = $1",
      [currentTakeId]);
    await db.insert(jobs).values({ id: "99999999-9999-4999-8999-999999999999", ownerUserId, playId,
      kind: "review_audio", status: "action_required", attemptCount: 2,
      errorCode: "OPENAI_COACHING_HTTP_400", dedupeKey: "review_audio:failed-report",
      payload: { takeId: currentTakeId, transcriptId, measurementId } });

    const response = await handler(ownerUserId)(new Request("http://localhost/take"), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      take: { state: "action_required" },
      coaching: { synthesisErrorCode: "OPENAI_COACHING_HTTP_400" },
    });
  });

  it("exposes the failed pre-coaching job code when no report exists yet", async () => {
    await db.delete(coachingReports);
    await client.query("UPDATE takes SET state = 'action_required' WHERE id = $1", [currentTakeId]);
    await db.insert(jobs).values({ id: "99999999-9999-4999-8999-999999999999", ownerUserId, playId,
      kind: "process_take", status: "action_required", attemptCount: 3,
      errorCode: "TRANSCRIPTION_FAILURE", dedupeKey: "process_take:failed-take",
      payload: { takeId: currentTakeId } });

    const response = await handler(ownerUserId)(new Request("http://localhost/take"), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      take: { state: "action_required" },
      coaching: { status: "action_required", report: null, synthesisErrorCode: "TRANSCRIPTION_FAILURE" },
    });
  });

  it("returns 404 for another owner without revealing whether the take exists", async () => {
    const response = await handler(otherUserId)(new Request("http://localhost/take"), context());

    expect(response.status).toBe(404);
  });

  it("keeps the report but marks evidence playback unavailable after deletion", async () => {
    await client.query("UPDATE takes SET audio_deleted_at = '2026-08-22T16:00:00Z' WHERE id = $1",
      [currentTakeId]);

    const response = await handler(ownerUserId)(new Request("http://localhost/take"), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      take: { id: currentTakeId, audioDeletedAt: "2026-08-22T16:00:00.000Z" },
      coaching: { status: "completed", report: expect.any(Object) },
      audioUrl: null,
    });
  });

  function handler(userId: string) {
    return createTakeReportHandler({ authenticate: async () => ({ id: userId }), db });
  }

  async function insertCompletedTake(takeId: string, createdAt: string, lineAccuracy: number) {
    const transcriptId = takeId.replace(/^./, "a");
    const measurementId = takeId.replace(/^./, "b");
    await db.insert(takes).values({ id: takeId, ownerUserId, practiceSessionId: sessionId, playId,
      playModelId: modelId, playModelVersion: 1, sceneId: "scene", roleId: "alex", retentionChoice: "retain",
      durationMs: 1_000, mediaType: "audio/wav", objectKey: `users/${ownerUserId}/takes/${takeId}.wav`,
      state: "completed", createdAt: new Date(createdAt), updatedAt: new Date(createdAt) });
    await db.insert(takeTranscripts).values({ id: transcriptId, ownerUserId, takeId,
      audioSha256: "a".repeat(64), transcriberVersion: "v1", provider: "fake", modelName: "fake",
      language: "en", text: "Line", timingSource: "whisper_word_timestamps", status: "current",
      createdAt: new Date(createdAt), updatedAt: new Date(createdAt) });
    await db.insert(takeMetrics).values({ id: measurementId, ownerUserId, takeId, transcriptId,
      transcriptStatus: "current", measurementVersion: "v1", metrics: metricSummary(),
      createdAt: new Date(createdAt), updatedAt: new Date(createdAt) });
    const evidence = coachingEvidence();
    await db.insert(coachingReports).values({ ownerUserId, playId, takeId, transcriptId,
      transcriptStatus: "current", measurementId, status: "completed", audioReviewStatus: "completed",
      evidence, report: coachingReport(lineAccuracy), createdAt: new Date(createdAt), updatedAt: new Date(createdAt) });
  }
});

function context() { return { params: Promise.resolve({ playId, takeId: currentTakeId }) }; }

function coachingEvidence(): CoachingEvidence[] {
  return [{ id: "line-accuracy", kind: "transcript_alignment", confidence: "high",
    description: "Aligned line accuracy.", startMs: null, endMs: null, elementIds: ["line"] }];
}

function coachingReport(lineAccuracy: number): CoachingReport {
  return { ratings: [
    { category: "line_accuracy", score: lineAccuracy, confidence: "high", evidenceIds: ["line-accuracy"] },
    { category: "clarity", score: null, confidence: "low", evidenceIds: [] },
    { category: "pacing", score: null, confidence: "low", evidenceIds: [] },
    { category: "cue_responsiveness", score: null, confidence: "low", evidenceIds: [] },
    { category: "vocal_variation", score: null, confidence: "low", evidenceIds: [] },
  ], strengths: [], priorities: [], exercise: { title: "Repeat", instructions: "Repeat the line.",
    targetCategory: "line_accuracy", evidenceIds: ["line-accuracy"] }, interpretationNotes: [] };
}

function metricSummary() {
  return { durationMs: 1_000, speechDurationMs: 600, silenceDurationMs: 400, pauses: [], alignmentCoverage: 1,
    clippingRatio: 0, technicalWarnings: [], wordsPerMinute: 120,
    pace: { confidence: "high" as const, score: 80, wordsPerMinute: 120, wordCount: 2 },
    loudness: { confidence: "high" as const, score: 80, rmsDb: -18, rangeDb: 6 },
    pitch: { confidence: "high" as const, score: 80, medianHz: 220, rangeHz: 80, voicedFrames: 20 } };
}
