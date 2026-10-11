import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { cueResponseEvidence, jobs, normalizedAudioArtifacts, takeMetricLines, takeMetrics,
  takeStageJobChains, takeTranscripts } from "@drama/db/schema";
import { MemoryObjectStorage } from "@drama/storage/memory-storage";
import { ScriptExtractor } from "@drama/media/scripts/extract";

import { runLimitedMeasureTakeJob, runMeasureTakeJob } from "./measure-take";
import { runWorkerOnce } from "../index";
import { createRehearsalEventHandler } from "../../../web/app/api/rehearsals/[sessionId]/events/handler";

const migrations = ["0001_foundation.sql", "0002_play_processing_status.sql", "0002_practice_sessions.sql",
  "0003_reviewable_parse_jobs.sql", "0004_job_lease_fencing.sql", "0005_grounded_study.sql",
  "0006_current_artifact_uniqueness.sql", "0007_take_transcripts.sql", "0008_ordered_transcript_evidence.sql",
  "0009_take_metrics.sql", "0010_normalized_audio_artifacts.sql", "0011_stale_attempt_cleanup.sql",
  "0012_cleanup_attempt_history.sql", "0013_immutable_normalized_audio_keys.sql",
  "0015_take_audio_retention.sql", "0017_rehearsal_sessions.sql", "0018_rehearsal_events.sql",
  "0019_account_deletion.sql", "0020_rehearsal_linked_coaching.sql"];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const playId = "22222222-2222-4222-8222-222222222222";
