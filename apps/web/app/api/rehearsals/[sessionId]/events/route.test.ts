import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { playModels, plays, rehearsalEvents, rehearsalSessions, users } from "@drama/db/schema";

import { createRehearsalEventHandler } from "./handler";

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

describe("POST rehearsal event", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    for (const name of migrations) await client.exec(await readFile(new URL(
      `../../../../../../../packages/db/migrations/${name}`, import.meta.url), "utf8"));
    db = drizzle(client, { schema });
    await db.insert(users).values([
      { id: ownerUserId, email: "actor@example.com", passwordHash: "hash" },
      { id: otherUserId, email: "other@example.com", passwordHash: "hash" },
    ]);
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(playModels).values({ id: modelId, ownerUserId, playId, version: 1,
      status: "approved", model: playModel(), issues: [] });
    await db.insert(rehearsalSessions).values({ id: sessionId, ownerUserId, playId, playModelId: modelId,
      playModelVersion: 1, sceneId: "scene_1", actorRoleId: "char_actor", model: "gpt-realtime-2.1",
      grantExpiresAt: new Date("2026-08-23T12:10:00.000Z") });
  });

  afterEach(async () => client.close());

  it("persists a monotonic event and acknowledges an identical retry idempotently", async () => {
    const handler = createRehearsalEventHandler({ authenticate: async () => ({ id: ownerUserId }), db });
    const event = { type: "started", sequence: 1, startedAtMs: 100 };

    const created = await handler(request(event), context());
    const retried = await handler(request(event), context());

    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ acknowledgedSequence: 1 });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ acknowledgedSequence: 1 });
    await expect(db.select().from(rehearsalEvents)).resolves.toHaveLength(1);
    await expect(db.select({ state: rehearsalSessions.state }).from(rehearsalSessions))
      .resolves.toEqual([{ state: "active" }]);
  });

  it("rejects conflicting duplicates and sequence gaps", async () => {
    const handler = createRehearsalEventHandler({ authenticate: async () => ({ id: ownerUserId }), db });
    await handler(request({ type: "started", sequence: 1, startedAtMs: 100 }), context());

    expect((await handler(request({ type: "paused", sequence: 1 }), context())).status).toBe(409);
    expect((await handler(request({ type: "paused", sequence: 3 }), context())).status).toBe(409);
    await expect(db.select().from(rehearsalEvents)).resolves.toHaveLength(1);
  });

  it("returns the same nonleaking conflict for paused provider completion and every event after Stop", async () => {
    const handler = createRehearsalEventHandler({ authenticate: async () => ({ id: ownerUserId }), db });
    await handler(request({ type: "started", sequence: 1, startedAtMs: 100 }), context());
    await handler(request({ type: "paused", sequence: 2 }), context());

    const pausedCompletion = await handler(request({ type: "ai_speech_finished", sequence: 3,
      characterId: "role", elementId: "line_1", endedAtMs: 200 }), context());
    expect(pausedCompletion.status).toBe(409);
    expect(await pausedCompletion.json()).toEqual({ error: "Rehearsal event conflicts with session state" });

    await handler(request({ type: "stopped", sequence: 3 }), context());
    const afterStop = await handler(request({ type: "resumed", sequence: 4 }), context());
    expect(afterStop.status).toBe(409);
    expect(await afterStop.json()).toEqual({ error: "Rehearsal event conflicts with session state" });
    await expect(db.select({ sequence: rehearsalEvents.sequence }).from(rehearsalEvents)
      .orderBy(rehearsalEvents.sequence)).resolves.toEqual([
      { sequence: 1 }, { sequence: 2 }, { sequence: 3 },
    ]);
  });

  it("accepts the durable interruption choices and manual fallback completion payloads", async () => {
    const handler = createRehearsalEventHandler({ authenticate: async () => ({ id: ownerUserId }), db });
    const accepted = [
      { type: "started", sequence: 1, startedAtMs: 100 },
      { type: "interrupted", sequence: 2, elementId: "line_1", atMs: 110 },
      { type: "continue_after_interruption", sequence: 3, elementId: "line_1" },
      { type: "interrupted", sequence: 4, elementId: "line_2", atMs: 115 },
      { type: "restart_line", sequence: 5, elementId: "line_2" },
      { type: "manual_actor_line_completed", sequence: 6, elementId: "line_2", endedAtMs: 120 },
    ];

    for (const event of accepted) expect((await handler(request(event), context())).status).toBe(201);
    await expect(db.select({ type: rehearsalEvents.type }).from(rehearsalEvents)
      .orderBy(rehearsalEvents.sequence)).resolves.toEqual([
      { type: "started" }, { type: "interrupted" }, { type: "continue_after_interruption" },
      { type: "interrupted" }, { type: "restart_line" }, { type: "manual_actor_line_completed" },
    ]);
  });

  it("persists server receipt timing and ignores provider-looking fields from browser events", async () => {
    // Break caught: trusting payload timing metadata lets a browser forge provider-derived coaching evidence.
    const receipts = [10_000, 10_100, 10_500, 11_240].map((atMs) => new Date(atMs));
    const handler = createRehearsalEventHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      now: () => receipts.shift()! });
    const events = [
      { type: "started", sequence: 1, startedAtMs: 1 },
      { type: "ai_speech_started", sequence: 2, characterId: "char_actor", elementId: "line_1",
        startedAtMs: 2 },
      { type: "ai_speech_finished", sequence: 3, characterId: "char_actor", elementId: "line_1",
        endedAtMs: 3, timingSource: "provider-derived", timingClockId: "provider:spoof", timingAtMs: 50_000 },
      { type: "manual_actor_line_completed", sequence: 4, elementId: "line_2", endedAtMs: 4,
        timingSource: "provider-derived", timingClockId: "provider:spoof", timingAtMs: 50_100 },
    ];

    for (const event of events) expect((await handler(request(event), context())).status).toBe(201);
    const result = await client.query<{ row: Record<string, unknown> }>(`SELECT row_to_json(rehearsal_events) AS row
      FROM rehearsal_events WHERE sequence IN (3, 4) ORDER BY sequence`);

    expect(result.rows.map(({ row }) => ({ source: row.timing_source, atMs: row.timing_at_ms,
      clock: row.timing_clock_id, receivedAtMs: row.received_at_ms,
      receivedClock: row.received_clock_id }))).toEqual([
      { source: "server-receipt", atMs: 10_500, clock: "server:unix-epoch-ms",
        receivedAtMs: 10_500, receivedClock: "server:unix-epoch-ms" },
      { source: "server-receipt", atMs: 11_240, clock: "server:unix-epoch-ms",
        receivedAtMs: 11_240, receivedClock: "server:unix-epoch-ms" },
    ]);
  });

  it("keeps reducer-completed sessions terminal while acknowledging the exact final retry", async () => {
    const handler = createRehearsalEventHandler({ authenticate: async () => ({ id: ownerUserId }), db });
    await handler(request({ type: "started", sequence: 1, startedAtMs: 100 }), context());
    await handler(request({ type: "actor_line_final", sequence: 2, text: "We begin.", endedAtMs: 150 }), context());
    await handler(request({ type: "actor_line_final", sequence: 3, text: "We continue.", endedAtMs: 175 }), context());
    const finalEvent = { type: "actor_line_final", sequence: 4, text: "We finish.", endedAtMs: 200 };

    expect((await handler(request(finalEvent), context())).status).toBe(201);
    expect((await handler(request(finalEvent), context())).status).toBe(200);
    const later = await handler(request({ type: "resumed", sequence: 5 }), context());

    expect(later.status).toBe(409);
    expect(await later.json()).toEqual({ error: "Rehearsal event conflicts with session state" });
    await expect(db.select({ state: rehearsalSessions.state }).from(rehearsalSessions))
      .resolves.toEqual([{ state: "completed" }]);
  });

  it("rejects nonpersistent partial transcripts and malformed events", async () => {
    const handler = createRehearsalEventHandler({ authenticate: async () => ({ id: ownerUserId }), db });

    expect((await handler(request({ type: "actor_partial", text: "We be" }), context())).status).toBe(422);
    expect((await handler(request({ type: "paused", sequence: 0 }), context())).status).toBe(422);
  });

  it("returns an owner-safe 404 for another user's session", async () => {
    const handler = createRehearsalEventHandler({ authenticate: async () => ({ id: otherUserId }), db });

    expect((await handler(request({ type: "started", sequence: 1, startedAtMs: 100 }), context())).status)
      .toBe(404);
    await expect(db.select().from(rehearsalEvents)).resolves.toEqual([]);
  });

  it("does not append an event after the owner starts account deletion", async () => {
    await db.update(users).set({ accountStatus: "deleting" }).where(eq(users.id, ownerUserId));
    const handler = createRehearsalEventHandler({ authenticate: async () => ({ id: ownerUserId }), db });

    const response = await handler(request({ type: "started", sequence: 1, startedAtMs: 100 }), context());

    expect(response.status).toBe(404);
    await expect(db.select().from(rehearsalEvents)).resolves.toEqual([]);
    await expect(db.select({ state: rehearsalSessions.state }).from(rehearsalSessions))
      .resolves.toEqual([{ state: "grant_issued" }]);
  });
});

function request(event: Record<string, unknown>) {
  return new Request("http://local/events", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ event }) });
}

function context() { return { params: Promise.resolve({ sessionId }) }; }

function playModel() {
  return { id: "model:v1", title: "Private Play", language: "en" as const,
    characters: [{ id: "char_actor", name: "Actor", aliases: [] }], acts: [{ id: "act", ordinal: 1,
      title: "Act I", scenes: [{ id: "scene_1", ordinal: 1, title: "Scene", characterIds: ["char_actor"],
        elements: [
          { id: "line_1", ordinal: 1, kind: "dialogue" as const, characterId: "char_actor",
            text: "We begin.", sourcePage: 1 },
          { id: "line_2", ordinal: 2, kind: "dialogue" as const, characterId: "char_actor",
            text: "We continue.", sourcePage: 1 },
          { id: "line_3", ordinal: 3, kind: "dialogue" as const, characterId: "char_actor",
            text: "We finish.", sourcePage: 1 },
        ] }] }] };
}
