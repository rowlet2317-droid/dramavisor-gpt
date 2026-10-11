import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";

import { FakeAudioReviewer } from "@drama/ai/audio-review/fake-audio-review";
import { FakeCoach } from "@drama/ai/coaching/fake-coach";
import type { Coach, CoachingSynthesisRequest } from "@drama/ai/coaching/port";
import * as schema from "@drama/db/schema";
import { coachingReports, cueResponseEvidence, jobs, takeStageJobChains, takes } from "@drama/db/schema";
import type { CoachingEvidence, CoachingReport } from "@drama/domain/coaching";
import { MemoryObjectStorage } from "@drama/storage/memory-storage";

import { failReviewAudioJob, runReviewAudioJob } from "./review-audio";
import { failSynthesizeCoachingJob, runSynthesizeCoachingJob } from "./synthesize-coaching";
import { claimNextJob } from "./claim";

const migrations = ["0001_foundation.sql", "0002_play_processing_status.sql", "0002_practice_sessions.sql",
  "0003_reviewable_parse_jobs.sql", "0004_job_lease_fencing.sql", "0005_grounded_study.sql",
  "0006_current_artifact_uniqueness.sql", "0007_take_transcripts.sql", "0008_ordered_transcript_evidence.sql",
  "0009_take_metrics.sql", "0010_normalized_audio_artifacts.sql", "0011_stale_attempt_cleanup.sql",
  "0012_cleanup_attempt_history.sql", "0013_immutable_normalized_audio_keys.sql", "0014_coaching_reports.sql",
  "0015_take_audio_retention.sql", "0017_rehearsal_sessions.sql", "0018_rehearsal_events.sql",
  "0019_account_deletion.sql", "0020_rehearsal_linked_coaching.sql"];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const playId = "22222222-2222-4222-8222-222222222222";
const modelId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const takeId = "55555555-5555-4555-8555-555555555555";
const transcriptId = "66666666-6666-4666-8666-666666666666";
const measurementId = "77777777-7777-4777-8777-777777777777";
const artifactId = "88888888-8888-4888-8888-888888888888";
const reviewJobId = "99999999-9999-4999-8999-999999999999";
const reviewLease = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const synthLease = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sceneId = "model:v1:act:1:scene:1";
const roleId = "model:v1:character:1";
const lineId = "model:v1:element:1";
const cueLineId = "model:v1:element:cue";
const rehearsalSessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const cueEventId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const actorEventId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const cueEvidenceId = "13131313-1313-4313-8313-131313131313";

