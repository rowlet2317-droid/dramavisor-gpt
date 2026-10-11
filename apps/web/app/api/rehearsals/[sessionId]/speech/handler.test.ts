import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { characterVoiceAssignments, playModels, plays, rehearsalEvents, rehearsalSessions,
  users } from "@drama/db/schema";

import { createRehearsalSpeechHandler } from "./handler";

const migrations = ["0001_foundation.sql", "0002_play_processing_status.sql", "0002_practice_sessions.sql",
  "0003_reviewable_parse_jobs.sql", "0004_job_lease_fencing.sql", "0005_grounded_study.sql",
  "0006_current_artifact_uniqueness.sql", "0007_take_transcripts.sql", "0008_ordered_transcript_evidence.sql",
  "0009_take_metrics.sql", "0010_normalized_audio_artifacts.sql", "0011_stale_attempt_cleanup.sql",
  "0012_cleanup_attempt_history.sql", "0013_immutable_normalized_audio_keys.sql", "0014_coaching_reports.sql",
  "0015_take_audio_retention.sql", "0016_global_job_lease_history.sql", "0017_rehearsal_sessions.sql",
  "0018_rehearsal_events.sql", "0019_account_deletion.sql", "0020_rehearsal_linked_coaching.sql"];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const playId = "33333333-3333-4333-8333-333333333333";
const modelId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
const sceneId = "scene_1";
const actorRoleId = "actor";
const aiRoleId = "alex";
const aiElementId = "line_2";

describe("POST rehearsal configured speech", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    for (const name of migrations) await client.exec(await readFile(new URL(
      `../../../../../../../packages/db/migrations/${name}`, import.meta.url), "utf8"));
    db = drizzle(client, { schema });
    await db.insert(users).values({ id: ownerUserId, email: "actor@example.com", passwordHash: "hash" });
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(playModels).values({ id: modelId, ownerUserId, playId, version: 1,
      status: "approved", model: playModel(), issues: [] });
    await db.insert(rehearsalSessions).values({ id: sessionId, ownerUserId, playId, playModelId: modelId,
      playModelVersion: 1, sceneId, actorRoleId, model: "gpt-realtime-2.1",
      grantExpiresAt: new Date("2099-01-01T00:00:00.000Z"), state: "active" });
    await db.insert(rehearsalEvents).values([
      { ownerUserId, rehearsalSessionId: sessionId, sequence: 1, type: "started",
        event: { type: "started", sequence: 1, startedAtMs: 0 } },
      { ownerUserId, rehearsalSessionId: sessionId, sequence: 2, type: "actor_line_final",
        event: { type: "actor_line_final", sequence: 2, text: "We begin.", endedAtMs: 10 } },
    ]);
    await db.insert(characterVoiceAssignments).values({ ownerUserId, rehearsalSessionId: sessionId,
      characterId: aiRoleId, voice: "marin", engine: "realtime" });
  });

  afterEach(async () => client.close());

  it("sends only the pinned cursor text and persisted role voice to configured synthesis", async () => {
    const calls: Array<{ exactText: string; voice: string; signal?: AbortSignal }> = [];
    const handler = createRehearsalSpeechHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      synthesize: async (input) => { calls.push(input); return { bytes: Uint8Array.of(1, 2, 3),
        mediaType: "audio/mpeg" as const }; } });

    const response = await handler(request({ elementId: aiElementId }), context());

    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(calls).toEqual([{ exactText: "At last.", voice: "marin", signal: expect.any(AbortSignal) }]);
  });

  it("rejects client-selected text or voice before configured synthesis", async () => {
    let calls = 0;
    const handler = createRehearsalSpeechHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      synthesize: async () => { calls += 1; return { bytes: Uint8Array.of(1), mediaType: "audio/mpeg" as const }; } });

    const response = await handler(request({ elementId: aiElementId, exactText: "Invent this.", voice: "alloy" }),
      context());

    expect(response.status).toBe(422);
    expect(calls).toBe(0);
  });

  it("discards generated audio when Stop wins during synthesis", async () => {
    const handler = createRehearsalSpeechHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      synthesize: async () => {
        await db.update(rehearsalSessions).set({ state: "stopped" }).where(eq(rehearsalSessions.id, sessionId));
        return { bytes: Uint8Array.of(9, 9, 9), mediaType: "audio/mpeg" as const };
      } });

    const response = await handler(request({ elementId: aiElementId }), context());

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ error: "Rehearsal speech is no longer available" });
  });

  it("discards generated audio when account deletion wins during synthesis", async () => {
    const handler = createRehearsalSpeechHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      synthesize: async () => {
        await db.update(users).set({ accountStatus: "deleting" }).where(eq(users.id, ownerUserId));
        return { bytes: Uint8Array.of(8, 8, 8), mediaType: "audio/mpeg" as const };
      } });

    const response = await handler(request({ elementId: aiElementId }), context());

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ error: "Rehearsal session not found" });
  });

  it("rejects a non-cursor element and terminal session before synthesis", async () => {
    let calls = 0;
    const handler = createRehearsalSpeechHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      synthesize: async () => { calls += 1; return { bytes: Uint8Array.of(1), mediaType: "audio/mpeg" as const }; } });

    expect((await handler(request({ elementId: "line_1" }), context())).status).toBe(409);
    await db.update(rehearsalSessions).set({ state: "completed" }).where(eq(rehearsalSessions.id, sessionId));
    expect((await handler(request({ elementId: aiElementId }), context())).status).toBe(409);
    expect(calls).toBe(0);
  });
});

function request(body: Record<string, unknown>) {
  return new Request(`http://local/api/rehearsals/${sessionId}/speech`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function context() { return { params: Promise.resolve({ sessionId }) }; }

function playModel() {
  return { id: "model:v1", title: "Private Play", language: "en" as const,
    characters: [{ id: actorRoleId, name: "Actor", aliases: [] }, { id: aiRoleId, name: "Alex", aliases: [] }],
    acts: [{ id: "act", ordinal: 1, title: "Act I", scenes: [{ id: sceneId, ordinal: 1, title: "Scene",
      characterIds: [actorRoleId, aiRoleId], elements: [
        { id: "line_1", ordinal: 1, kind: "dialogue" as const, characterId: actorRoleId,
          text: "We begin.", sourcePage: 1 },
        { id: aiElementId, ordinal: 2, kind: "dialogue" as const, characterId: aiRoleId,
          text: "At last.", sourcePage: 1 },
      ] }] }] };
}