const modelId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const takeId = "55555555-5555-4555-8555-555555555555";
const transcriptId = "66666666-6666-4666-8666-666666666666";
const jobId = "77777777-7777-4777-8777-777777777777";
const artifactId = "88888888-8888-4888-8888-888888888888";
const leaseToken = "99999999-9999-4999-8999-999999999999";
const rehearsalSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const cueEventId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const actorEventId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("runMeasureTakeJob", () => {
  let client: PGlite;

  afterEach(async () => client?.close());

  it("persists deterministic take and line metrics from the registered WAV and transcript words", async () => {
    // Break caught: omitting durable measurement publication or transcript word propagation leaves coaching without truthful pace evidence.
    const { db, storage } = await setup();

    const result = await runMeasureTakeJob({
      db, ownerUserId, jobId, leaseToken, attemptCount: 1, normalizedAudioStorage: storage,
    });

    expect(result).toMatchObject({ deduplicated: false });
    expect(await db.select().from(takeMetrics)).toEqual([expect.objectContaining({
      ownerUserId, takeId, transcriptId, transcriptStatus: "current", measurementVersion: "measure-v1",
      metrics: expect.objectContaining({ wordsPerMinute: expect.closeTo(120, 0),
        pace: expect.objectContaining({ wordCount: 2, wordsPerMinute: expect.closeTo(120, 0) }),
      }),
    })]);
    expect(await db.select().from(takeMetricLines)).toEqual([expect.objectContaining({
      ownerUserId, transcriptId, elementId: "line-1", startMs: 0, endMs: 1_000,
    })]);
    expect((await db.select().from(jobs)).find(({ id }) => id === jobId))
      .toMatchObject({ status: "completed", leaseToken: null });
    expect((await db.select().from(jobs)).find(({ kind }) => kind === "review_audio"))
      .toMatchObject({ status: "queued", payload: expect.objectContaining({ takeId, transcriptId }) });
  });

  it("publishes owner-scoped cue response evidence from acknowledged matching rehearsal events", async () => {
    // Break caught: measuring audio without the linked acknowledged timeline drops the only truthful cue score.
    const { db, storage } = await setup();

    await runMeasureTakeJob({ db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      normalizedAudioStorage: storage });

    expect(await db.select().from(cueResponseEvidence)).toEqual([expect.objectContaining({
      ownerUserId, takeId, rehearsalSessionId, measurementVersion: "cue-response-v1",
      cueEventId, actorEventId, clockId: "provider:response-stream-7",
      delayMs: 740, confidence: "high", score: 85,
    })]);
  });

  it("uses server receipts for browser-spoofed cue and manual actor events acknowledged by the real handler", async () => {
    // Break caught: the worker must not relabel client endedAtMs or forged provenance as provider-derived.
    const { db, storage } = await setup(undefined, false);
    await db.update(schema.rehearsalSessions).set({ state: "grant_issued" })
      .where(eq(schema.rehearsalSessions.id, rehearsalSessionId));
    const receipts = [9_000, 9_500, 10_000, 10_740].map((atMs) => new Date(atMs));
    const append = createRehearsalEventHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      now: () => receipts.shift()! });
    const events = [
      { type: "started", sequence: 1, startedAtMs: 90_000 },
      { type: "ai_speech_started", sequence: 2, characterId: "cue-role", elementId: "cue-line",
        startedAtMs: 95_000 },
      { type: "ai_speech_finished", sequence: 3, characterId: "cue-role", elementId: "cue-line",
        endedAtMs: 100_000, timingSource: "provider-derived", timingAtMs: 1,
        timingClockId: "provider:spoof" },
      { type: "manual_actor_line_completed", sequence: 4, elementId: "line-1", endedAtMs: 100_100,
        timingSource: "provider-derived", timingAtMs: 2, timingClockId: "provider:spoof" },
    ];
    for (const event of events) {
      const response = await append(rehearsalRequest(event), { params: Promise.resolve({
        sessionId: rehearsalSessionId }) });
      expect(response.status).toBe(201);
    }

    await runMeasureTakeJob({ db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      normalizedAudioStorage: storage });

    expect(await db.select().from(cueResponseEvidence)).toEqual([expect.objectContaining({
      cueEventId: expect.any(String), actorEventId: expect.any(String), clockId: "server:unix-epoch-ms",
      delayMs: 740, confidence: "medium", score: 85,
    })]);
  });

  it("publishes low/null cue evidence when the linked rehearsal has no corresponding completion pair", async () => {
    // Break caught: a linked session id alone must not become an invented responsiveness score.
    const { db, storage } = await setup(undefined, false);

    await runMeasureTakeJob({ db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      normalizedAudioStorage: storage });

    expect(await db.select().from(cueResponseEvidence)).toEqual([expect.objectContaining({
      ownerUserId, takeId, rehearsalSessionId, measurementVersion: "cue-response-v1",
      cueEventId: null, actorEventId: null, clockId: null, delayMs: null, confidence: "low", score: null,
    })]);
  });

  it("continues coaching when supplementary cue-response evidence cannot be published", async () => {
    const { db, storage } = await setup();

    await expect(runMeasureTakeJob({ db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      normalizedAudioStorage: storage,
      afterAudioLoad: async () => { await client.exec("DROP TABLE cue_response_evidence"); },
    })).resolves.toMatchObject({ deduplicated: false });

    expect((await db.select().from(jobs)).find(({ id }) => id === jobId)).toMatchObject({ status: "completed" });
    expect((await db.select().from(jobs)).find(({ kind }) => kind === "review_audio"))
      .toMatchObject({ status: "queued" });
  });

  it("publishes limited metrics and continues audio review after an unclassified measurement failure", async () => {
    const { db, storage } = await setup();

    await expect(runLimitedMeasureTakeJob({ db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      normalizedAudioStorage: storage })).resolves.toEqual({ measurementId: expect.any(String) });

    expect((await db.select().from(takeMetrics))[0]).toMatchObject({ measurementVersion: "measure-v1-limited",
      metrics: expect.objectContaining({ alignmentCoverage: 0,
        pace: expect.objectContaining({ confidence: "insufficient_data", score: null }),
        pitch: expect.objectContaining({ confidence: "insufficient_data", score: null }) }) });
    expect((await db.select().from(jobs)).find(({ id }) => id === jobId))
      .toMatchObject({ status: "completed_with_limitations" });
    expect((await db.select().from(jobs)).find(({ kind }) => kind === "review_audio"))
      .toMatchObject({ status: "queued" });
  });

  it("deduplicates a reclaimed worker attempt without duplicating metric lines", async () => {
    // Break caught: retrying after durable publication can create a competing measurement or duplicate line evidence.
    const { db, storage } = await setup();
    await runMeasureTakeJob({ db, ownerUserId, jobId, leaseToken, attemptCount: 1, normalizedAudioStorage: storage });
    const retryLease = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await db.update(jobs).set({ status: "running", attemptCount: 2, leaseToken: retryLease,
      leaseExpiresAt: new Date("2026-08-12T12:30:00Z") }).where(eq(jobs.id, jobId));

    await expect(runMeasureTakeJob({ db, ownerUserId, jobId, leaseToken: retryLease, attemptCount: 2,
      normalizedAudioStorage: storage })).resolves.toMatchObject({ deduplicated: true });

    expect(await db.select().from(takeMetrics)).toHaveLength(1);
    expect(await db.select().from(takeMetricLines)).toHaveLength(1);
  });

  it("reads the registered storage version rather than newer bytes at the same key", async () => {
    // Break caught: dropping the versioned read lets a later object write substitute arbitrary audio for the artifact.
    const { db, storage, canonicalObjectKey } = await setup();
    await storage.putPrivateVersioned(canonicalObjectKey, Uint8Array.of(82, 73, 70, 70), "audio/wav");

    await expect(runMeasureTakeJob({ db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      normalizedAudioStorage: storage })).resolves.toMatchObject({ deduplicated: false });

    expect((await db.select().from(takeMetrics))[0]!.metrics).toMatchObject({
      pace: { wordCount: 2, wordsPerMinute: expect.closeTo(120, 0) },
    });
  });

  it("publishes nothing when its lease is reclaimed after audio load", async () => {
    // Break caught: removing the post-load lease fence lets an expired worker publish measurements over a newer attempt.
    const { db, storage } = await setup();

    await expect(runMeasureTakeJob({ db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      normalizedAudioStorage: storage,
      afterAudioLoad: async (transaction) => {
        await transaction.update(jobs).set({ attemptCount: 2,
          leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }).where(eq(jobs.id, jobId));
      },
    })).rejects.toMatchObject({ code: "STALE_JOB_LEASE" });

    expect(await db.select().from(takeMetrics)).toEqual([]);
    expect((await db.select().from(jobs))[0]).toMatchObject({ status: "running", attemptCount: 2 });
  });

  it("publishes nothing when the transcript is re-promoted after audio load", async () => {
    // Break caught: a worker that only checks the transcript before reading can attach old waveform metrics to stale evidence.
    const { db, storage } = await setup();
    const newerTranscriptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await db.insert(takeTranscripts).values({ id: newerTranscriptId, ownerUserId, takeId, audioSha256: "c".repeat(64),
      transcriberVersion: "v2", provider: "fake", modelName: "fake", language: "en", text: "New words",
      timingSource: "whisper_word_timestamps", status: "stale" });

    await expect(runMeasureTakeJob({ db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      normalizedAudioStorage: storage,
      afterAudioLoad: async (transaction) => {
        await transaction.update(takeTranscripts).set({ status: "stale" }).where(eq(takeTranscripts.id, transcriptId));
        await transaction.update(takeTranscripts).set({ status: "current" }).where(eq(takeTranscripts.id, newerTranscriptId));
      },
    })).rejects.toMatchObject({ code: "INVALID_MEASUREMENT_CHAIN" });

    expect(await db.select().from(takeMetrics)).toEqual([]);
  });

  it("publishes nothing when the registered artifact is replaced after audio load", async () => {
    // Break caught: reusing a payload artifact id after the artifact changes lets a worker measure an unregistered object.
    const { db, storage, canonicalObjectKey, wav } = await setup();

    await expect(runMeasureTakeJob({ db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      normalizedAudioStorage: storage,
      afterAudioLoad: async (transaction) => {
        await transaction.delete(normalizedAudioArtifacts).where(eq(normalizedAudioArtifacts.id, artifactId));
        await transaction.insert(normalizedAudioArtifacts).values({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ownerUserId, playId, takeId, transcriptId,
          transcriptStatus: "current", canonicalObjectKey, contentSha256: createHash("sha256").update(wav).digest("hex"),
          storageVersionToken: "memory:replacement",
        });
      },
    })).rejects.toMatchObject({ code: "INVALID_MEASUREMENT_CHAIN" });

    expect(await db.select().from(takeMetrics)).toEqual([]);
  });

  it("rejects a payload whose artifact id does not prove the current stage chain", async () => {
    // Break caught: trusting a payload artifact id permits cross-chain audio to be published for this take.
    const { db, storage } = await setup();
    await db.update(jobs).set({ payload: { takeId, transcriptId,
      normalizedAudioArtifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }).where(eq(jobs.id, jobId));

    await expect(runMeasureTakeJob({ db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      normalizedAudioStorage: storage })).rejects.toMatchObject({ code: "INVALID_MEASUREMENT_CHAIN" });

    expect(await db.select().from(takeMetrics)).toEqual([]);
  });

  it("retries malformed registered WAV bytes without writing partial measurement evidence", async () => {
    // Break caught: treating an invalid normalized WAV as success or publishing before decode corrupts the measurement chain.
    const { db, storage } = await setup(Uint8Array.of(82, 73, 70, 70));
    await db.update(jobs).set({ status: "queued", leaseToken: null, leaseExpiresAt: null, attemptCount: 0,
      availableAt: new Date("2026-08-12T11:59:00Z") })
      .where(eq(jobs.id, jobId));

    await expect(runWorkerOnce({
      db, ownerUserId, extractor: new ScriptExtractor(), parser: { parse: async () => { throw new Error("not called"); } },
      normalizedAudioStorage: storage, now: new Date("2026-08-12T12:00:00Z"),
    })).resolves.toBe(true);

    expect((await db.select().from(jobs))[0]).toMatchObject({ status: "queued", errorCode: "MALFORMED_NORMALIZED_WAV" });
    expect(await db.select().from(takeMetrics)).toEqual([]);
  });

  it("marks the take action-required when measurement exhausts its retries", async () => {
    const { db, storage } = await setup(Uint8Array.of(82, 73, 70, 70));
    await db.update(jobs).set({ status: "queued", leaseToken: null, leaseExpiresAt: null, attemptCount: 2,
      availableAt: new Date("2026-08-12T11:59:00Z") }).where(eq(jobs.id, jobId));

    await expect(runWorkerOnce({
      db, ownerUserId, extractor: new ScriptExtractor(), parser: { parse: async () => { throw new Error("not called"); } },
      normalizedAudioStorage: storage, now: new Date("2026-08-12T12:00:00Z"),
    })).resolves.toBe(true);

    expect((await db.select().from(jobs))[0]).toMatchObject({
      status: "action_required", attemptCount: 3, errorCode: "MALFORMED_NORMALIZED_WAV",
    });
    expect((await db.select().from(schema.takes))[0]).toMatchObject({ state: "action_required" });
    expect(await db.select().from(schema.takeEvents)).toContainEqual(expect.objectContaining({
      takeId, state: "action_required", details: { code: "MALFORMED_NORMALIZED_WAV" },
    }));
  });

  it("persists nullable insufficient-data metrics for an unvoiced registered take", async () => {
    // Break caught: worker-side fallback scores can turn a silent performance into invented actionable feedback.
    const { db, storage } = await setup(pcmWav(new Int16Array(16_000)));

    await runMeasureTakeJob({ db, ownerUserId, jobId, leaseToken, attemptCount: 1, normalizedAudioStorage: storage });

    expect((await db.select().from(takeMetrics))[0]!.metrics).toMatchObject({
      wordsPerMinute: null,
      pace: { confidence: "low", score: null },
      pitch: { confidence: "insufficient_data", score: null, medianHz: null },
    });
  });

  it("persists clipping as insufficient data with nullable downstream scores", async () => {
    // Break caught: worker serialization can discard quality warnings and make clipped metrics look reliable.
    const samples = tone(220, 1_000);
    samples.fill(32_767, 0, Math.ceil(samples.length * 0.06));
    const { db, storage } = await setup(pcmWav(samples));

    await runMeasureTakeJob({ db, ownerUserId, jobId, leaseToken, attemptCount: 1, normalizedAudioStorage: storage });

    expect((await db.select().from(takeMetrics))[0]!.metrics).toMatchObject({
      technicalWarnings: ["CLIPPING"],
      loudness: { confidence: "insufficient_data", score: null },
      pitch: { confidence: "insufficient_data", score: null },
    });
  });

  async function setup(wav = pcmWav(tone(220, 1_000)), withCueEvents = true) {
    client = new PGlite();
    for (const name of migrations) {
      await client.exec(await readFile(new URL(`../../../../packages/db/migrations/${name}`, import.meta.url), "utf8"));
    }
    const db = drizzle(client, { schema });
    const storage = new MemoryObjectStorage();
    const canonicalObjectKey = `users/${ownerUserId}/plays/${playId}/takes/${takeId}/transcripts/${transcriptId}/normalized/attempt.wav`;
    const write = await storage.putPrivateVersioned(canonicalObjectKey, wav, "audio/wav");
    await db.insert(schema.users).values({ id: ownerUserId, email: "actor@example.com", passwordHash: "hash" });
    await db.insert(schema.plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(schema.playModels).values({ id: modelId, ownerUserId, playId, version: 1,
      status: "approved", issues: [], model: rehearsalPlayModel() });
    await db.insert(schema.rehearsalSessions).values({ id: rehearsalSessionId, ownerUserId, playId,
      playModelId: modelId, playModelVersion: 1, sceneId: "scene", actorRoleId: "role", model: "realtime",
      grantExpiresAt: new Date("2026-08-12T12:30:00Z"), state: "completed" });
    if (withCueEvents) await db.insert(schema.rehearsalEvents).values([
      { ownerUserId, rehearsalSessionId, sequence: 1, type: "started",
        event: { type: "started", sequence: 1, startedAtMs: 9_000 } },
      { ownerUserId, rehearsalSessionId, sequence: 2, type: "ai_speech_started",
        event: { type: "ai_speech_started", sequence: 2, characterId: "cue-role", elementId: "cue-line",
          startedAtMs: 9_500 } },
      { id: cueEventId, ownerUserId, rehearsalSessionId, sequence: 3, type: "ai_speech_finished",
        event: { type: "ai_speech_finished", sequence: 3, characterId: "cue-role", elementId: "cue-line",
          endedAtMs: 10_000 }, receivedAtMs: 11_000, receivedClockId: "server:unix-epoch-ms",
        timingSource: "provider-derived", timingAtMs: 10_000, timingClockId: "provider:response-stream-7" },
      { id: actorEventId, ownerUserId, rehearsalSessionId, sequence: 4, type: "actor_line_final",
        event: { type: "actor_line_final", sequence: 4, text: "One two", endedAtMs: 10_740 },
        receivedAtMs: 12_000, receivedClockId: "server:unix-epoch-ms",
        timingSource: "provider-derived", timingAtMs: 10_740, timingClockId: "provider:response-stream-7" },
    ]);
    await db.insert(schema.practiceSessions).values({ id: sessionId, ownerUserId, playId, playModelId: modelId,
      playModelVersion: 1, sceneId: "scene", roleId: "role", retentionChoice: "retain" });
    await db.insert(schema.takes).values({ id: takeId, ownerUserId, practiceSessionId: sessionId, playId,
      playModelId: modelId, playModelVersion: 1, sceneId: "scene", roleId: "role", retentionChoice: "retain",
      durationMs: 1_000, mediaType: "audio/wav", objectKey: "source.wav", state: "completed",
      rehearsalSessionId });
    await db.insert(takeTranscripts).values({ id: transcriptId, ownerUserId, takeId, audioSha256: "a".repeat(64),
      transcriberVersion: "v1", provider: "fake", modelName: "fake", language: "en", text: "One two",
      timingSource: "whisper_word_timestamps", status: "current" });
    await db.insert(schema.transcriptWords).values([
      { ownerUserId, transcriptId, ordinal: 1, text: "One", startMs: 0, endMs: 500, confidence: 1 },
      { ownerUserId, transcriptId, ordinal: 2, text: "two", startMs: 500, endMs: 1_000, confidence: 1 },
    ]);
    await db.insert(schema.lineAlignments).values({ ownerUserId, transcriptId, elementId: "line-1", scriptOrdinal: 1,
      transcriptStartMs: 0, transcriptEndMs: 1_000, similarity: 1, status: "matched" });
    await db.insert(normalizedAudioArtifacts).values({ id: artifactId, ownerUserId, playId, takeId, transcriptId,
      transcriptStatus: "current", contentSha256: createHash("sha256").update(wav).digest("hex"),
      storageVersionToken: write.versionToken, canonicalObjectKey });
    await db.insert(jobs).values({ id: jobId, ownerUserId, playId, kind: "measure_take", status: "running",
      leaseToken, leaseExpiresAt: new Date("2026-08-12T12:20:00Z"), attemptCount: 1, dedupeKey: "measure_take:exact",
      payload: { takeId, transcriptId, normalizedAudioArtifactId: artifactId } });
    await db.insert(takeStageJobChains).values({ jobId, ownerUserId, playId, takeId, transcriptId,
      transcriptStatus: "current", stageKind: "measure_take" });
    return { db, storage, canonicalObjectKey, wav };
  }
});

