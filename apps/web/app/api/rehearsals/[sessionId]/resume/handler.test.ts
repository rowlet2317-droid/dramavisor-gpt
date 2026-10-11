import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { characterVoiceAssignments, playModels, plays, rehearsalEvents, rehearsalSessions,
  users } from "@drama/db/schema";

import { createResumeRehearsalHandler } from "./handler";

const migrations = ["0001_foundation.sql", "0002_play_processing_status.sql", "0002_practice_sessions.sql",
  "0003_reviewable_parse_jobs.sql", "0004_job_lease_fencing.sql", "0005_grounded_study.sql",
  "0006_current_artifact_uniqueness.sql", "0007_take_transcripts.sql", "0008_ordered_transcript_evidence.sql",
  "0009_take_metrics.sql", "0010_normalized_audio_artifacts.sql", "0011_stale_attempt_cleanup.sql",
  "0012_cleanup_attempt_history.sql", "0013_immutable_normalized_audio_keys.sql", "0014_coaching_reports.sql",
  "0015_take_audio_retention.sql", "0016_global_job_lease_history.sql", "0017_rehearsal_sessions.sql",
  "0018_rehearsal_events.sql", "0019_account_deletion.sql", "0020_rehearsal_linked_coaching.sql"];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const playId = "33333333-3333-4333-8333-333333333333";
const pinnedModelId = "44444444-4444-4444-8444-444444444444";
const currentModelId = "55555555-5555-4555-8555-555555555555";
const sessionId = "66666666-6666-4666-8666-666666666666";

