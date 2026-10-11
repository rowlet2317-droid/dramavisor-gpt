import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { analysisArtifacts, coachingReports, playModels, plays, practiceSessions, takeMetrics,
  takeTranscripts, takes, users } from "@drama/db/schema";
import type { CoachingEvidence, CoachingReport } from "@drama/domain/coaching";

import { createExerciseHandler } from "./handler";

const migrations = ["0001_foundation.sql", "0002_play_processing_status.sql", "0002_practice_sessions.sql",
  "0003_reviewable_parse_jobs.sql", "0004_job_lease_fencing.sql", "0005_grounded_study.sql",
  "0006_current_artifact_uniqueness.sql", "0007_take_transcripts.sql", "0008_ordered_transcript_evidence.sql",
  "0009_take_metrics.sql", "0010_normalized_audio_artifacts.sql", "0011_stale_attempt_cleanup.sql",
  "0012_cleanup_attempt_history.sql", "0013_immutable_normalized_audio_keys.sql", "0014_coaching_reports.sql",
  "0015_take_audio_retention.sql", "0016_global_job_lease_history.sql", "0017_rehearsal_sessions.sql",
  "0018_rehearsal_events.sql", "0019_account_deletion.sql", "0020_rehearsal_linked_coaching.sql"];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const playId = "33333333-3333-4333-8333-333333333333";
const modelId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
const takeId = "66666666-6666-4666-8666-666666666666";
const transcriptId = "77777777-7777-4777-8777-777777777777";
const measurementId = "88888888-8888-4888-8888-888888888888";
const sceneId = "model:v1:scene:1";
const roleId = "model:v1:character:1";
const lineId = "model:v1:element:1";

describe("POST exercise session", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    for (const name of migrations) {
      await client.exec(await readFile(new URL(`../../../../../../../packages/db/migrations/${name}`,
        import.meta.url), "utf8"));
    }
    db = drizzle(client, { schema });
    await db.insert(users).values([
      { id: ownerUserId, email: "actor@example.com", passwordHash: "hash" },
      { id: otherUserId, email: "other@example.com", passwordHash: "hash" },
    ]);
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(playModels).values({ id: modelId, ownerUserId, playId, version: 1,
      status: "approved", model: playModel(), issues: [] });
    await db.insert(analysisArtifacts).values({ ownerUserId, playId, kind: `role_workbook:${roleId}`,
      status: "current", content: workbook() });
    await db.insert(practiceSessions).values({ id: sessionId, ownerUserId, playId, playModelId: modelId,
      playModelVersion: 1, sceneId, roleId, retentionChoice: "retain" });
    await db.insert(takes).values({ id: takeId, ownerUserId, practiceSessionId: sessionId, playId,
      playModelId: modelId, playModelVersion: 1, sceneId, roleId, retentionChoice: "retain",
      durationMs: 1_000, mediaType: "audio/wav", objectKey: "private.wav", state: "completed" });
    await db.insert(takeTranscripts).values({ id: transcriptId, ownerUserId, takeId, audioSha256: "a".repeat(64),
      transcriberVersion: "v1", provider: "fake", modelName: "fake", language: "en", text: "Stay here",
      timingSource: "whisper_word_timestamps" });
    await db.insert(takeMetrics).values({ id: measurementId, ownerUserId, takeId, transcriptId,
      measurementVersion: "v1", metrics: metricSummary() });
    const evidence: CoachingEvidence[] = [{ id: "line-accuracy", kind: "transcript_alignment",
      confidence: "high", description: "Aligned line.", startMs: 0, endMs: 500, elementIds: [lineId] }];
    await db.insert(coachingReports).values({ ownerUserId, playId, takeId, transcriptId, measurementId,
      status: "completed", audioReviewStatus: "completed", evidence, report: report() });
  });

  afterEach(async () => client.close());

  it("grounds the selected exercise in the latest completed report", async () => {
    const handler = createExerciseHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      createId: () => "99999999-9999-4999-8999-999999999999",
      now: () => new Date("2026-08-22T17:00:00Z") });

    const response = await handler(request({ playModelVersion: 1, sceneId, roleId,
      kind: "repeat_line" }), context());

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ session: expect.objectContaining({
      id: "99999999-9999-4999-8999-999999999999", ownerUserId, playId, playModelId: modelId,
      playModelVersion: 1, sceneId, roleId, kind: "repeat_line", targetElementIds: [lineId],
      prompt: "Repeat the line and let the final word land.", state: "ready", currentTurn: 1, maxTurns: 4,
      createdAt: "2026-08-22T17:00:00.000Z", updatedAt: "2026-08-22T17:00:00.000Z",
    }) });
  });

  it("returns owner-safe 404 and rejects unknown exercise kinds", async () => {
    expect((await createExerciseHandler({ authenticate: async () => ({ id: otherUserId }), db })(
      request({ playModelVersion: 1, sceneId, roleId, kind: "repeat_line" }), context())).status).toBe(404);
    expect((await createExerciseHandler({ authenticate: async () => ({ id: ownerUserId }), db })(
      request({ playModelVersion: 1, sceneId, roleId, kind: "improv" }), context())).status).toBe(422);
  });
});

function request(body: Record<string, unknown>) {
  return new Request("http://local/exercises", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });
}

function context() { return { params: Promise.resolve({ playId }) }; }

function playModel() {
  return { id: "model:v1", title: "Private Play", language: "en" as const,
    characters: [{ id: roleId, name: "Alex", aliases: [] }], acts: [{ id: "act", ordinal: 1,
      title: "Act I", scenes: [{ id: sceneId, ordinal: 1, title: "Scene", characterIds: [roleId],
        elements: [{ id: lineId, ordinal: 1, kind: "dialogue" as const, characterId: roleId,
          text: "Stay here.", sourcePage: 1 }] }] }] };
}

function workbook() {
  return { id: "workbook", characterId: roleId, directorConcept: null, circumstances: [], relationships: [],
    superObjectiveOptions: [], sceneObjectives: [{ id: "objective", text: "Make them stay.",
      epistemicStatus: "interpretation", reference: { playId, elementIds: [lineId] } }], obstacles: [], stakes: [],
    tactics: [], entranceExitStates: [], beats: [], subtextOptions: [], referencedStageDirections: [] };
}

function report(): CoachingReport {
  return { ratings: [
    { category: "line_accuracy", score: 80, confidence: "high", evidenceIds: ["line-accuracy"] },
    { category: "clarity", score: null, confidence: "low", evidenceIds: [] },
    { category: "pacing", score: null, confidence: "low", evidenceIds: [] },
    { category: "cue_responsiveness", score: null, confidence: "low", evidenceIds: [] },
    { category: "vocal_variation", score: null, confidence: "low", evidenceIds: [] },
  ], strengths: [], priorities: [{ text: "Land the final word.", evidenceIds: ["line-accuracy"] }],
  exercise: { title: "Final word", instructions: "Repeat the line and let the final word land.",
    targetCategory: "line_accuracy", evidenceIds: ["line-accuracy"] }, interpretationNotes: [] };
}

function metricSummary() {
  return { durationMs: 1_000, speechDurationMs: 600, silenceDurationMs: 400, pauses: [], alignmentCoverage: 1,
    clippingRatio: 0, technicalWarnings: [], wordsPerMinute: 120,
    pace: { confidence: "high" as const, score: 80, wordsPerMinute: 120, wordCount: 2 },
    loudness: { confidence: "high" as const, score: 80, rmsDb: -18, rangeDb: 6 },
    pitch: { confidence: "high" as const, score: 80, medianHz: 220, rangeHz: 80, voicedFrames: 20 } };
}
