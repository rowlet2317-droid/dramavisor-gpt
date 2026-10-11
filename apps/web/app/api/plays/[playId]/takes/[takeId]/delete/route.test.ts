import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { normalizedAudioArtifacts, playModels, plays, practiceSessions, takeTranscripts, takes,
  users } from "@drama/db/schema";
import { MemoryObjectStorage } from "@drama/storage/memory-storage";

import { createDeleteTakeAudioHandler } from "./handler";

const migrations = ["0001_foundation.sql", "0002_play_processing_status.sql", "0002_practice_sessions.sql",
  "0003_reviewable_parse_jobs.sql", "0004_job_lease_fencing.sql", "0005_grounded_study.sql",
  "0006_current_artifact_uniqueness.sql", "0007_take_transcripts.sql", "0008_ordered_transcript_evidence.sql",
  "0009_take_metrics.sql", "0010_normalized_audio_artifacts.sql", "0015_take_audio_retention.sql",
  "0017_rehearsal_sessions.sql", "0018_rehearsal_events.sql", "0019_account_deletion.sql",
  "0020_rehearsal_linked_coaching.sql"];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const playId = "33333333-3333-4333-8333-333333333333";
const modelId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
const takeId = "66666666-6666-4666-8666-666666666666";
const transcriptId = "77777777-7777-4777-8777-777777777777";
const objectKey = `users/${ownerUserId}/plays/${playId}/takes/${takeId}.wav`;
const normalizedKey = `users/${ownerUserId}/plays/${playId}/takes/${takeId}`
  + `/transcripts/${transcriptId}/normalized.wav`;

describe("DELETE take audio", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let storage: MemoryObjectStorage;

  beforeEach(async () => {
    client = new PGlite();
    for (const name of migrations) {
      await client.exec(await readFile(new URL(`../../../../../../../../../packages/db/migrations/${name}`,
        import.meta.url), "utf8"));
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
      playModelVersion: 1, sceneId: "scene", roleId: "alex", retentionChoice: "retain" });
    await db.insert(takes).values({ id: takeId, ownerUserId, practiceSessionId: sessionId, playId,
      playModelId: modelId, playModelVersion: 1, sceneId: "scene", roleId: "alex", retentionChoice: "retain",
      durationMs: 1_000, mediaType: "audio/wav", objectKey, state: "completed" });
    await db.insert(takeTranscripts).values({ id: transcriptId, ownerUserId, takeId, audioSha256: "a".repeat(64),
      transcriberVersion: "v1", provider: "fake", modelName: "fake", language: "en", text: "We begin",
      timingSource: "whisper_word_timestamps" });
    await db.insert(normalizedAudioArtifacts).values({ ownerUserId, playId, takeId, transcriptId,
      canonicalObjectKey: normalizedKey, contentSha256: "b".repeat(64), storageVersionToken: "version-1" });
    await storage.putPrivate(objectKey, Uint8Array.from([1, 2, 3]), "audio/wav");
    await storage.putPrivate(normalizedKey, Uint8Array.from([4, 5, 6]), "audio/wav");
  });

  afterEach(async () => client.close());

  it("deletes owned audio immediately and remains idempotent", async () => {
    const handler = createDeleteTakeAudioHandler({ authenticate: async () => ({ id: ownerUserId }), db, storage,
      now: () => new Date("2026-08-22T16:00:00Z") });

    expect((await handler(new Request("http://local/delete", { method: "DELETE" }), context())).status).toBe(204);
    expect((await handler(new Request("http://local/delete", { method: "DELETE" }), context())).status).toBe(204);

    await expect(storage.getPrivate(objectKey)).rejects.toThrow("Private object not found");
    await expect(storage.getPrivate(normalizedKey)).rejects.toThrow("Private object not found");
    expect((await db.select().from(takes))[0]!.audioDeletedAt).toEqual(new Date("2026-08-22T16:00:00Z"));
  });

  it("returns owner-safe 404 without touching another actor's object", async () => {
    const handler = createDeleteTakeAudioHandler({ authenticate: async () => ({ id: otherUserId }), db, storage });

    const response = await handler(new Request("http://local/delete", { method: "DELETE" }), context());

    expect(response.status).toBe(404);
    await expect(storage.getPrivate(objectKey)).resolves.toEqual(Uint8Array.from([1, 2, 3]));
    await expect(storage.getPrivate(normalizedKey)).resolves.toEqual(Uint8Array.from([4, 5, 6]));
  });

  it("requires authentication", async () => {
    const handler = createDeleteTakeAudioHandler({ authenticate: async () => {
      const error = new Error("unauthorized"); error.name = "UnauthorizedError"; throw error;
    }, db, storage });

    expect((await handler(new Request("http://local/delete", { method: "DELETE" }), context())).status).toBe(401);
  });

  it("does not purge or mark audio deleted after the owner starts account deletion", async () => {
    await db.update(users).set({ accountStatus: "deleting" }).where(eq(users.id, ownerUserId));
    let purgeCalls = 0;
    const purgePrivate = storage.purgePrivate.bind(storage);
    storage.purgePrivate = async (key) => { purgeCalls += 1; await purgePrivate(key); };
    const handler = createDeleteTakeAudioHandler({ authenticate: async () => ({ id: ownerUserId }), db, storage });

    const response = await handler(new Request("http://local/delete", { method: "DELETE" }), context());

    expect(response.status).toBe(404);
    expect(purgeCalls).toBe(0);
    await expect(storage.getPrivate(objectKey)).resolves.toEqual(Uint8Array.from([1, 2, 3]));
    await expect(storage.getPrivate(normalizedKey)).resolves.toEqual(Uint8Array.from([4, 5, 6]));
    expect((await db.select().from(takes))[0]!.audioDeletedAt).toBeNull();
  });

  it("permanently purges but does not persist when deletion starts during storage purge", async () => {
    let purgeCalls = 0;
    const purgePrivate = storage.purgePrivate.bind(storage);
    storage.purgePrivate = async (key) => {
      purgeCalls += 1;
      await db.update(users).set({ accountStatus: "deleting" }).where(eq(users.id, ownerUserId));
      await purgePrivate(key);
    };
    const handler = createDeleteTakeAudioHandler({ authenticate: async () => ({ id: ownerUserId }), db, storage });

    const response = await handler(new Request("http://local/delete", { method: "DELETE" }), context());

    expect(response.status).toBe(404);
    expect(purgeCalls).toBe(2);
    await expect(storage.getPrivate(objectKey)).rejects.toThrow("Private object not found");
    await expect(storage.getPrivate(normalizedKey)).rejects.toThrow("Private object not found");
    expect((await db.select().from(takes))[0]!.audioDeletedAt).toBeNull();
  });
});

function context() {
  return { params: Promise.resolve({ playId, takeId }) };
}

function playModel() {
  return { id: "model", title: "Private Play", language: "en" as const,
    characters: [{ id: "alex", name: "Alex", aliases: [] }], acts: [{ id: "act", ordinal: 1,
      title: "Act I", scenes: [{ id: "scene", ordinal: 1, title: "Scene", characterIds: ["alex"],
        elements: [] }] }] };
}