describe("POST rehearsal resume", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    for (const name of migrations) await client.exec(await readFile(new URL(
      `../../../../../../../packages/db/migrations/${name}`, import.meta.url), "utf8"));
    db = drizzle(client, { schema });
    await db.insert(users).values({ id: ownerUserId, email: "actor@example.com", passwordHash: "hash" });
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(playModels).values([
      { id: pinnedModelId, ownerUserId, playId, version: 1, status: "superseded", model: playModel(1), issues: [] },
      { id: currentModelId, ownerUserId, playId, version: 2, status: "approved", model: playModel(2), issues: [] },
    ]);
    await db.insert(rehearsalSessions).values({ id: sessionId, ownerUserId, playId, playModelId: pinnedModelId,
      playModelVersion: 1, sceneId: "scene_1", actorRoleId: "actor", model: "gpt-realtime-2.1",
      grantExpiresAt: new Date("2026-08-23T12:10:00.000Z") });
    await db.insert(rehearsalEvents).values({ ownerUserId, rehearsalSessionId: sessionId, sequence: 1,
      type: "started", event: { type: "started", sequence: 1, startedAtMs: 100 } });
    await db.insert(characterVoiceAssignments).values({ ownerUserId, rehearsalSessionId: sessionId,
      characterId: "alex", voice: "marin", engine: "realtime" });
  });

  afterEach(async () => client.close());

  it("returns the owner-scoped current approved play model version and persisted voice assignments", async () => {
    const handler = createResumeRehearsalHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      credentials: { issue: async () => ({ clientSecret: "ek_resume", expiresAt: "2026-08-23T12:09:00.000Z",
        model: "gpt-realtime-2.1" }) }, now: () => new Date("2026-08-23T12:08:00.000Z") });

    const response = await handler(new Request("http://local/resume", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ clientLastSequence: 1,
        playModelVersion: 1 }) }), { params: Promise.resolve({ sessionId }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recovery: { serverPlayModelVersion: 2,
      assignments: [{ characterId: "alex", voice: "marin", engine: "realtime" }] } });
  });

  it("does not issue or update a grant after the owner starts account deletion", async () => {
    await db.update(users).set({ accountStatus: "deleting" }).where(eq(users.id, ownerUserId));
    let issueCalls = 0;
    const handler = createResumeRehearsalHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      credentials: { issue: async () => { issueCalls += 1; return { clientSecret: "must-not-issue",
        expiresAt: "2026-08-23T12:09:00.000Z", model: "gpt-realtime-2.1" }; } },
      now: () => new Date("2026-08-23T12:08:00.000Z") });

    const response = await handler(new Request("http://local/resume", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ clientLastSequence: 1,
        playModelVersion: 1 }) }), { params: Promise.resolve({ sessionId }) });

    expect(response.status).toBe(404);
    expect(issueCalls).toBe(0);
    expect((await db.select().from(rehearsalSessions))[0]!.grantExpiresAt)
      .toEqual(new Date("2026-08-23T12:10:00.000Z"));
  });

  it("does not persist or return a provider secret when deletion starts during issuance", async () => {
    let issueCalls = 0;
    const handler = createResumeRehearsalHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      credentials: { issue: async () => {
        issueCalls += 1;
        await db.update(users).set({ accountStatus: "deleting" }).where(eq(users.id, ownerUserId));
        return { clientSecret: "discarded-secret", expiresAt: "2026-08-23T12:09:00.000Z",
          model: "gpt-realtime-2.1" };
      } }, now: () => new Date("2026-08-23T12:08:00.000Z") });

    const response = await handler(resumeRequest(), { params: Promise.resolve({ sessionId }) });

    expect(response.status).toBe(404);
    expect(await response.json()).not.toHaveProperty("grant");
    expect(issueCalls).toBe(1);
    expect((await db.select().from(rehearsalSessions))[0]!.grantExpiresAt)
      .toEqual(new Date("2026-08-23T12:10:00.000Z"));
  });

  it("discards a provider secret when Stop wins during issuance", async () => {
    let issueCalls = 0;
    const handler = createResumeRehearsalHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      credentials: { issue: async () => {
        issueCalls += 1;
        await db.update(rehearsalSessions).set({ state: "stopped" }).where(eq(rehearsalSessions.id, sessionId));
        return { clientSecret: "discarded-after-stop", expiresAt: "2026-08-23T12:09:00.000Z",
          model: "gpt-realtime-2.1" };
      } }, now: () => new Date("2026-08-23T12:08:00.000Z") });

    const response = await handler(resumeRequest(), { params: Promise.resolve({ sessionId }) });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Rehearsal session has stopped" });
    expect(issueCalls).toBe(1);
    expect((await db.select().from(rehearsalSessions))[0]!.grantExpiresAt)
      .toEqual(new Date("2026-08-23T12:10:00.000Z"));
  });

  it("does not issue a provider secret for a reducer-completed rehearsal", async () => {
    await client.exec(`UPDATE rehearsal_sessions SET state = 'completed' WHERE id = '${sessionId}'`);
    let issueCalls = 0;
    const handler = createResumeRehearsalHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      credentials: { issue: async () => { issueCalls += 1; return { clientSecret: "must-not-return",
        expiresAt: "2026-08-23T12:09:00.000Z", model: "gpt-realtime-2.1" }; } },
      now: () => new Date("2026-08-23T12:08:00.000Z") });

    const response = await handler(resumeRequest(), { params: Promise.resolve({ sessionId }) });

    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("grant");
    expect(issueCalls).toBe(0);
  });

  it("does not persist or return a secret with an excessive expiry", async () => {
    const handler = createResumeRehearsalHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      credentials: { issue: async () => ({ clientSecret: "excessive-secret",
        expiresAt: "2026-08-23T12:18:00.001Z", model: "gpt-realtime-2.1" }) },
      now: () => new Date("2026-08-23T12:08:00.000Z") });

    const response = await handler(resumeRequest(), { params: Promise.resolve({ sessionId }) });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Invalid realtime credential expiry" });
    expect((await db.select().from(rehearsalSessions))[0]!.grantExpiresAt)
      .toEqual(new Date("2026-08-23T12:10:00.000Z"));
  });
});

function resumeRequest() {
  return new Request("http://local/resume", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientLastSequence: 1, playModelVersion: 1 }) });
}

function playModel(version: number) {
  return { id: `model:v${version}`, title: "Private Play", language: "en" as const,
    characters: [{ id: "actor", name: "Actor", aliases: [] }], acts: [{ id: "act", ordinal: 1,
      title: "Act I", scenes: [{ id: "scene_1", ordinal: 1, title: "Scene", characterIds: ["actor"],
        elements: [{ id: "line_1", ordinal: 1, kind: "dialogue" as const, characterId: "actor",
          text: "We begin.", sourcePage: 1 }] }] }] };
}
