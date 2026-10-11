import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";

import { FakeTranscriber } from "@drama/ai/transcription/fake-transcriber";
import type { Transcript, TranscriptWord } from "@drama/domain/transcript";
import * as schema from "@drama/db/schema";
import { AuthRepository } from "@drama/db/repositories/auth";
import { TranscriptRepository } from "@drama/db/repositories/transcripts";
import { accountDeletions, jobs, lineAlignments, normalizedAudioArtifacts, privateObjectCleanupTasks, takeEvents,
  takeStageJobChains, takeTranscripts, takes, transcriptUncertaintyRegions, transcriptWords } from "@drama/db/schema";
import { eq } from "drizzle-orm";
import { ScriptExtractor } from "@drama/media/scripts/extract";
import { MemoryObjectStorage } from "@drama/storage/memory-storage";
import type { ObjectStorage, PrivateObjectWrite } from "@drama/storage/port";

import { runTranscribeTakeJob } from "./transcribe-take";
import { runWorkerOnce } from "../index";

const migrationNames = ["0001_foundation.sql", "0002_play_processing_status.sql",
  "0002_practice_sessions.sql", "0003_reviewable_parse_jobs.sql", "0004_job_lease_fencing.sql",
  "0005_grounded_study.sql", "0006_current_artifact_uniqueness.sql", "0007_take_transcripts.sql",
  "0008_ordered_transcript_evidence.sql", "0009_take_metrics.sql", "0010_normalized_audio_artifacts.sql",
  "0011_stale_attempt_cleanup.sql", "0012_cleanup_attempt_history.sql",
  "0013_immutable_normalized_audio_keys.sql", "0015_take_audio_retention.sql",
  "0017_rehearsal_sessions.sql", "0018_rehearsal_events.sql", "0019_account_deletion.sql",
  "0020_rehearsal_linked_coaching.sql"];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "99999999-9999-4999-8999-999999999999";
const playId = "22222222-2222-4222-8222-222222222222";
const modelId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const takeId = "55555555-5555-4555-8555-555555555555";
const jobId = "66666666-6666-4666-8666-666666666666";
const leaseToken = "77777777-7777-4777-8777-777777777777";
const originalAudio = Uint8Array.of(10, 20, 30, 40);
const normalizedAudio = Uint8Array.of(82, 73, 70, 70);