describe("coaching pipeline jobs", () => {
  let client: PGlite;

  afterEach(async () => client?.close());

  it("persists grounded audio observations and idempotently hands off synthesis", async () => {
    const { db, storage } = await setup(1);
    await db.update(takes).set({ durationMs: 500 }).where(eq(takes.id, takeId));
    const audioEvidence: CoachingEvidence = { id: "audio-1", kind: "audio_observation", confidence: "high",
      description: "The final word is audibly quieter.", startMs: 100, endMs: 5_000, elementIds: [lineId] };
    const reviewer = new FakeAudioReviewer([[audioEvidence]]);

    await runReviewAudioJob({ db, ownerUserId, jobId: reviewJobId, leaseToken: reviewLease,
      attemptCount: 1, reviewer, normalizedAudioStorage: storage });

    expect(reviewer.calls[0]).toMatchObject({ durationMs: 1_000, sceneObjective: "Make Jordan stay.",
      selectedInterpretation: "The plea is disguised as a joke.",
      lines: [{ elementId: lineId, text: "You could stay." }] });
    const [stored] = await db.select().from(coachingReports);
    expect(stored).toMatchObject({ ownerUserId, takeId, transcriptId, status: "processing",
      audioReviewStatus: "completed" });
    expect(stored!.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "line-accuracy", kind: "transcript_alignment" }),
      expect.objectContaining({ id: "metric-pace", kind: "deterministic_metric" }),
      { ...audioEvidence, startMs: 0, endMs: 600 },
    ]));
    const synthesisJobs = (await db.select().from(jobs)).filter(({ kind }) => kind === "synthesize_coaching");
    expect(synthesisJobs).toHaveLength(1);
    expect(synthesisJobs[0]).toMatchObject({ status: "queued",
      payload: { takeId, transcriptId, measurementId } });
  });

  it("falls back after two audio-review failures and completes with limitations", async () => {
    const { db, storage } = await setup(2);
    const reviewer = new FakeAudioReviewer([new Error("provider unavailable")]);

    await expect(runReviewAudioJob({ db, ownerUserId, jobId: reviewJobId, leaseToken: reviewLease,
      attemptCount: 2, reviewer, normalizedAudioStorage: storage })).rejects.toThrow("provider unavailable");
    await failReviewAudioJob({ db, ownerUserId, jobId: reviewJobId, leaseToken: reviewLease,
      attemptCount: 2, code: "AUDIO_REVIEW_FAILURE" });

    const [fallback] = await db.select().from(coachingReports);
    expect(fallback).toMatchObject({ audioReviewStatus: "failed", status: "processing", report: null });
    expect(fallback!.evidence.length).toBeGreaterThan(0);
    const synthJob = (await db.select().from(jobs)).find(({ kind }) => kind === "synthesize_coaching")!;
    const claimed = await claimNextJob({ db, ownerUserId, now: synthJob.availableAt });
    expect(claimed).toMatchObject({ id: synthJob.id, kind: "synthesize_coaching", attemptCount: 1 });
    const coach = new FakeCoach([validReport(fallback!.evidence)]);

    await runSynthesizeCoachingJob({ db, ownerUserId, jobId: synthJob.id, leaseToken: claimed!.leaseToken!,
      attemptCount: 1, coach });

    expect(coach.calls[0]).toMatchObject({ soloCompleteTake: true, sceneObjective: "Make Jordan stay.",
      previousComparableTakeSummary: null });
    expect((await db.select().from(coachingReports))[0]).toMatchObject({
      status: "completed_with_limitations", report: expect.any(Object),
    });
    expect((await db.select().from(takes))[0]!.state).toBe("completed_with_limitations");
  });

  it("completes with evidence-only limitations when provider synthesis is invalid", async () => {
    const { db, storage } = await setup(1);
    await runReviewAudioJob({ db, ownerUserId, jobId: reviewJobId, leaseToken: reviewLease,
      attemptCount: 1, reviewer: new FakeAudioReviewer([[]]), normalizedAudioStorage: storage });
    const synthJob = (await db.select().from(jobs)).find(({ kind }) => kind === "synthesize_coaching")!;
    const claimed = await claimNextJob({ db, ownerUserId, now: synthJob.availableAt });
    const invalid = Object.assign(new Error("provider returned invalid structured coaching"),
      { code: "INVALID_COACHING_SYNTHESIS" });
    const coach: Coach = { synthesize: async () => { throw invalid; } };

    await expect(runSynthesizeCoachingJob({ db, ownerUserId, jobId: synthJob.id,
      leaseToken: claimed!.leaseToken!, attemptCount: claimed!.attemptCount, coach }))
      .resolves.toEqual({ status: "completed_with_limitations" });

    const [report] = await db.select().from(coachingReports);
    expect(report).toMatchObject({ status: "completed_with_limitations", synthesisErrorCode: null,
      report: { priorities: [], strengths: [], interpretationNotes: [],
        exercise: { targetCategory: "line_accuracy" } } });
    expect(report!.report!.ratings.filter(({ score }) => score !== null))
      .toEqual(report!.report!.ratings.filter(({ category }) => category === "line_accuracy"));
    expect((await db.select().from(takes))[0]).toMatchObject({ state: "completed_with_limitations" });
    expect((await db.select().from(jobs)).find(({ id }) => id === synthJob.id))
      .toMatchObject({ status: "completed", errorCode: null });
  });

  it("requires action after two invalid syntheses without discarding intermediate evidence", async () => {
    const { db, storage } = await setup(1);
    await runReviewAudioJob({ db, ownerUserId, jobId: reviewJobId, leaseToken: reviewLease,
      attemptCount: 1, reviewer: new FakeAudioReviewer([[]]), normalizedAudioStorage: storage });
    const before = (await db.select().from(coachingReports))[0]!;
    const synthJob = (await db.select().from(jobs)).find(({ kind }) => kind === "synthesize_coaching")!;
    await db.update(jobs).set({ status: "running", attemptCount: 2, leaseToken: synthLease,
      leaseExpiresAt: new Date("2026-08-22T12:30:00Z") }).where(eq(jobs.id, synthJob.id));

    await failSynthesizeCoachingJob({ db, ownerUserId, jobId: synthJob.id, leaseToken: synthLease,
      attemptCount: 2, code: "INVALID_COACHING_SYNTHESIS" });

    const after = (await db.select().from(coachingReports))[0]!;
    expect(after).toMatchObject({ status: "action_required", report: null,
      synthesisErrorCode: "INVALID_COACHING_SYNTHESIS" });
    expect(after.evidence).toEqual(before.evidence);
    expect((await db.select().from(takes))[0]!.state).toBe("action_required");
    expect((await db.select().from(jobs)).find(({ id }) => id === synthJob.id)).toMatchObject({
      status: "action_required", errorCode: "INVALID_COACHING_SYNTHESIS",
    });
  });

  it("queues audio purge only after a delete-after-analysis report commits", async () => {
    const { db, storage } = await setup(1, "delete_after_analysis");
    await runReviewAudioJob({ db, ownerUserId, jobId: reviewJobId, leaseToken: reviewLease,
      attemptCount: 1, reviewer: new FakeAudioReviewer([[]]), normalizedAudioStorage: storage });
    const evidence = (await db.select().from(coachingReports))[0]!.evidence;
    const synthJob = (await db.select().from(jobs)).find(({ kind }) => kind === "synthesize_coaching")!;
    const claimed = await claimNextJob({ db, ownerUserId, now: synthJob.availableAt });

    await runSynthesizeCoachingJob({ db, ownerUserId, jobId: synthJob.id,
      leaseToken: claimed!.leaseToken!, attemptCount: claimed!.attemptCount,
      coach: new FakeCoach([validReport(evidence)]) });

    expect((await db.select().from(jobs)).filter(({ kind }) => kind === "purge_take_audio"))
      .toEqual([expect.objectContaining({ status: "queued", dedupeKey: `purge_take_audio:${takeId}`,
        payload: { takeId } })]);
    expect((await db.select().from(coachingReports))[0]).toMatchObject({ status: "completed" });
  });

  it("replaces the null cue rating only with persisted qualified rehearsal evidence", async () => {
    // Break caught: synthesis can drop a qualified deterministic score or let the model choose its value.
    const { db, storage } = await setup(1, "retain", "high");
    await runReviewAudioJob({ db, ownerUserId, jobId: reviewJobId, leaseToken: reviewLease,
      attemptCount: 1, reviewer: new FakeAudioReviewer([[]]), normalizedAudioStorage: storage });
    const evidence = (await db.select().from(coachingReports))[0]!.evidence;
    const synthJob = (await db.select().from(jobs)).find(({ kind }) => kind === "synthesize_coaching")!;
    const claimed = await claimNextJob({ db, ownerUserId, now: synthJob.availableAt });
    const coach = new FakeCoach([validReport(evidence)]);

    await runSynthesizeCoachingJob({ db, ownerUserId, jobId: synthJob.id,
      leaseToken: claimed!.leaseToken!, attemptCount: claimed!.attemptCount, coach });

    expect(coach.calls[0]!.evidence).toContainEqual(expect.objectContaining({
      id: `cue-response:${cueEvidenceId}`, kind: "deterministic_metric", confidence: "high",
      description: "Acknowledged rehearsal cue response delay: 740 ms.",
    }));
    expect((await db.select().from(coachingReports))[0]!.report!.ratings).toContainEqual({
      category: "cue_responsiveness", score: 85, confidence: "high",
      evidenceIds: [`cue-response:${cueEvidenceId}`],
    });
  });

  it("rejects stale synthesis when the selected evidence row is downgraded in place", async () => {
    // Break caught: comparing only evidence UUID lets a same-row high-to-low upsert publish stale high coaching.
    const { db, storage } = await setup(1, "retain", "high");
    await runReviewAudioJob({ db, ownerUserId, jobId: reviewJobId, leaseToken: reviewLease,
      attemptCount: 1, reviewer: new FakeAudioReviewer([[]]), normalizedAudioStorage: storage });
    const synthJob = (await db.select().from(jobs)).find(({ kind }) => kind === "synthesize_coaching")!;
    const claimed = await claimNextJob({ db, ownerUserId, now: synthJob.availableAt });
    let release!: () => void;
    let entered!: () => void;
    const modelEntered = new Promise<void>((resolve) => { entered = resolve; });
    const modelRelease = new Promise<void>((resolve) => { release = resolve; });
    const coach: Coach = { synthesize: async (request: CoachingSynthesisRequest) => {
      entered();
      await modelRelease;
      return validReport(request.evidence);
    } };

    const synthesis = runSynthesizeCoachingJob({ db, ownerUserId, jobId: synthJob.id,
      leaseToken: claimed!.leaseToken!, attemptCount: claimed!.attemptCount, coach });
    await modelEntered;
    await db.update(cueResponseEvidence).set({ cueEventId: null, actorEventId: null, clockId: null,
      delayMs: null, confidence: "low", score: null, updatedAt: new Date("2026-08-22T12:05:00Z") })
      .where(eq(cueResponseEvidence.id, cueEvidenceId));
    release();

    await expect(synthesis).rejects.toThrow("INVALID_COACHING_CHAIN");
    expect((await db.select().from(coachingReports))[0]).toMatchObject({ status: "processing", report: null });
    expect((await db.select().from(jobs)).find(({ id }) => id === synthJob.id)).toMatchObject({
      status: "running", leaseToken: claimed!.leaseToken,
    });
  });

  it("preserves low/null cue rating when persisted evidence is unqualified even if a model invents a score", async () => {
    // Break caught: consuming low timing evidence must not promote a model-proposed cue score.
    const { db, storage } = await setup(1, "retain", "low");
    await runReviewAudioJob({ db, ownerUserId, jobId: reviewJobId, leaseToken: reviewLease,
      attemptCount: 1, reviewer: new FakeAudioReviewer([[]]), normalizedAudioStorage: storage });
    const evidence = (await db.select().from(coachingReports))[0]!.evidence;
    const invented = validReport(evidence);
    const cue = invented.ratings.find(({ category }) => category === "cue_responsiveness")!;
    cue.score = 99; cue.confidence = "high"; cue.evidenceIds = ["metric-pace"];
    const synthJob = (await db.select().from(jobs)).find(({ kind }) => kind === "synthesize_coaching")!;
    const claimed = await claimNextJob({ db, ownerUserId, now: synthJob.availableAt });

    await runSynthesizeCoachingJob({ db, ownerUserId, jobId: synthJob.id,
      leaseToken: claimed!.leaseToken!, attemptCount: claimed!.attemptCount,
      coach: new FakeCoach([invented]) });

    expect((await db.select().from(coachingReports))[0]!.report!.ratings).toContainEqual({
      category: "cue_responsiveness", score: null, confidence: "low", evidenceIds: [],
    });
  });

  async function setup(attemptCount: number,
    retentionChoice: "retain" | "delete_after_analysis" = "retain",
    cueEvidence?: "high" | "low") {
    client = new PGlite();
    for (const name of migrations) {
      await client.exec(await readFile(new URL(`../../../../packages/db/migrations/${name}`, import.meta.url), "utf8"));
    }
    const db = drizzle(client, { schema });
    const storage = new MemoryObjectStorage();
    const wav = pcmWav();
    const objectKey = `users/${ownerUserId}/plays/${playId}/takes/${takeId}/transcripts/${transcriptId}/normalized/audio.wav`;
    const write = await storage.putPrivateVersioned(objectKey, wav, "audio/wav");
    await db.insert(schema.users).values({ id: ownerUserId, email: "actor@example.com", passwordHash: "hash" });
    await db.insert(schema.plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(schema.playModels).values({ id: modelId, ownerUserId, playId, version: 1,
      status: "approved", issues: [], model: playModel() });
    if (cueEvidence) {
      await db.insert(schema.rehearsalSessions).values({ id: rehearsalSessionId, ownerUserId, playId,
        playModelId: modelId, playModelVersion: 1, sceneId, actorRoleId: roleId, model: "realtime",
        grantExpiresAt: new Date("2026-08-22T12:30:00Z"), state: "completed" });
      if (cueEvidence === "high") await db.insert(schema.rehearsalEvents).values([
        { id: cueEventId, ownerUserId, rehearsalSessionId, sequence: 1, type: "ai_speech_finished",
          event: { type: "ai_speech_finished", sequence: 1, characterId: "cue-role", elementId: cueLineId,
            endedAtMs: 10_000 } },
        { id: actorEventId, ownerUserId, rehearsalSessionId, sequence: 2, type: "actor_line_final",
          event: { type: "actor_line_final", sequence: 2, text: "You could stay", endedAtMs: 10_740 } },
      ]);
    }
    await db.insert(schema.analysisArtifacts).values({ ownerUserId, playId, kind: `role_workbook:${roleId}`,
      status: "current", content: roleWorkbook() });
    await db.insert(schema.practiceSessions).values({ id: sessionId, ownerUserId, playId, playModelId: modelId,
      playModelVersion: 1, sceneId, roleId, selectedInterpretation: "The plea is disguised as a joke.",
      retentionChoice });
    await db.insert(takes).values({ id: takeId, ownerUserId, practiceSessionId: sessionId, playId,
      playModelId: modelId, playModelVersion: 1, sceneId, roleId,
      selectedInterpretation: "The plea is disguised as a joke.", retentionChoice,
      durationMs: 1_000, mediaType: "audio/wav", objectKey: "source.wav", state: "processing",
      rehearsalSessionId: cueEvidence ? rehearsalSessionId : null });
    await db.insert(schema.takeTranscripts).values({ id: transcriptId, ownerUserId, takeId,
      audioSha256: "a".repeat(64), transcriberVersion: "v1", provider: "fake", modelName: "fake",
      language: "en", text: "You could stay", timingSource: "whisper_word_timestamps", status: "current" });
    await db.insert(schema.transcriptWords).values([
      { ownerUserId, transcriptId, ordinal: 1, text: "You", startMs: 0, endMs: 200, confidence: 1 },
      { ownerUserId, transcriptId, ordinal: 2, text: "could", startMs: 200, endMs: 400, confidence: 1 },
      { ownerUserId, transcriptId, ordinal: 3, text: "stay", startMs: 400, endMs: 600, confidence: 1 },
    ]);
    await db.insert(schema.lineAlignments).values({ ownerUserId, transcriptId, elementId: lineId,
      scriptOrdinal: 1, transcriptStartMs: 0, transcriptEndMs: 600, similarity: 1, status: "matched" });
    await db.insert(schema.normalizedAudioArtifacts).values({ id: artifactId, ownerUserId, playId, takeId,
      transcriptId, transcriptStatus: "current", canonicalObjectKey: objectKey,
      contentSha256: createHash("sha256").update(wav).digest("hex"), storageVersionToken: write.versionToken });
    await db.insert(schema.takeMetrics).values({ id: measurementId, ownerUserId, takeId, transcriptId,
      transcriptStatus: "current", measurementVersion: "measure-v1", metrics: metricSummary() });
    if (cueEvidence) await db.insert(cueResponseEvidence).values({ id: cueEvidenceId,
      ownerUserId, takeId, rehearsalSessionId,
      measurementVersion: "cue-response-v1", cueEventId: cueEvidence === "high" ? cueEventId : null,
      actorEventId: cueEvidence === "high" ? actorEventId : null,
      clockId: cueEvidence === "high" ? `provider:${rehearsalSessionId}` : null,
      delayMs: cueEvidence === "high" ? 740 : null, confidence: cueEvidence, score: cueEvidence === "high" ? 85 : null });
    await db.insert(jobs).values({ id: reviewJobId, ownerUserId, playId, kind: "review_audio", status: "running",
      leaseToken: reviewLease, leaseExpiresAt: new Date("2026-08-22T12:30:00Z"), attemptCount,
      dedupeKey: `review_audio:${transcriptId}:measure-v1`,
      payload: { takeId, transcriptId, measurementId, normalizedAudioArtifactId: artifactId } });
    await db.insert(takeStageJobChains).values({ jobId: reviewJobId, ownerUserId, playId, takeId, transcriptId,
      transcriptStatus: "current", stageKind: "review_audio" });
    return { db, storage };
  }
});

