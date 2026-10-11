import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { jobs, normalizedAudioArtifacts, playModels, plays, practiceSessions, takeTranscripts, takes, users }
  from "@drama/db/schema";
import { MemoryObjectStorage } from "@drama/storage/memory-storage";

import { runPurgePlayAudioJob, purgeTakeAudio, runPurgeTakeAudioJob } from "./purge-take-audio";

const migrations = ["0001_foundation.sql", "0002_play_processing_status.sql", "0002_practice_sessions.sql",
  "0003_reviewable_parse_jobs.sql", "0004_job_lease_fencing.sql", "0005_grounded_study.sql",
  "0006_current_artifact_uniqueness.sql", "0007_take_transcripts.sql", "0008_ordered_transcript_evidence.sql",
  "0009_take_metrics.sql", "0010_normalized_audio_artifacts.sql", "0011_stale_attempt_cleanup.sql",
  "0012_cleanup_attempt_history.sql", "0013_immutable_normalized_audio_keys.sql",
  "0015_take_audio_retention.sql", "0016_global_job_lease_history.sql", "0017_rehearsal_sessions.sql",
  "0018_rehearsal_events.sql", "0019_account_deletion.sql", "0020_rehearsal_linked_coaching.sql"];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const playId = "33333333-3333-4333-8333-333333333333";
const modelId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
const takeId = "66666666-6666-4666-8666-666666666666";
const transcriptId = "77777777-7777-4777-8777-777777777777";
const artifactId = "88888888-8888-4888-8888-888888888888";
const jobId = "99999999-9999-4999-8999-999999999999";
const leaseToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const originalKey = `users/${ownerUserId}/plays/${playId}/takes/${takeId}.wav`;
const normalizedKey = `users/${ownerUserId}/plays/${playId}/takes/${takeId}`
  + `/transcripts/${transcriptId}/normalized.wav`;

