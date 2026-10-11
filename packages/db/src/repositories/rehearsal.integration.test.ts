import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle, type PgliteQueryResultHKT } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../schema";
import { characterVoiceAssignments, playModels, plays, rehearsalEvents, rehearsalSessions,
  users } from "../schema";
import { RehearsalRepository } from "./rehearsal";

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
const sceneId = "scene_1";
const actorRoleId = "char_actor";

describe("RehearsalRepository", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let repository: RehearsalRepository<PgliteQueryResultHKT>;

  beforeEach(async () => {
    client = new PGlite();
    for (const name of migrations) {
      await client.exec(await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
    }
    db = drizzle(client, { schema });
    repository = new RehearsalRepository(db);
    await db.insert(users).values([
      { id: ownerUserId, email: "actor@example.com", passwordHash: "hash" },
      { id: otherUserId, email: "other@example.com", passwordHash: "hash" },
    ]);
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(playModels).values({ id: modelId, ownerUserId, playId, version: 1,
      status: "approved", model: playModel(), issues: [] });
    await db.insert(rehearsalSessions).values({ id: sessionId, ownerUserId, playId, playModelId: modelId,
      playModelVersion: 1, sceneId, actorRoleId, model: "gpt-realtime-2.1",
      grantExpiresAt: new Date("2026-08-23T12:10:00.000Z") });
  });

  afterEach(async () => client.close());

  it("persists ordered events and rehydrates the pinned scene through the pure reducer", async () => {
    await repository.appendEvent({ ownerUserId, sessionId,
      event: { type: "started", sequence: 1, startedAtMs: 0 } });
    await repository.appendEvent({ ownerUserId, sessionId,
      event: { type: "actor_line_final", sequence: 2, text: "We begin.", endedAtMs: 1_200 } });

    const result = await repository.rehydrate(ownerUserId, sessionId);

    expect(result).toMatchObject({ lastSequence: 2, status: "active", cursorElementId: "line_0002",
      pendingAction: { type: "speak", elementId: "line_0002", characterId: "char_bea" } });
    await expect(db.select().from(rehearsalEvents)).resolves.toEqual([
      expect.objectContaining({ ownerUserId, rehearsalSessionId: sessionId, sequence: 1, type: "started" }),
      expect.objectContaining({ ownerUserId, rehearsalSessionId: sessionId, sequence: 2,
        type: "actor_line_final" }),
    ]);
  });

  it("persists provider timing only through the explicit trusted adapter path", async () => {
    // Break caught: provider confidence must require a server-only repository API, not event payload fields.
    await repository.appendEvent({ ownerUserId, sessionId, receivedAt: new Date(9_000),
      event: { type: "started", sequence: 1, startedAtMs: 0 } });

    await repository.appendTrustedProviderEvent({ ownerUserId, sessionId, receivedAt: new Date(10_500),
      providerTiming: { atMs: 500, clockId: "provider:response-stream-7" },
      event: { type: "actor_line_final", sequence: 2, text: "We begin.", endedAtMs: 999_999 } });

    await expect(db.select({ receivedAtMs: rehearsalEvents.receivedAtMs,
      receivedClockId: rehearsalEvents.receivedClockId, timingSource: rehearsalEvents.timingSource,
      timingAtMs: rehearsalEvents.timingAtMs, timingClockId: rehearsalEvents.timingClockId })
      .from(rehearsalEvents).orderBy(rehearsalEvents.sequence)).resolves.toEqual([
      { receivedAtMs: 9_000, receivedClockId: "server:unix-epoch-ms", timingSource: "server-receipt",
        timingAtMs: 9_000, timingClockId: "server:unix-epoch-ms" },
      { receivedAtMs: 10_500, receivedClockId: "server:unix-epoch-ms", timingSource: "provider-derived",
        timingAtMs: 500, timingClockId: "provider:response-stream-7" },
    ]);
  });

  it("refuses to mark manual completion as trusted provider timing", async () => {
    // Break caught: a server adapter must not accidentally upgrade a manual/browser completion to provider evidence.
    await repository.appendEvent({ ownerUserId, sessionId, receivedAt: new Date(9_000),
      event: { type: "started", sequence: 1, startedAtMs: 0 } });

    await expect(repository.appendTrustedProviderEvent({ ownerUserId, sessionId,
      receivedAt: new Date(10_500), providerTiming: { atMs: 500, clockId: "provider:stream" },
      event: { type: "manual_actor_line_completed", sequence: 2, elementId: "line_0001", endedAtMs: 500 } }))
      .rejects.toThrow("INVALID_TRUSTED_PROVIDER_EVENT_TYPE");

    await expect(db.select().from(rehearsalEvents)).resolves.toHaveLength(1);
  });

  it("acknowledges an identical retry but rejects a nonidentical duplicate and sequence gap", async () => {
    await repository.appendEvent({ ownerUserId, sessionId,
      event: { type: "started", sequence: 1, startedAtMs: 0 } });

    await expect(repository.appendEvent({ ownerUserId, sessionId,
      event: { type: "started", sequence: 1, startedAtMs: 0 } }))
      .resolves.toMatchObject({ sequence: 1, type: "started" });
    await expect(repository.appendEvent({ ownerUserId, sessionId,
      event: { type: "paused", sequence: 1 } })).rejects.toThrow("Expected rehearsal sequence 2, received 1");
    await expect(repository.appendEvent({ ownerUserId, sessionId,
      event: { type: "paused", sequence: 3 } })).rejects.toThrow("Expected rehearsal sequence 2, received 3");
    await expect(db.select().from(rehearsalEvents)).resolves.toHaveLength(1);
  });

  it("serializes concurrent appends under the session lock without creating duplicate sequences", async () => {
    await repository.appendEvent({ ownerUserId, sessionId,
      event: { type: "started", sequence: 1, startedAtMs: 0 } });

    const results = await Promise.all([
      repository.appendEvent({ ownerUserId, sessionId, event: { type: "paused", sequence: 2 } }),
      repository.appendEvent({ ownerUserId, sessionId, event: { type: "resumed", sequence: 3 } }),
    ]);

    expect(results.map(({ sequence }) => sequence)).toEqual([2, 3]);
    await expect(db.select({ sequence: rehearsalEvents.sequence }).from(rehearsalEvents)
      .orderBy(rehearsalEvents.sequence)).resolves.toEqual([{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }]);
  });

  it("keeps Stop terminal with zero event or session-state mutation after later writes", async () => {
    await repository.appendEvent({ ownerUserId, sessionId,
      event: { type: "started", sequence: 1, startedAtMs: 0 } });
    await repository.appendEvent({ ownerUserId, sessionId, event: { type: "stopped", sequence: 2 } });

    await expect(repository.appendEvent({ ownerUserId, sessionId, event: { type: "stopped", sequence: 2 } }))
      .resolves.toMatchObject({ sequence: 2, type: "stopped", idempotent: true });

    await expect(repository.appendEvent({ ownerUserId, sessionId,
      event: { type: "resumed", sequence: 3 } })).rejects.toThrow("TERMINAL_SESSION");
    await expect(repository.appendEvent({ ownerUserId, sessionId,
      event: { type: "stopped", sequence: 3 } })).rejects.toThrow("TERMINAL_SESSION");
    await expect(db.select({ sequence: rehearsalEvents.sequence, type: rehearsalEvents.type })
      .from(rehearsalEvents).orderBy(rehearsalEvents.sequence)).resolves.toEqual([
      { sequence: 1, type: "started" }, { sequence: 2, type: "stopped" },
    ]);
    await expect(db.select({ state: rehearsalSessions.state, grantExpiresAt: rehearsalSessions.grantExpiresAt })
      .from(rehearsalSessions)).resolves.toEqual([{ state: "stopped",
        grantExpiresAt: new Date("2026-08-23T12:10:00.000Z") }]);
  });

  it("persists reducer-derived completion and accepts only the exact final-event retry", async () => {
    await repository.appendEvent({ ownerUserId, sessionId,
      event: { type: "started", sequence: 1, startedAtMs: 0 } });
    await repository.appendEvent({ ownerUserId, sessionId,
      event: { type: "actor_line_final", sequence: 2, text: "We begin.", endedAtMs: 10 } });
    const finalEvent = { type: "ai_speech_finished" as const, sequence: 3, characterId: "char_bea",
      elementId: "line_0002", endedAtMs: 20 };

    await repository.appendEvent({ ownerUserId, sessionId, event: finalEvent });
    await expect(repository.appendEvent({ ownerUserId, sessionId, event: finalEvent }))
      .resolves.toMatchObject({ sequence: 3, idempotent: true });
    await expect(repository.appendEvent({ ownerUserId, sessionId,
      event: { type: "resumed", sequence: 4 } })).rejects.toThrow("ILLEGAL_TRANSITION");

    await expect(db.select({ state: rehearsalSessions.state }).from(rehearsalSessions))
      .resolves.toEqual([{ state: "completed" }]);
    await expect(db.select({ sequence: rehearsalEvents.sequence }).from(rehearsalEvents)
      .orderBy(rehearsalEvents.sequence)).resolves.toEqual([
      { sequence: 1 }, { sequence: 2 }, { sequence: 3 },
    ]);
  });

  it.each([
    ["matching actor transcript", { type: "actor_line_final" as const, sequence: 2,
      text: "We begin.", endedAtMs: 10 }],
    ["manual actor completion", { type: "manual_actor_line_completed" as const, sequence: 2,
      elementId: "line_0001", endedAtMs: 10 }],
  ])("persists completed after a final %s event", async (_label, finalEvent) => {
    await db.update(playModels).set({ model: actorOnlyPlayModel() });
    await repository.appendEvent({ ownerUserId, sessionId,
      event: { type: "started", sequence: 1, startedAtMs: 0 } });

    await repository.appendEvent({ ownerUserId, sessionId, event: finalEvent });

    await expect(db.select({ state: rehearsalSessions.state }).from(rehearsalSessions))
      .resolves.toEqual([{ state: "completed" }]);
  });

  it("persists needs-position-confirmation instead of collapsing an unmatched actor line to active", async () => {
    await repository.appendEvent({ ownerUserId, sessionId,
      event: { type: "started", sequence: 1, startedAtMs: 0 } });

    await repository.appendEvent({ ownerUserId, sessionId,
      event: { type: "actor_line_final", sequence: 2, text: "different words", endedAtMs: 10 } });

    await expect(db.select({ state: rehearsalSessions.state }).from(rehearsalSessions))
      .resolves.toEqual([{ state: "needs_position_confirmation" }]);
    await expect(repository.appendEvent({ ownerUserId, sessionId,
      event: { type: "ai_speech_started", sequence: 3, characterId: "char_bea",
        elementId: "line_0002", startedAtMs: 20 } })).rejects.toThrow("ILLEGAL_TRANSITION");
  });

  it("retains an explicit recovering fence instead of treating it as active", async () => {
    await client.exec(`UPDATE rehearsal_sessions SET state = 'recovering' WHERE id = '${sessionId}'`);

    await expect(repository.appendEvent({ ownerUserId, sessionId,
      event: { type: "started", sequence: 1, startedAtMs: 0 } })).rejects.toThrow("ILLEGAL_TRANSITION");

    await expect(db.select({ state: rehearsalSessions.state }).from(rehearsalSessions))
      .resolves.toEqual([{ state: "recovering" }]);
    await expect(db.select().from(rehearsalEvents)).resolves.toEqual([]);
  });

  it("returns no state and refuses writes for another user's session", async () => {
    await expect(repository.rehydrate(otherUserId, sessionId)).resolves.toBeNull();
    await expect(repository.appendEvent({ ownerUserId: otherUserId, sessionId,
      event: { type: "started", sequence: 1, startedAtMs: 0 } }))
      .rejects.toThrow("Rehearsal session not found");
    await expect(db.select().from(rehearsalEvents)).resolves.toEqual([]);
  });

  it("enforces owner consistency for character voice assignments", async () => {
    await db.insert(characterVoiceAssignments).values({ ownerUserId, rehearsalSessionId: sessionId,
      characterId: "char_bea", voice: "marin", engine: "realtime" });

    await expect(db.insert(characterVoiceAssignments).values({ ownerUserId: otherUserId,
      rehearsalSessionId: sessionId, characterId: "char_actor", voice: "cedar", engine: "realtime" }))
      .rejects.toMatchObject({ cause: { code: "23503",
        constraint: "character_voice_assignments_session_owner_fk" } });
  });
});