function playModel() {
  return { id: "model:v1", title: "Private Play", language: "en" as const,
    characters: [{ id: "cue-role", name: "Jordan", aliases: [] }, { id: roleId, name: "Alex", aliases: [] }],
    acts: [{ id: "model:v1:act:1", ordinal: 1, title: "Act I", scenes: [{ id: sceneId, ordinal: 1,
      title: "Scene 1", characterIds: ["cue-role", roleId], elements: [
        { id: cueLineId, ordinal: 1, kind: "dialogue" as const, characterId: "cue-role",
          text: "I should leave.", sourcePage: 1 },
        { id: lineId, ordinal: 2, kind: "dialogue" as const, characterId: roleId,
          text: "You could stay.", sourcePage: 1 },
      ] }] }] };
}

function roleWorkbook() {
  const objective = { id: "objective-1", text: "Make Jordan stay.", epistemicStatus: "interpretation" as const,
    reference: { playId, elementIds: [lineId] } };
  return { id: "role-1", characterId: roleId, directorConcept: null, circumstances: [], relationships: [],
    superObjectiveOptions: [], sceneObjectives: [objective], obstacles: [], stakes: [], tactics: [],
    entranceExitStates: [], beats: [], subtextOptions: [], referencedStageDirections: [] };
}

function metricSummary() {
  return { durationMs: 1_000, speechDurationMs: 600, silenceDurationMs: 400, pauses: [],
    alignmentCoverage: 1, clippingRatio: 0, technicalWarnings: [], wordsPerMinute: 120,
    pace: { confidence: "high" as const, score: 80, wordsPerMinute: 120, wordCount: 3 },
    loudness: { confidence: "high" as const, score: 75, rmsDb: -18, rangeDb: 6 },
    pitch: { confidence: "medium" as const, score: 70, medianHz: 220, rangeHz: 80, voicedFrames: 20 } };
}