describe("runTranscribeTakeJob", () => {
  let client: PGlite;

  afterEach(async () => client?.close());

  it("publishes one canonical normalized artifact and a fenced measurement job for an English transcript", async () => {
    // Break caught: completing transcription without atomically binding the exact artifact to measurement loses the handoff.
    const db = await setup();
    const storage = new MemoryObjectStorage();

    const result = await runTranscribeTakeJob({
      db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      transcriber: new FakeTranscriber("fake-v1", transcript()),
      loadPrivateObject: async () => originalAudio,
      normalize: async () => normalizedAudio,
      normalizedAudioStorage: storage,
    });

    const [artifact] = await db.select().from(normalizedAudioArtifacts);
    const measureJobs = await db.select().from(jobs).where(eq(jobs.kind, "measure_take"));
    expect(artifact).toMatchObject({
      ownerUserId,
      playId,
      takeId,
      transcriptId: result.transcriptId,
      transcriptStatus: "current",
      canonicalObjectKey: `users/${ownerUserId}/plays/${playId}/takes/${takeId}/transcripts/${result.transcriptId}/normalized/${leaseToken}.wav`,
      contentSha256: createHash("sha256").update(normalizedAudio).digest("hex"),
    });
    expect(await storage.getPrivate(artifact!.canonicalObjectKey)).toEqual(normalizedAudio);
    expect(measureJobs).toEqual([expect.objectContaining({
      ownerUserId,
      playId,
      kind: "measure_take",
      status: "queued",
      dedupeKey: `measure_take:${result.transcriptId}`,
      payload: {
        takeId,
        transcriptId: result.transcriptId,
        normalizedAudioArtifactId: artifact!.id,
      },
    })]);
    expect(await db.select().from(takeStageJobChains).where(eq(takeStageJobChains.stageKind, "measure_take")))
      .toEqual([expect.objectContaining({
        jobId: measureJobs[0]!.id, ownerUserId, playId, takeId, transcriptId: result.transcriptId,
        transcriptStatus: "current", stageKind: "measure_take",
      })]);
  });

  it("reuses the exact artifact and measurement job when the completed process job is retried", async () => {
    // Break caught: retrying an already-published transcript must not write another durable artifact or job.
    const db = await setup();
    const storage = new MemoryObjectStorage();
    const first = await runTranscribeTakeJob({
      db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      transcriber: new FakeTranscriber("fake-v1", transcript()),
      loadPrivateObject: async () => originalAudio, normalize: async () => normalizedAudio,
      normalizedAudioStorage: storage,
    });
    const retryLease = "88888888-8888-4888-8888-888888888888";
    await db.update(jobs).set({ status: "running", attemptCount: 2, leaseToken: retryLease,
      leaseExpiresAt: new Date("2026-08-12T12:20:00Z") }).where(eq(jobs.id, jobId));

    await expect(runTranscribeTakeJob({
      db, ownerUserId, jobId, leaseToken: retryLease, attemptCount: 2,
      transcriber: new FakeTranscriber("fake-v1", async () => { throw new Error("must not transcribe"); }),
      loadPrivateObject: async () => originalAudio, normalize: async () => normalizedAudio,
      normalizedAudioStorage: storage,
    })).resolves.toEqual({ transcriptId: first.transcriptId, deduplicated: true });

    expect(await db.select().from(normalizedAudioArtifacts)).toHaveLength(1);
    expect(await db.select().from(jobs).where(eq(jobs.kind, "measure_take"))).toHaveLength(1);
  });

  it("does not publish normalized audio or measurement work for an unsupported language", async () => {
    // Break caught: an unsupported transcript must remain actionable without creating English-only measurement inputs.
    const db = await setup();
    const storage = new MemoryObjectStorage();

    await runTranscribeTakeJob({
      db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      transcriber: new FakeTranscriber("fake-v1", transcript({ language: "es", text: "Buenas noches" })),
      loadPrivateObject: async () => originalAudio, normalize: async () => normalizedAudio,
      normalizedAudioStorage: storage,
    });

    expect(await db.select().from(normalizedAudioArtifacts)).toEqual([]);
    expect(await db.select().from(jobs).where(eq(jobs.kind, "measure_take"))).toEqual([]);
  });

  it("records an attempt-specific cleanup row when publication cannot delete its exact storage version", async () => {
    // Break caught: a failed publication must never fall back to key deletion or silently leak the version it wrote.
    const db = await setup();
    await client.exec("ALTER TABLE jobs ADD CONSTRAINT reject_measure_take CHECK (kind <> 'measure_take')");
    const storage = new LeaseStealingStorage();

    await expect(runTranscribeTakeJob({
      db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      transcriber: new FakeTranscriber("fake-v1", transcript()),
      loadPrivateObject: async () => originalAudio, normalize: async () => normalizedAudio,
      normalizedAudioStorage: storage,
    })).rejects.toThrow();

    expect(await db.select().from(normalizedAudioArtifacts)).toEqual([]);
    expect(await db.select().from(privateObjectCleanupTasks)).toEqual([expect.objectContaining({
      ownerUserId, playId, takeId, sourceJobId: jobId, sourceAttemptCount: 1, sourceLeaseToken: leaseToken,
      transcriptStatus: "attempted", failureCode: "DB_PUBLICATION_FAILED",
    })]);
    expect(storage.keyDeleteCalls).toBe(0);
    expect(storage.versionDeleteCalls).toBe(1);
  });

  it("keeps normalized audio in deletion inventory when deletion wins before cleanup journaling", async () => {
    // Break caught: removing the pre-write identity lets deletion cascade before late exact-version cleanup is journaled.
    const db = await setup();
    await client.exec("ALTER TABLE jobs ADD CONSTRAINT reject_measure_take CHECK (kind <> 'measure_take')");
    const storage = new DeletionRacingStorage(() => new AuthRepository(db).requestAccountDeletion({
      ownerUserId, now: new Date("2026-08-23T12:00:00Z"),
    }));

    await expect(runTranscribeTakeJob({
      db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      transcriber: new FakeTranscriber("fake-v1", transcript()),
      loadPrivateObject: async () => originalAudio, normalize: async () => normalizedAudio,
      normalizedAudioStorage: storage,
    })).rejects.toThrow();
    await storage.deletion;

    expect((await db.select().from(accountDeletions))[0]!.objectInventory.objectKeys)
      .toContain(storage.objectKey);
  });

  it("journals failed retry cleanup against the existing transcript attempt", async () => {
    // Break caught: retry compensation must identify the deduplicated transcript, not a discarded generated ID.
    const db = await setup();
    const publishedStorage = new MemoryObjectStorage();
    const first = await runTranscribeTakeJob({
      db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      transcriber: new FakeTranscriber("fake-v1", transcript()), loadPrivateObject: async () => originalAudio,
      normalize: async () => normalizedAudio, normalizedAudioStorage: publishedStorage,
    });
    await db.delete(normalizedAudioArtifacts).where(eq(normalizedAudioArtifacts.transcriptId, first.transcriptId));
    await db.delete(jobs).where(eq(jobs.kind, "measure_take"));
    await client.exec("ALTER TABLE jobs ADD CONSTRAINT reject_measure_retry CHECK (kind <> 'measure_take')");
    const retryLease = "88888888-8888-4888-8888-888888888888";
    await db.update(jobs).set({ status: "running", attemptCount: 2, leaseToken: retryLease,
      leaseExpiresAt: new Date("2026-08-12T12:20:00Z") }).where(eq(jobs.id, jobId));
    const storage = new LeaseStealingStorage();

    await expect(runTranscribeTakeJob({
      db, ownerUserId, jobId, leaseToken: retryLease, attemptCount: 2,
      transcriber: new FakeTranscriber("fake-v1", async () => { throw new Error("must not transcribe"); }),
      loadPrivateObject: async () => originalAudio, normalize: async () => normalizedAudio,
      normalizedAudioStorage: storage,
    })).rejects.toThrow();

    expect(await db.select().from(privateObjectCleanupTasks)).toEqual([expect.objectContaining({
      transcriptId: first.transcriptId, transcriptStatus: "attempted", sourceAttemptCount: 2,
      sourceLeaseToken: retryLease,
    })]);
  });

  it("compensates the exact uploaded version when its lease changes before registration", async () => {
    // Break caught: removing the post-upload lease assertion lets an expired attempt publish a measurement chain.
    const db = await setup();
    const storage = new ExactCompensatingStorage();

    await expect(runTranscribeTakeJob({
      db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      transcriber: new FakeTranscriber("fake-v1", transcript()), loadPrivateObject: async () => originalAudio,
      normalize: async () => normalizedAudio, normalizedAudioStorage: storage,
      afterNormalizedAudioWrite: async (transaction) => {
        await transaction.update(jobs).set({ attemptCount: 2,
          leaseToken: "88888888-8888-4888-8888-888888888888" }).where(eq(jobs.id, jobId));
      },
    })).rejects.toMatchObject({ code: "STALE_JOB_LEASE" });

    expect(await db.select().from(normalizedAudioArtifacts)).toEqual([]);
    expect(await db.select().from(jobs).where(eq(jobs.kind, "measure_take"))).toEqual([]);
    expect(await db.select().from(jobs).where(eq(jobs.kind, "delete_private_object"))).toEqual([]);
    expect(storage.deletedVersionTokens).toHaveLength(1);
    expect(storage.keyDeleteCalls).toBe(0);
  });

  it("compensates when transcript currentness changes before registration even without database triggers", async () => {
    // Break caught: removing the post-upload transcript fence lets stale evidence be published when a storage backend races it.
    const db = await setup();
    await client.exec("DROP TRIGGER normalized_audio_artifacts_require_current_transcript ON normalized_audio_artifacts");
    await client.exec("DROP TRIGGER take_stage_job_chains_require_current_transcript ON take_stage_job_chains");
    const storage = new ExactCompensatingStorage();

    await expect(runTranscribeTakeJob({
      db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      transcriber: new FakeTranscriber("fake-v1", transcript()), loadPrivateObject: async () => originalAudio,
      normalize: async () => normalizedAudio, normalizedAudioStorage: storage,
      afterNormalizedAudioWrite: async (transaction) => {
        await transaction.update(takeTranscripts).set({ status: "stale" })
          .where(eq(takeTranscripts.status, "current"));
      },
    })).rejects.toThrow("Transcript is no longer current");

    expect(await db.select().from(normalizedAudioArtifacts)).toEqual([]);
    expect(await db.select().from(jobs).where(eq(jobs.kind, "measure_take"))).toEqual([]);
    expect(storage.deletedVersionTokens).toHaveLength(1);
  });

  it("retries past an orphaned unregistered upload without duplicating the durable artifact or measurement job", async () => {
    // Break caught: reusing a transcript-deterministic key makes an orphaned conditional write block every retry.
    const db = await setup();
    const storage = new CrashAfterFirstWriteStorage();
    const fixedTranscriptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    await expect(runTranscribeTakeJob({
      db, ownerUserId, jobId, leaseToken, attemptCount: 1, createId: () => fixedTranscriptId,
      transcriber: new FakeTranscriber("fake-v1", transcript()), loadPrivateObject: async () => originalAudio,
      normalize: async () => normalizedAudio, normalizedAudioStorage: storage,
    })).rejects.toThrow("simulated worker crash");
    const retryLease = "88888888-8888-4888-8888-888888888888";
    await db.update(jobs).set({ status: "running", attemptCount: 2, leaseToken: retryLease,
      leaseExpiresAt: new Date("2026-08-12T12:20:00Z") }).where(eq(jobs.id, jobId));

    const retry = await runTranscribeTakeJob({
      db, ownerUserId, jobId, leaseToken: retryLease, attemptCount: 2, createId: () => fixedTranscriptId,
      transcriber: new FakeTranscriber("fake-v1", transcript()), loadPrivateObject: async () => originalAudio,
      normalize: async () => normalizedAudio, normalizedAudioStorage: storage,
    });

    expect(retry).toEqual({ transcriptId: fixedTranscriptId, deduplicated: false });
    const artifacts = await db.select().from(normalizedAudioArtifacts);
    expect(artifacts).toEqual([expect.objectContaining({ transcriptId: fixedTranscriptId,
      canonicalObjectKey: expect.stringContaining(`/normalized/${retryLease}.wav`) })]);
    expect(await db.select().from(jobs).where(eq(jobs.kind, "measure_take"))).toHaveLength(1);
  });

  it("atomically persists transcript evidence and monotonic role-line alignments", async () => {
    // Break caught: publishing transcript metadata without its words/alignments would expose partial evidence.
    const db = await setup();
    const result = await run(db, transcript({ words: timedWords([
      "I", "thought", "you", "had", "gone",
      "I", "stood", "by", "the", "window",
      "Then", "I", "heard", "your", "key",
    ]) }));

    expect(result.deduplicated).toBe(false);
    expect(await db.select().from(takeTranscripts)).toEqual([expect.objectContaining({
      id: result.transcriptId,
      ownerUserId,
      takeId,
      audioSha256: createHash("sha256").update(originalAudio).digest("hex"),
      transcriberVersion: "fake-v1",
      provider: "fake",
      modelName: "synthetic-transcriber",
      language: "en",
      timingSource: "whisper_word_timestamps",
      status: "current",
    })]);
    expect(await db.select().from(transcriptWords)).toHaveLength(15);
    expect((await db.select().from(lineAlignments)).map(({ elementId, status }) => ({ elementId, status })))
      .toEqual([
        { elementId: "line_0001", status: "matched" },
        { elementId: "line_0002", status: "paraphrased" },
        { elementId: "line_0003", status: "omitted" },
        { elementId: "line_0004", status: "matched" },
      ]);
    expect(await db.select().from(transcriptUncertaintyRegions)).toEqual([]);
    expect((await db.select().from(takes))[0]).toMatchObject({ state: "completed" });
    expect((await db.select().from(jobs))[0]).toMatchObject({ status: "completed", errorCode: null });
    expect((await db.select().from(takeEvents)).map(({ state }) => state)).toEqual([
      "queued", "processing", "completed",
    ]);

    const repository = new TranscriptRepository(db);
    await expect(repository.getCurrentForTake(ownerUserId, takeId)).resolves.toMatchObject({
      transcript: { id: result.transcriptId }, words: expect.any(Array), alignments: expect.any(Array),
    });
    await expect(repository.getCurrentForTake(otherUserId, takeId)).resolves.toBeNull();
  });

  it("publishes missing timing as completed_with_limitations with explicit uncertainty regions", async () => {
    // Break caught: optional timing failure must not route a usable transcript through job retry/failure.
    const db = await setup();

    await run(db, transcript({ words: [], timingSource: "unavailable" }));

    expect((await db.select().from(takes))[0]).toMatchObject({ state: "completed_with_limitations" });
    expect((await db.select().from(jobs))[0]).toMatchObject({ status: "completed", errorCode: null });
    expect(await db.select().from(transcriptWords)).toEqual([]);
    expect((await db.select().from(lineAlignments)).every(({ status, transcriptStartMs }) =>
      status === "uncertain" && transcriptStartMs === null)).toBe(true);
    expect((await db.select().from(transcriptUncertaintyRegions)).map(({ reason }) => reason))
      .toEqual(["missing_timing", "missing_timing", "missing_timing", "missing_timing"]);
  });

  it("persists partially reconciled canonical words and marks their line timing uncertain", async () => {
    // Break caught: a canonical token without a safe Whisper match must not inherit unrelated timing.
    const db = await setup();
    const words = timedWords(["I", "thought", "you", "had", "gone"]);
    words[1] = { ...words[1]!, startMs: null, endMs: null };

    await run(db, transcript({ text: "I thought you had gone", words,
      timingSource: "partial_whisper_word_timestamps" }));

    expect((await db.select().from(transcriptWords)).map(({ text, startMs, endMs }) =>
      ({ text, startMs, endMs }))).toContainEqual({ text: "thought", startMs: null, endMs: null });
    expect((await db.select().from(lineAlignments)).find(({ elementId }) => elementId === "line_0001"))
      .toMatchObject({ status: "uncertain", transcriptStartMs: null, transcriptEndMs: null });
    expect((await db.select().from(transcriptUncertaintyRegions))[0]).toMatchObject({
      elementId: "line_0001", reason: "missing_timing",
    });
    expect((await db.select().from(takes))[0]).toMatchObject({ state: "completed_with_limitations" });
  });

  it("persists detected non-English text and terminalizes the take for actor action", async () => {
    // Break caught: aligning an unsupported language as English would publish misleading evidence.
    const db = await setup();

    await run(db, transcript({ text: "Buenas noches", language: "es", words: timedWords(["Buenas", "noches"]) }));

    expect((await db.select().from(takeTranscripts))[0]).toMatchObject({ language: "es", text: "Buenas noches" });
    expect((await db.select().from(takes))[0]).toMatchObject({ state: "action_required" });
    expect((await db.select().from(jobs))[0]).toMatchObject({
      status: "action_required", errorCode: "UNSUPPORTED_LANGUAGE",
    });
    expect((await db.select().from(takeEvents)).at(-1)).toMatchObject({
      state: "action_required", details: { code: "UNSUPPORTED_LANGUAGE" },
    });
  });

  it("deduplicates a restarted attempt by take, original audio hash, and transcriber version", async () => {
    // Break caught: a restart after publication must not call the provider or duplicate transcript evidence.
    const db = await setup();
    const first = await run(db, transcript());
    const secondLease = "88888888-8888-4888-8888-888888888888";
    await db.update(jobs).set({ status: "running", attemptCount: 2, leaseToken: secondLease,
      leaseExpiresAt: new Date("2026-08-12T12:20:00Z") }).where(eq(jobs.id, jobId));
    const throwing = new FakeTranscriber("fake-v1", async () => { throw new Error("provider must not run"); });

    const restarted = await runTranscribeTakeJob({
      db, ownerUserId, jobId, leaseToken: secondLease, attemptCount: 2, transcriber: throwing,
      loadPrivateObject: async () => originalAudio, normalize: async () => normalizedAudio,
    });

    expect(restarted).toEqual({ transcriptId: first.transcriptId, deduplicated: true });
    expect(await db.select().from(takeTranscripts)).toHaveLength(1);
    expect(await db.select().from(transcriptWords)).toHaveLength(transcript().words.length);
  });

  it("promotes a stale pre-provider dedupe match and stales the superseded current transcript", async () => {
    // Break caught: finalizing against a stale match while another transcript stays current makes evidence incoherent.
    const db = await setup();
    const staleId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const currentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await db.insert(takeTranscripts).values([
      transcriptRow(staleId, "fake-v1", "stale"),
      transcriptRow(currentId, "fake-v2", "current"),
    ]);
    const throwing = new FakeTranscriber("fake-v1", async () => { throw new Error("provider must not run"); });

    const result = await runTranscribeTakeJob({
      db, ownerUserId, jobId, leaseToken, attemptCount: 1, transcriber: throwing,
      loadPrivateObject: async () => originalAudio, normalize: async () => normalizedAudio,
    });

    expect(result).toEqual({ transcriptId: staleId, deduplicated: true });
    expect((await db.select({ id: takeTranscripts.id, status: takeTranscripts.status }).from(takeTranscripts)
      .orderBy(takeTranscripts.id))).toEqual([
      { id: staleId, status: "current" },
      { id: currentId, status: "stale" },
    ]);
    await expect(new TranscriptRepository(db).getCurrentForTake(ownerUserId, takeId))
      .resolves.toMatchObject({ transcript: { id: staleId } });
    await expect(new TranscriptRepository(db).getCurrentForTake(otherUserId, takeId)).resolves.toBeNull();
    expect((await db.select().from(jobs))[0]).toMatchObject({ status: "completed" });
    expect((await db.select().from(takes))[0]).toMatchObject({ state: "completed" });
  });

  it("promotes a stale dedupe match discovered inside the publication transaction", async () => {
    // Break caught: a concurrent matching publication after provider work must restore the same current invariant.
    const db = await setup();
    const staleId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const currentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await db.insert(takeTranscripts).values(transcriptRow(currentId, "fake-v2", "current"));
    const transcriber = new FakeTranscriber("fake-v1", async () => {
      await db.insert(takeTranscripts).values(transcriptRow(staleId, "fake-v1", "stale"));
      return transcript();
    });
    const storage = new MemoryObjectStorage();

    const result = await runTranscribeTakeJob({
      db, ownerUserId, jobId, leaseToken, attemptCount: 1, transcriber,
      loadPrivateObject: async () => originalAudio, normalize: async () => normalizedAudio,
      normalizedAudioStorage: storage,
    });

    expect(result).toEqual({ transcriptId: staleId, deduplicated: true });
    expect((await db.select({ id: takeTranscripts.id, status: takeTranscripts.status }).from(takeTranscripts)
      .orderBy(takeTranscripts.id))).toEqual([
      { id: staleId, status: "current" },
      { id: currentId, status: "stale" },
    ]);
    expect(await db.select().from(normalizedAudioArtifacts)).toEqual([
      expect.objectContaining({ transcriptId: staleId }),
    ]);
    expect(await db.select().from(jobs).where(eq(jobs.kind, "delete_private_object"))).toEqual([]);
  });

  it("returns same-timestamp alignments in durable script order", async () => {
    // Break caught: ordering only by created_at lets insertion/query plans scramble the script sequence.
    const db = await setup();
    const transcriptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await db.insert(takeTranscripts).values(transcriptRow(transcriptId, "fake-v1", "current"));
    await client.query(`INSERT INTO line_alignments
      (id, owner_user_id, transcript_id, element_id, script_ordinal, similarity, status, created_at)
      VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', $1, $2, 'line_0001', 1, 1, 'matched', '2026-08-12'),
             ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', $1, $2, 'line_0004', 4, 1, 'matched', '2026-08-12')`,
    [ownerUserId, transcriptId]);
    await client.exec("DROP INDEX line_alignments_owner_script_ordinal_unique");

    const evidence = await new TranscriptRepository(db).getCurrentForTake(ownerUserId, takeId);

    expect(evidence?.alignments.map((alignment) => ({
      elementId: alignment.elementId,
      scriptOrdinal: (alignment as typeof alignment & { scriptOrdinal?: number }).scriptOrdinal,
    }))).toEqual([
      { elementId: "line_0001", scriptOrdinal: 1 },
      { elementId: "line_0004", scriptOrdinal: 4 },
    ]);
  });

  it("rejects stale completion before any transcript row becomes current", async () => {
    // Break caught: an expired worker must not overwrite evidence after a newer worker owns the lease.
    const db = await setup();
    const transcriber = new FakeTranscriber("fake-v1", async () => {
      await db.update(jobs).set({
        attemptCount: 2,
        leaseToken: "88888888-8888-4888-8888-888888888888",
      }).where(eq(jobs.id, jobId));
      return transcript();
    });

    await expect(runTranscribeTakeJob({ db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      transcriber, loadPrivateObject: async () => originalAudio, normalize: async () => normalizedAudio }))
      .rejects.toMatchObject({ code: "STALE_JOB_LEASE" });

    expect(await db.select().from(takeTranscripts)).toEqual([]);
    expect(await db.select().from(transcriptWords)).toEqual([]);
    expect((await db.select().from(takes))[0]).toMatchObject({ state: "processing" });
  });

  it("rolls back the parent transcript when alignment publication fails", async () => {
    // Break caught: a child insert failure must not leave a parent transcript marked current.
    const db = await setup(true);

    await expect(run(db, transcript())).rejects.toThrow();

    expect(await db.select().from(takeTranscripts)).toEqual([]);
    expect(await db.select().from(transcriptWords)).toEqual([]);
    expect(await db.select().from(lineAlignments)).toEqual([]);
  });

  it("wires process_take through transcription and stops before later coaching stages", async () => {
    // Break caught: leaving process_take out of the claim allowlist strands every uploaded take in queued.
    const db = await setup();
    await db.update(jobs).set({ status: "queued", attemptCount: 0, leaseToken: null, leaseExpiresAt: null,
      availableAt: new Date("2026-08-12T11:59:00Z") });

    await expect(runWorkerOnce({
      db,
      ownerUserId,
      extractor: new ScriptExtractor(),
      parser: { parse: async () => { throw new Error("parser must not run"); } },
      transcriber: new FakeTranscriber("fake-v1", transcript()),
      loadPrivateObject: async () => originalAudio,
      normalizeAudio: async () => normalizedAudio,
      now: new Date("2026-08-12T12:00:00Z"),
    })).resolves.toBe(true);

    expect(await db.select().from(takeTranscripts)).toHaveLength(1);
    expect(await db.select().from(jobs)).toEqual([expect.objectContaining({
      kind: "process_take", status: "completed",
    })]);
  });

  it("requeues a transient transcription failure and succeeds on the next leased attempt", async () => {
    // Break caught: leaving the take processing must remain restartable through the job retry path.
    const db = await setup();
    await db.update(jobs).set({ status: "queued", attemptCount: 0, leaseToken: null, leaseExpiresAt: null,
      availableAt: new Date("2026-08-12T11:59:00Z") });

    await runWorkerOnce({
      db, ownerUserId, extractor: new ScriptExtractor(),
      parser: { parse: async () => { throw new Error("parser must not run"); } },
      transcriber: new FakeTranscriber("fake-v1", async () => { throw new Error("temporary provider failure"); }),
      loadPrivateObject: async () => originalAudio, normalizeAudio: async () => normalizedAudio,
      now: new Date("2026-08-12T12:00:00Z"),
    });
    expect((await db.select().from(jobs))[0]).toMatchObject({
      status: "queued", attemptCount: 1, errorCode: "JOB_FAILURE",
    });
    expect((await db.select().from(takes))[0]).toMatchObject({ state: "processing" });
    expect(await db.select().from(takeTranscripts)).toEqual([]);

    await runWorkerOnce({
      db, ownerUserId, extractor: new ScriptExtractor(),
      parser: { parse: async () => { throw new Error("parser must not run"); } },
      transcriber: new FakeTranscriber("fake-v1", transcript()),
      loadPrivateObject: async () => originalAudio, normalizeAudio: async () => normalizedAudio,
      now: new Date("2026-08-12T12:01:00Z"),
    });
    expect((await db.select().from(jobs))[0]).toMatchObject({ status: "completed", attemptCount: 2,
      errorCode: null });
    expect((await db.select().from(takes))[0]).toMatchObject({ state: "completed" });
    expect(await db.select().from(takeTranscripts)).toHaveLength(1);
  });

  it("terminalizes the take after the third failed transcription attempt", async () => {
    // Break caught: terminalizing only the job leaves the actor-facing take stuck in processing forever.
    const db = await setup();
    await db.update(jobs).set({ status: "queued", attemptCount: 0, leaseToken: null, leaseExpiresAt: null,
      availableAt: new Date("2026-08-12T11:59:00Z") });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runWorkerOnce({
        db, ownerUserId, extractor: new ScriptExtractor(),
        parser: { parse: async () => { throw new Error("parser must not run"); } },
        transcriber: new FakeTranscriber("fake-v1", async () => { throw new Error("provider unavailable"); }),
        loadPrivateObject: async () => originalAudio, normalizeAudio: async () => normalizedAudio,
        now: new Date(`2026-08-12T12:0${attempt}:00Z`),
      });
    }

    expect((await db.select().from(jobs))[0]).toMatchObject({
      status: "action_required", attemptCount: 3, errorCode: "JOB_FAILURE",
    });
    expect((await db.select().from(takes))[0]).toMatchObject({ state: "action_required" });
    expect((await db.select().from(takeEvents)).at(-1)).toMatchObject({
      state: "action_required", details: { code: "JOB_FAILURE" },
    });
  });

  async function setup(duplicateElementId = false) {
    client = new PGlite();
    for (const name of migrationNames) {
      await client.exec(await readFile(new URL(`../../../../packages/db/migrations/${name}`, import.meta.url), "utf8"));
    }
    const db = drizzle(client, { schema });
    await db.insert(schema.users).values([
      { id: ownerUserId, email: "actor@example.com", passwordHash: "hash" },
      { id: otherUserId, email: "other@example.com", passwordHash: "hash" },
    ]);
    await db.insert(schema.plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(schema.playModels).values({ id: modelId, ownerUserId, playId, version: 2,
      status: "approved", issues: [], model: playModel(duplicateElementId) });
    await db.insert(schema.practiceSessions).values({ id: sessionId, ownerUserId, playId,
      playModelId: modelId, playModelVersion: 2, sceneId: "scene-1", roleId: "alex", retentionChoice: "retain" });
    await db.insert(takes).values({ id: takeId, ownerUserId, practiceSessionId: sessionId, playId,
      playModelId: modelId, playModelVersion: 2, sceneId: "scene-1", roleId: "alex", retentionChoice: "retain",
      durationMs: 5_000, mediaType: "audio/wav", objectKey: "private/take.wav", state: "queued" });
    await db.insert(takeEvents).values({ ownerUserId, takeId, state: "queued", details: {} });
    await db.insert(jobs).values({ id: jobId, ownerUserId, playId, kind: "process_take", status: "running",
      attemptCount: 1, leaseToken, leaseExpiresAt: new Date("2026-08-12T12:10:00Z"), payload: { takeId } });
    await db.insert(takeStageJobChains).values({
      jobId,
      ownerUserId,
      playId,
      takeId,
      stageKind: "process_take",
    });
    return db;
  }

  async function run(db: Awaited<ReturnType<typeof setup>>, result: Transcript) {
    return runTranscribeTakeJob({
      db,
      ownerUserId,
      jobId,
      leaseToken,
      attemptCount: 1,
      transcriber: new FakeTranscriber("fake-v1", result),
      loadPrivateObject: async () => originalAudio,
      normalize: async () => normalizedAudio,
    });
  }
});

