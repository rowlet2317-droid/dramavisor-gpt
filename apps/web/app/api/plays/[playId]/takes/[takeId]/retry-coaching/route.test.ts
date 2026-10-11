import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { coachingReports, jobs, normalizedAudioArtifacts, playModels, plays, practiceSessions, takeMetrics, takeStageJobChains,
  takeTranscripts, takes, users } from "@drama/db/schema";

import { createRetryCoachingHandler } from "./handler";

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
const takeId = "66666666-6666-4666-8666-666666666666";
const transcriptId = "77777777-7777-4777-8777-777777777777";
const measurementId = "88888888-8888-4888-8888-888888888888";
const jobId = "99999999-9999-4999-8999-999999999999";

describe("POST retry coaching", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    for (const name of migrations) {
      await client.exec(await readFile(new URL("../../../../../../../../../packages/db/migrations/" + name,
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
    await db.insert(takes).values({ id: takeId, ownerUserId, practiceSessionId: sessionId, playId,
      playModelId: modelId, playModelVersion: 1, sceneId: "scene", roleId: "alex", retentionChoice: "retain",
      durationMs: 1_000, mediaType: "audio/wav", objectKey: "source.wav", state: "action_required" });
    await db.insert(takeTranscripts).values({ id: transcriptId, ownerUserId, takeId,
      audioSha256: "a".repeat(64), transcriberVersion: "v1", provider: "fake", modelName: "fake",
      language: "en", text: "Line", timingSource: "whisper_word_timestamps", status: "current" });
    await db.insert(takeMetrics).values({ id: measurementId, ownerUserId, takeId, transcriptId,
      transcriptStatus: "current", measurementVersion: "measure-v1", metrics: metricSummary() });
    await db.insert(coachingReports).values({ ownerUserId, playId, takeId, transcriptId,
      transcriptStatus: "current", measurementId, status: "action_required", audioReviewStatus: "completed",
      evidence: [], report: null, synthesisErrorCode: "OPENAI_COACHING_HTTP_400" });
    await db.insert(jobs).values({ id: jobId, ownerUserId, playId, kind: "synthesize_coaching",
      status: "action_required", attemptCount: 2, errorCode: "OPENAI_COACHING_HTTP_400",
      dedupeKey: "synthesize_coaching:" + transcriptId + ":measure-v1",
      payload: { takeId, transcriptId, measurementId } });
    await db.insert(takeStageJobChains).values({ jobId, ownerUserId, playId, takeId, transcriptId,
      transcriptStatus: "current", stageKind: "synthesize_coaching" });
  });

  afterEach(async () => client.close());

  it("requeues only the existing synthesis job and preserves the completed pipeline evidence", async () => {
    const response = await handler(ownerUserId)(new Request("http://localhost/retry", { method: "POST" }), context());

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ take: { id: takeId, state: "processing" } });
    expect((await db.select().from(takes))[0]).toMatchObject({ state: "processing" });
    expect((await db.select().from(coachingReports))[0]).toMatchObject({
      status: "processing", synthesisErrorCode: null, evidence: [],
    });
    expect((await db.select().from(jobs))[0]).toMatchObject({
      id: jobId, status: "queued", attemptCount: 0, errorCode: null, leaseToken: null,
    });
  });

  it("repairs a missing stage-chain row before requeueing the exact synthesis job", async () => {
    await db.delete(takeStageJobChains);
    const response = await handler(ownerUserId)(new Request("http://localhost/retry", { method: "POST" }), context());

    expect(response.status).toBe(202);
    expect((await db.select().from(takeStageJobChains))).toEqual([expect.objectContaining({
      jobId, takeId, transcriptId, stageKind: "synthesize_coaching",
    })]);
  });

  it("requeues the actual failed earlier pipeline stage when no coaching report exists", async () => {
    await db.delete(takeStageJobChains);
    await db.delete(coachingReports);
    await db.update(jobs).set({ kind: "process_take", status: "action_required", attemptCount: 3,
      errorCode: "TRANSCRIPTION_FAILURE", dedupeKey: `process_take:${takeId}`, payload: { takeId } })
      .where(eq(jobs.id, jobId));

    const response = await handler(ownerUserId)(new Request("http://localhost/retry", { method: "POST" }), context());

    expect(response.status).toBe(202);
    expect((await db.select().from(takes))[0]).toMatchObject({ state: "processing" });
    expect((await db.select().from(jobs))[0]).toMatchObject({
      id: jobId, kind: "process_take", status: "queued", attemptCount: 0, errorCode: null,
    });
  });

  it("requeues a failed measurement even when an older worker left the take marked completed", async () => {
    await db.update(takes).set({ state: "completed" }).where(eq(takes.id, takeId));
    await db.delete(takeStageJobChains);
    const artifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await db.insert(normalizedAudioArtifacts).values({ id: artifactId, ownerUserId, playId, takeId, transcriptId,
      transcriptStatus: "current", canonicalObjectKey: `users/${ownerUserId}/plays/${playId}/takes/${takeId}`
        + `/transcripts/${transcriptId}/normalized.wav`, contentSha256: "b".repeat(64),
      storageVersionToken: "version-1" });
    await db.update(jobs).set({ kind: "measure_take", status: "action_required", attemptCount: 3,
      errorCode: "JOB_FAILURE", dedupeKey: `measure_take:${transcriptId}`,
      payload: { takeId, transcriptId, normalizedAudioArtifactId: artifactId } })
      .where(eq(jobs.id, jobId));
    await db.insert(takeStageJobChains).values({ jobId, ownerUserId, playId, takeId, transcriptId,
      transcriptStatus: "current", stageKind: "measure_take" });

    const response = await handler(ownerUserId)(new Request("http://localhost/retry", { method: "POST" }), context());

    expect(response.status).toBe(202);
    expect((await db.select().from(takes))[0]).toMatchObject({ state: "processing" });
    expect((await db.select().from(jobs))[0]).toMatchObject({
      id: jobId, kind: "measure_take", status: "queued", attemptCount: 0, errorCode: null,
    });
  });

  it("recovers an older failed take whose report is still marked processing", async () => {
    await client.query("UPDATE coaching_reports SET status = 'processing' WHERE take_id = $1", [takeId]);
    await db.delete(takeStageJobChains);
    await db.delete(jobs);

    const response = await handler(ownerUserId)(new Request("http://localhost/retry", { method: "POST" }), context());

    expect(response.status).toBe(202);
    expect((await db.select().from(coachingReports))[0]).toMatchObject({ status: "processing" });
    expect((await db.select().from(jobs))).toEqual([expect.objectContaining({
      kind: "synthesize_coaching", status: "queued",
    })]);
  });

  it("recreates a missing synthesis job from the preserved report chain", async () => {
    await db.delete(takeStageJobChains);
    await db.delete(jobs);
    const response = await handler(ownerUserId)(new Request("http://localhost/retry", { method: "POST" }), context());

    expect(response.status).toBe(202);
    expect((await db.select().from(jobs))).toEqual([expect.objectContaining({
      kind: "synthesize_coaching", status: "queued", attemptCount: 0,
      payload: { takeId, transcriptId, measurementId },
    })]);
  });

  it("requeues a completed synthesis job when the user redoes a report analysis", async () => {
    await db.update(takes).set({ state: "completed" }).where(eq(takes.id, takeId));
    await db.update(coachingReports).set({ status: "completed", synthesisErrorCode: null,
      report: { ratings: [], strengths: [], priorities: [], interpretationNotes: [],
        exercise: { title: "Try again", instructions: "Repeat the line.", targetCategory: "clarity",
          evidenceIds: [] } } }).where(eq(coachingReports.takeId, takeId));
    await db.update(jobs).set({ status: "completed", attemptCount: 1, errorCode: null })
      .where(eq(jobs.id, jobId));

    const response = await handler(ownerUserId)(new Request("http://localhost/retry", { method: "POST" }), context());

    expect(response.status).toBe(202);
    expect((await db.select().from(takes))[0]).toMatchObject({ state: "processing" });
    expect((await db.select().from(coachingReports))[0]).toMatchObject({
      status: "processing", report: expect.any(Object), synthesisErrorCode: null,
    });
    expect((await db.select().from(jobs))[0]).toMatchObject({
      id: jobId, status: "queued", attemptCount: 0, errorCode: null,
    });
  });

  it("reruns audio review for a retained completed take before synthesizing new coaching", async () => {
    const artifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const reviewJobId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await db.update(takes).set({ state: "completed" }).where(eq(takes.id, takeId));
    await db.update(coachingReports).set({ status: "completed", synthesisErrorCode: null,
      report: { ratings: [], strengths: [], priorities: [], interpretationNotes: [],
        exercise: { title: "Try again", instructions: "Repeat the line.", targetCategory: "clarity",
          evidenceIds: [] } } }).where(eq(coachingReports.takeId, takeId));
    await db.update(jobs).set({ status: "completed", attemptCount: 1, errorCode: null })
      .where(eq(jobs.id, jobId));
    await db.insert(normalizedAudioArtifacts).values({ id: artifactId, ownerUserId, playId, takeId, transcriptId,
      transcriptStatus: "current", canonicalObjectKey: `users/${ownerUserId}/plays/${playId}/takes/${takeId}`
        + `/transcripts/${transcriptId}/normalized.wav`, contentSha256: "b".repeat(64),
      storageVersionToken: "version-1" });
    await db.insert(jobs).values({ id: reviewJobId, ownerUserId, playId, kind: "review_audio", status: "completed",
      dedupeKey: `review_audio:${transcriptId}:measure-v1`,
      payload: { takeId, transcriptId, measurementId, normalizedAudioArtifactId: artifactId } });
    await db.insert(takeStageJobChains).values({ jobId: reviewJobId, ownerUserId, playId, takeId, transcriptId,
      transcriptStatus: "current", stageKind: "review_audio" });

    const response = await handler(ownerUserId)(new Request("http://localhost/retry", { method: "POST" }), context());

    expect(response.status).toBe(202);
    expect((await db.select().from(jobs)).find(({ id }) => id === reviewJobId)).toMatchObject({
      status: "queued", attemptCount: 0,
    });
    expect((await db.select().from(jobs)).find(({ id }) => id === jobId)).toMatchObject({ status: "completed" });
    expect((await db.select().from(coachingReports))[0]).toMatchObject({
      status: "processing", audioReviewStatus: "pending", report: null,
    });
  });

  it("does not disclose or retry another user's take", async () => {
    const response = await handler(otherUserId)(new Request("http://localhost/retry", { method: "POST" }), context());

    expect(response.status).toBe(404);
    expect((await db.select().from(jobs))[0]).toMatchObject({ status: "action_required", attemptCount: 2 });
  });

  function handler(userId: string) {
    return createRetryCoachingHandler({ authenticate: async () => ({ id: userId }), db,
      now: () => new Date("2026-09-25T02:00:00Z") });
  }
});

function context() { return { params: Promise.resolve({ playId, takeId }) }; }

function metricSummary() {
  return { durationMs: 1_000, speechDurationMs: 600, silenceDurationMs: 400, pauses: [], alignmentCoverage: 1,
    clippingRatio: 0, technicalWarnings: [], wordsPerMinute: 120,
    pace: { confidence: "high" as const, score: 80, wordsPerMinute: 120, wordCount: 2 },
    loudness: { confidence: "high" as const, score: 80, rmsDb: -18, rangeDb: 6 },
    pitch: { confidence: "high" as const, score: 80, medianHz: 220, rangeHz: 80, voicedFrames: 20 } };
}