function validReport(evidence: CoachingEvidence[]): CoachingReport {
  const lineAccuracy = evidence.find(({ id }) => id === "line-accuracy")!;
  const pace = evidence.find(({ id }) => id === "metric-pace")!;
  return { ratings: [
    { category: "line_accuracy", score: 100, confidence: "high", evidenceIds: [lineAccuracy.id] },
    { category: "clarity", score: null, confidence: "low", evidenceIds: [] },
    { category: "pacing", score: 80, confidence: "high", evidenceIds: [pace.id] },
    { category: "cue_responsiveness", score: null, confidence: "low", evidenceIds: [] },
    { category: "vocal_variation", score: null, confidence: "low", evidenceIds: [] },
  ], strengths: [{ text: "Steady pace.", evidenceIds: [pace.id] }],
  priorities: [{ text: "Vary one beat.", evidenceIds: [pace.id] }],
  exercise: { title: "Tempo ladder", instructions: "Repeat at three tempos.", targetCategory: "pacing",
    evidenceIds: [pace.id] }, interpretationNotes: [] };
}

function pcmWav(): Uint8Array {
  const samples = new Int16Array(16_000);
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  bytes.set([82, 73, 70, 70], 0); view.setUint32(4, bytes.length - 8, true); bytes.set([87, 65, 86, 69], 8);
  bytes.set([102, 109, 116, 32], 12); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); bytes.set([100, 97, 116, 97], 36);
  view.setUint32(40, samples.length * 2, true);
  return bytes;
}