function transcript(overrides: Partial<Transcript> = {}): Transcript {
  return {
    text: "I thought you had gone. I waited by the window. The rain would not stop. Then I heard your key.",
    language: "en",
    words: timedWords([
      "I", "thought", "you", "had", "gone", "I", "waited", "by", "the", "window",
      "The", "rain", "would", "not", "stop", "Then", "I", "heard", "your", "key",
    ]),
    provider: "fake",
    modelName: "synthetic-transcriber",
    transcriberVersion: "fake-v1",
    timingSource: "whisper_word_timestamps",
    ...overrides,
  };
}

function timedWords(tokens: string[]): TranscriptWord[] {
  return tokens.map((text, index) => ({ text, startMs: index * 100, endMs: index * 100 + 80,
    confidence: null }));
}

function playModel(duplicateElementId: boolean) {
  const line4Id = duplicateElementId ? "line_0003" : "line_0004";
  return { id: "model", title: "Private Play", language: "en" as const,
    characters: [{ id: "alex", name: "Alex", aliases: [] }],
    acts: [{ id: "act-1", ordinal: 1, title: "Act I", scenes: [{ id: "scene-1", ordinal: 1,
      title: "Scene One", characterIds: ["alex"], elements: [
        { id: "line_0001", ordinal: 1, kind: "dialogue" as const, characterId: "alex",
          text: "I thought you had gone.", sourcePage: 1 },
        { id: "line_0002", ordinal: 2, kind: "dialogue" as const, characterId: "alex",
          text: "I waited by the window.", sourcePage: 1 },
        { id: "line_0003", ordinal: 3, kind: "dialogue" as const, characterId: "alex",
          text: "The rain would not stop.", sourcePage: 1 },
        { id: line4Id, ordinal: 4, kind: "dialogue" as const, characterId: "alex",
          text: "Then I heard your key.", sourcePage: 1 },
      ] }] }] };
}