function tone(frequencyHz: number, durationMs: number): Int16Array {
  const rate = 16_000;
  return Int16Array.from({ length: rate * durationMs / 1_000 }, (_, index) =>
    Math.round(8_192 * Math.sin(2 * Math.PI * frequencyHz * index / rate)));
}

function rehearsalRequest(event: Record<string, unknown>) {
  return new Request("http://local/events", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ event }) });
}

function rehearsalPlayModel() {
  return { id: "model", title: "Private Play", language: "en" as const,
    characters: [{ id: "cue-role", name: "Cue", aliases: [] }, { id: "role", name: "Actor", aliases: [] }],
    acts: [{ id: "act", ordinal: 1, title: "Act", scenes: [{ id: "scene", ordinal: 1, title: "Scene",
      characterIds: ["cue-role", "role"], elements: [
        { id: "cue-line", ordinal: 1, kind: "dialogue" as const, characterId: "cue-role",
          text: "Your cue.", sourcePage: 1 },
        { id: "line-1", ordinal: 2, kind: "dialogue" as const, characterId: "role",
          text: "One two", sourcePage: 1 },
      ] }] }] };
}

function pcmWav(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  bytes.set([82, 73, 70, 70], 0); view.setUint32(4, bytes.length - 8, true); bytes.set([87, 65, 86, 69], 8);
  bytes.set([102, 109, 116, 32], 12); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  bytes.set([100, 97, 116, 97], 36); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return bytes;
}
