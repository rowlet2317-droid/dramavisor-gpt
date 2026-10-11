import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { playModels, plays, practiceSessions, takes, users } from "@drama/db/schema";
import { MemoryObjectStorage } from "@drama/storage/memory-storage";

import { createTakeAudioHandler } from "./handler";

const migrations = ["0001_foundation.sql", "0002_play_processing_status.sql", "0002_practice_sessions.sql",
  "0003_reviewable_parse_jobs.sql", "0004_job_lease_fencing.sql", "0015_take_audio_retention.sql",
  "0017_rehearsal_sessions.sql", "0018_rehearsal_events.sql", "0019_account_deletion.sql",
  "0020_rehearsal_linked_coaching.sql"];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const playId = "33333333-3333-4333-8333-333333333333";
const modelId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
const takeId = "66666666-6666-4666-8666-666666666666";
const objectKey = `users/${ownerUserId}/plays/${playId}/takes/${takeId}.wav`;

describe("GET private take audio", () => {
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
    await storage.putPrivate(objectKey, Uint8Array.from([0, 1, 2, 3, 4, 5]), "audio/wav");
    await db.insert(users).values([
      { id: ownerUserId, email: "owner@example.com", passwordHash: "hash" },
      { id: otherUserId, email: "other@example.com", passwordHash: "hash" },
    ]);
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(playModels).values({ id: modelId, ownerUserId, playId, version: 1,
      status: "approved", model: { id: "model:v1", title: "Private Play", language: "en",
        characters: [], acts: [] }, issues: [] });
    await db.insert(practiceSessions).values({ id: sessionId, ownerUserId, playId, playModelId: modelId,
      playModelVersion: 1, sceneId: "scene", roleId: "role", retentionChoice: "retain" });
    await db.insert(takes).values({ id: takeId, ownerUserId, practiceSessionId: sessionId, playId,
      playModelId: modelId, playModelVersion: 1, sceneId: "scene", roleId: "role", retentionChoice: "retain",
      durationMs: 1_000, mediaType: "audio/wav", objectKey, state: "completed" });
  });

  afterEach(async () => client.close());

  it("returns 206 with an exact byte range for the owner", async () => {
    const response = await handler(ownerUserId)(new Request("http://localhost/audio", {
      headers: { range: "bytes=1-3" },
    }), context());

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 1-3/6");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it("returns 404 without reading another owner's audio", async () => {
    const response = await handler(otherUserId)(new Request("http://localhost/audio", {
      headers: { range: "bytes=0-1" },
    }), context());

    expect(response.status).toBe(404);
  });

  it("returns 404 after owned audio is explicitly deleted", async () => {
    await db.update(takes).set({ audioDeletedAt: new Date("2026-08-22T16:00:00Z") });

    const response = await handler(ownerUserId)(new Request("http://localhost/audio"), context());

    expect(response.status).toBe(404);
  });

  it("returns 416 for an unsatisfiable range without leaking storage details", async () => {
    const response = await handler(ownerUserId)(new Request("http://localhost/audio", {
      headers: { range: "bytes=10-20" },
    }), context());

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */6");
  });

  function handler(userId: string) {
    return createTakeAudioHandler({ authenticate: async () => ({ id: userId }), db, storage });
  }
});

function context() { return { params: Promise.resolve({ playId, takeId }) }; }