describe("purge take audio", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let storage: MemoryObjectStorage;

  beforeEach(async () => {
    client = new PGlite();
    for (const name of migrations) {
      await client.exec(await readFile(new URL(`../../../../packages/db/migrations/${name}`, import.meta.url),
        "utf8"));
    }
    db = drizzle(client, { schema });
    storage = new MemoryObjectStorage();
    await db.insert(users).values([
      { id: ownerUserId, email: "actor@example.com", passwordHash: "hash" },
      { id: otherUserId, email: "other@example.com", passwordHash: "hash" },
    ]);
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(playModels).values({ id: modelId, ownerUserId, playId, version: 1,
      status: "approved", model: playModel(), issues: [] });
    await db.insert(practiceSessions).values({ id: sessionId, ownerUserId, playId, playModelId: modelId,
      playModelVersion: 1, sceneId: "scene", roleId: "alex", retentionChoice: "delete_after_analysis" });
    await db.insert(takes).values({ id: takeId, ownerUserId, practiceSessionId: sessionId, playId,
      playModelId: modelId, playModelVersion: 1, sceneId: "scene", roleId: "alex",
      retentionChoice: "delete_after_analysis", durationMs: 1_000, mediaType: "audio/wav",
      objectKey: originalKey, state: "completed" });
    await db.insert(takeTranscripts).values({ id: transcriptId, ownerUserId, takeId, audioSha256: "a".repeat(64),
      transcriberVersion: "test-v1", provider: "fake", modelName: "fake", language: "en", text: "We begin",
      timingSource: "whisper_word_timestamps" });
    await storage.putPrivate(originalKey, Uint8Array.from([1, 2, 3]), "audio/wav");
    const normalized = await storage.putPrivateVersioned(normalizedKey, Uint8Array.from([4, 5]), "audio/wav");
    await storage.putPrivateVersioned(normalizedKey, Uint8Array.from([6, 7]), "audio/wav");
    await db.insert(normalizedAudioArtifacts).values({ id: artifactId, ownerUserId, playId, takeId, transcriptId,
      canonicalObjectKey: normalizedKey, contentSha256: "b".repeat(64),
      storageVersionToken: normalized.versionToken });
  });

  afterEach(async () => client.close());

  it("deletes original and exact normalized audio while retaining transcript metadata", async () => {
    const deletedAt = new Date("2026-08-22T15:00:00Z");

    expect(await purgeTakeAudio({ db, ownerUserId, takeId, storage, deletedAt })).toBe(true);

    await expect(storage.getPrivate(originalKey)).rejects.toThrow("Private object not found");
    await expect(storage.getPrivateVersion(normalizedKey,
      (await db.select().from(normalizedAudioArtifacts))[0]!.storageVersionToken))
      .rejects.toThrow("Private object version not found");
    await expect(storage.getPrivate(normalizedKey)).rejects.toThrow("Private object not found");
    expect((await db.select().from(takes))[0]!.audioDeletedAt).toEqual(deletedAt);
    expect(await db.select().from(takeTranscripts)).toHaveLength(1);
    expect(await db.select().from(normalizedAudioArtifacts)).toHaveLength(1);
  });

  it("is idempotent after the deletion marker commits", async () => {
    const deletedAt = new Date("2026-08-22T15:00:00Z");

    expect(await purgeTakeAudio({ db, ownerUserId, takeId, storage, deletedAt })).toBe(true);
    expect(await purgeTakeAudio({ db, ownerUserId, takeId, storage,
      deletedAt: new Date("2026-08-22T16:00:00Z") })).toBe(true);

    expect((await db.select().from(takes))[0]!.audioDeletedAt).toEqual(deletedAt);
  });

  it("does not expose or delete another actor's take", async () => {
    expect(await purgeTakeAudio({ db, ownerUserId: otherUserId, takeId, storage,
      deletedAt: new Date("2026-08-22T15:00:00Z") })).toBe(false);
    await expect(storage.getPrivate(originalKey)).resolves.toEqual(Uint8Array.from([1, 2, 3]));
  });

  it("completes an owner-scoped queued purge job", async () => {
    const now = new Date("2026-08-22T15:00:00Z");
    await db.insert(jobs).values({ id: jobId, ownerUserId, playId, kind: "purge_take_audio",
      status: "running", payload: { takeId }, attemptCount: 1, leaseToken,
      leaseExpiresAt: new Date("2026-08-22T15:05:00Z") });

    await runPurgeTakeAudioJob({ db, ownerUserId, jobId, storage, leaseToken, attemptCount: 1, now });

    expect((await db.select().from(jobs))[0]).toMatchObject({ status: "completed", leaseToken: null });
    expect((await db.select().from(takes))[0]!.audioDeletedAt).toEqual(now);
  });

  it("purges a persisted play inventory after its database rows are gone", async () => {
    const now = new Date("2026-08-22T15:00:00Z");
    await db.insert(jobs).values({ id: jobId, ownerUserId, kind: "purge_play_audio", status: "running",
      payload: { playId, originalObjectKeys: [originalKey],
        normalizedObjects: [{ objectKey: normalizedKey,
          storageVersionToken: (await db.select().from(normalizedAudioArtifacts))[0]!.storageVersionToken }] },
      attemptCount: 1, leaseToken, leaseExpiresAt: new Date("2026-08-22T15:05:00Z") });

    await runPurgePlayAudioJob({ db, ownerUserId, jobId, storage, leaseToken, attemptCount: 1, now });

    await expect(storage.getPrivate(originalKey)).rejects.toThrow("Private object not found");
    await expect(storage.getPrivate(normalizedKey)).rejects.toThrow("Private object not found");
    expect((await db.select().from(jobs))[0]).toMatchObject({ status: "completed", leaseToken: null });
  });

  it("rejects a play purge inventory outside the owner/play prefix", async () => {
    await db.insert(jobs).values({ id: jobId, ownerUserId, kind: "purge_play_audio", status: "running",
      payload: { playId, originalObjectKeys: [`users/${otherUserId}/plays/${playId}/takes/private.wav`],
        normalizedObjects: [] }, attemptCount: 1, leaseToken,
      leaseExpiresAt: new Date("2026-08-22T15:05:00Z") });

    await expect(runPurgePlayAudioJob({ db, ownerUserId, jobId, storage, leaseToken, attemptCount: 1,
      now: new Date("2026-08-22T15:00:00Z") })).rejects.toThrow("INVALID_PLAY_AUDIO_PURGE");
    await expect(storage.getPrivate(originalKey)).resolves.toEqual(Uint8Array.from([1, 2, 3]));
  });
});

function playModel() {
  return { id: "model", title: "Private Play", language: "en" as const,
    characters: [{ id: "alex", name: "Alex", aliases: [] }],
    acts: [{ id: "act", ordinal: 1, title: "Act I", scenes: [{ id: "scene", ordinal: 1,
      title: "Scene", characterIds: ["alex"], elements: [] }] }] };
}