function playModel() {
  return { id: "model:v1", title: "Private Play", language: "en" as const,
    characters: [{ id: actorRoleId, name: "Actor", aliases: [] },
      { id: "char_bea", name: "Bea", aliases: [] }], acts: [{ id: "act", ordinal: 1, title: "Act I",
      scenes: [{ id: sceneId, ordinal: 1, title: "Scene", characterIds: [actorRoleId, "char_bea"],
        elements: [
          { id: "line_0001", ordinal: 1, kind: "dialogue" as const, characterId: actorRoleId,
            text: "We begin.", sourcePage: 1 },
          { id: "line_0002", ordinal: 2, kind: "dialogue" as const, characterId: "char_bea",
            text: "At last.", sourcePage: 1 },
        ] }] }] };
}

function actorOnlyPlayModel() {
  return { id: "model:v1", title: "Private Play", language: "en" as const,
    characters: [{ id: actorRoleId, name: "Actor", aliases: [] }],
    acts: [{ id: "act", ordinal: 1, title: "Act I", scenes: [{ id: sceneId, ordinal: 1, title: "Scene",
      characterIds: [actorRoleId], elements: [
        { id: "line_0001", ordinal: 1, kind: "dialogue" as const, characterId: actorRoleId,
          text: "We begin.", sourcePage: 1 },
      ] }] }] };
}