function transcriptRow(id: string, transcriberVersion: string, status: "current" | "stale") {
  return {
    id,
    ownerUserId,
    takeId,
    audioSha256: createHash("sha256").update(originalAudio).digest("hex"),
    transcriberVersion,
    provider: "fake",
    modelName: "synthetic-transcriber",
    language: "en",
    text: "We begin",
    timingSource: "whisper_word_timestamps" as const,
    status,
  };
}

class LeaseStealingStorage implements ObjectStorage {
  private readonly delegate = new MemoryObjectStorage();
  keyDeleteCalls = 0;
  versionDeleteCalls = 0;

  async putPrivate(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.delegate.putPrivate(key, bytes, contentType);
  }

  async putPrivateVersioned(key: string, bytes: Uint8Array, contentType: string): Promise<PrivateObjectWrite> {
    const write = await this.delegate.putPrivateVersioned(key, bytes, contentType);
    return write;
  }

  async getPrivate(key: string): Promise<Uint8Array> {
    return this.delegate.getPrivate(key);
  }

  async deletePrivate(): Promise<void> {
    this.keyDeleteCalls += 1;
    throw new Error("key deletion is forbidden");
  }

  async purgePrivate(key: string): Promise<void> { await this.delegate.purgePrivate(key); }

  async deletePrivateVersion(): Promise<boolean> {
    this.versionDeleteCalls += 1;
    return false;
  }
}

class DeletionRacingStorage extends LeaseStealingStorage {
  deletion: Promise<unknown> = Promise.resolve();
  objectKey = "";

  constructor(private readonly startDeletion: () => Promise<unknown>) { super(); }

  override async putPrivateVersioned(key: string, bytes: Uint8Array, contentType: string) {
    this.objectKey = key;
    return super.putPrivateVersioned(key, bytes, contentType);
  }

  override async deletePrivateVersion(): Promise<boolean> {
    this.deletion = this.startDeletion();
    return super.deletePrivateVersion();
  }
}

class ExactCompensatingStorage implements ObjectStorage {
  private readonly delegate = new MemoryObjectStorage();
  readonly deletedVersionTokens: string[] = [];
  keyDeleteCalls = 0;

  async putPrivate(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.delegate.putPrivate(key, bytes, contentType);
  }

  async putPrivateVersioned(key: string, bytes: Uint8Array, contentType: string): Promise<PrivateObjectWrite> {
    return this.delegate.putPrivateVersioned(key, bytes, contentType);
  }

  async getPrivate(key: string): Promise<Uint8Array> {
    return this.delegate.getPrivate(key);
  }

  async deletePrivate(): Promise<void> {
    this.keyDeleteCalls += 1;
    throw new Error("key deletion is forbidden");
  }

  async purgePrivate(key: string): Promise<void> { await this.delegate.purgePrivate(key); }

  async deletePrivateVersion(key: string, versionToken: string): Promise<boolean> {
    this.deletedVersionTokens.push(versionToken);
    return this.delegate.deletePrivateVersion(key, versionToken);
  }
}

class CrashAfterFirstWriteStorage implements ObjectStorage {
  private readonly delegate = new MemoryObjectStorage();
  private crashed = false;

  async putPrivate(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.delegate.putPrivate(key, bytes, contentType);
  }

  async putPrivateVersioned(key: string, bytes: Uint8Array, contentType: string): Promise<PrivateObjectWrite> {
    const write = await this.delegate.putPrivateVersioned(key, bytes, contentType);
    if (!this.crashed) {
      this.crashed = true;
      throw new Error("simulated worker crash");
    }
    return write;
  }

  async getPrivate(key: string): Promise<Uint8Array> { return this.delegate.getPrivate(key); }
  async deletePrivate(key: string): Promise<void> { return this.delegate.deletePrivate(key); }
  async purgePrivate(key: string): Promise<void> { return this.delegate.purgePrivate(key); }
  async deletePrivateVersion(key: string, versionToken: string): Promise<boolean> {
    return this.delegate.deletePrivateVersion(key, versionToken);
  }
}
