import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { characterVoiceAssignments, playModels, plays, rehearsalSessions, users } from "@drama/db/schema";

import { createRealtimeSessionHandler } from "./handler";

const migrations = ["0001_foundation.sql", "0002_play_processing_status.sql", "0002_practice_sessions.sql",
  "0003_reviewable_parse_jobs.sql", "0004_job_lease_fencing.sql", "0005_grounded_study.sql",
  "0006_current_artifact_uniqueness.sql", "0007_take_transcripts.sql", "0008_ordered_transcript_evidence.sql",
  "0009_take_metrics.sql", "0010_normalized_audio_artifacts.sql", "0011_stale_attempt_cleanup.sql",
  "0012_cleanup_attempt_history.sql", "0013_immutable_normalized_audio_keys.sql", "0014_coaching_reports.sql",
  "0015_take_audio_retention.sql", "0016_global_job_lease_history.sql", "0017_rehearsal_sessions.sql",
  "0018_rehearsal_events.sql", "0019_account_deletion.sql"];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const playId = "33333333-3333-4333-8333-333333333333";
const modelId = "44444444-4444-4444-8444-444444444444";
const rehearsalSessionId = "55555555-5555-4555-8555-555555555555";
const sceneId = "model:v1:scene:1";
const roleId = "model:v1:character:1";
const aiRoleIds = ["model:v1:character:2", "model:v1:character:3", "model:v1:character:4",
  "model:v1:character:5"];

describe("POST realtime session", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    for (const name of migrations) {
      await client.exec(await readFile(new URL(`../../../../../../packages/db/migrations/${name}`,
        import.meta.url), "utf8"));
    }
    db = drizzle(client, { schema });
    await db.insert(users).values([
      { id: ownerUserId, email: "actor@example.com", passwordHash: "hash" },
      { id: otherUserId, email: "other@example.com", passwordHash: "hash" },
    ]);
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(playModels).values({ id: modelId, ownerUserId, playId, version: 1,
      status: "approved", model: playModel(), issues: [] });
  });

  afterEach(async () => client.close());

  it("issues and persists an owner-scoped grant for an approved scene role", async () => {
    const handler = createRealtimeSessionHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      credentials: { issue: async () => ({ clientSecret: "ek_test",
        expiresAt: "2026-08-23T00:50:00.000Z", model: "gpt-realtime-2.1" }) },
      createId: () => rehearsalSessionId, now: () => new Date("2026-08-23T00:40:00.000Z"), ttsConfigured: true });

    const response = await handler(request({ type: "start", playId, sceneId, actorRoleId: roleId }));

    expect(response.status).toBe(201);
    const body = await response.json() as { assignments: Array<{ characterId: string; engine: string }> };
    expect(body).toMatchObject({ clientSecret: "ek_test", expiresAt: "2026-08-23T00:50:00.000Z",
      model: "gpt-realtime-2.1", rehearsalSessionId, ttsConfigured: true });
    expect(body.assignments).toHaveLength(4);
    expect(body.assignments).toEqual(expect.arrayContaining(aiRoleIds.map((characterId) =>
      expect.objectContaining({ characterId, engine: "realtime" }))));
    expect(body.assignments).not.toContainEqual(expect.objectContaining({ characterId: roleId }));
    await expect(db.select().from(rehearsalSessions)).resolves.toEqual([expect.objectContaining({
      id: rehearsalSessionId, ownerUserId, playId, playModelId: modelId, playModelVersion: 1,
      sceneId, actorRoleId: roleId, model: "gpt-realtime-2.1", state: "grant_issued",
    })]);
    await expect(db.select().from(characterVoiceAssignments)).resolves.toEqual(expect.arrayContaining(
      aiRoleIds.map((characterId) => expect.objectContaining({ ownerUserId, rehearsalSessionId, characterId,
        engine: "realtime" })),
    ));
  });

  it("returns an owner-safe 404 before asking the provider for another actor's play", async () => {
    let providerCalls = 0;
    const handler = createRealtimeSessionHandler({ authenticate: async () => ({ id: otherUserId }), db,
      credentials: { issue: async () => { providerCalls += 1; throw new Error("must not run"); } } });

    const response = await handler(request({ type: "start", playId, sceneId, actorRoleId: roleId }));

    expect(response.status).toBe(404);
    expect(providerCalls).toBe(0);
    await expect(db.select().from(rehearsalSessions)).resolves.toEqual([]);
  });

  it("discards a realtime grant when account deletion wins during provider issuance", async () => {
    // Break caught: awaiting the provider under the owner lock blocks deletion instead of discarding the losing secret.
    let providerCalls = 0;
    const handler = createRealtimeSessionHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      credentials: { issue: async () => {
        providerCalls += 1;
        await db.update(users).set({ accountStatus: "deleting" }).where(eq(users.id, ownerUserId));
        return { clientSecret: "discarded-secret", expiresAt: "2026-08-23T00:45:00.000Z",
          model: "gpt-realtime-2.1" };
      } }, createId: () => rehearsalSessionId, now: () => new Date("2026-08-23T00:40:00.000Z") });

    const response = await handler(request({ type: "start", playId, sceneId, actorRoleId: roleId }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Play not found" });
    expect(providerCalls).toBe(1);
    await expect(db.select().from(rehearsalSessions)).resolves.toEqual([]);
    await expect(db.select().from(characterVoiceAssignments)).resolves.toEqual([]);
  });

  it("does not mint a provider grant after the owner enters deletion", async () => {
    await db.update(users).set({ accountStatus: "deleting" }).where(eq(users.id, ownerUserId));
    let providerCalls = 0;
    const handler = createRealtimeSessionHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      credentials: { issue: async () => { providerCalls += 1; throw new Error("must not run"); } } });

    const response = await handler(request({ type: "start", playId, sceneId, actorRoleId: roleId }));

    expect(response.status).toBe(404);
    expect(providerCalls).toBe(0);
    await expect(db.select().from(rehearsalSessions)).resolves.toEqual([]);
  });

  it("rejects scene or role identifiers outside the approved play model", async () => {
    const handler = createRealtimeSessionHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      credentials: { issue: async () => { throw new Error("must not run"); } } });

    const response = await handler(request({ type: "start", playId, sceneId: "missing-scene", actorRoleId: roleId }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Realtime rehearsal context not found" });
  });

  it("issues a persisted role voice grant without creating another rehearsal", async () => {
    const issuedPurposes: Array<unknown> = [];
    const handler = createRealtimeSessionHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      credentials: { issue: async (input) => {
        issuedPurposes.push(input.purpose);
        return { clientSecret: input.purpose.type === "actor_input" ? "ek_actor" : "ek_role",
          expiresAt: "2026-08-23T00:50:00.000Z", model: "gpt-realtime-2.1" };
      } }, createId: () => rehearsalSessionId, supportedVoices: ["cedar"],
      now: () => new Date("2026-08-23T00:40:00.000Z") });

    await handler(request({ type: "start", playId, sceneId, actorRoleId: roleId }));
    const response = await handler(request({ type: "role_output", rehearsalSessionId, roleId: aiRoleIds[0]! }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clientSecret: "ek_role", expiresAt: "2026-08-23T00:50:00.000Z",
      model: "gpt-realtime-2.1", rehearsalSessionId });
    expect(issuedPurposes).toEqual([{ type: "actor_input" },
      { type: "role_output", roleId: aiRoleIds[0], voice: "cedar" }]);
    await expect(db.select().from(rehearsalSessions)).resolves.toHaveLength(1);
  });

  it("rejects a role-output grant for the actor input role", async () => {
    const issuedPurposes: Array<unknown> = [];
    const handler = createRealtimeSessionHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      credentials: { issue: async (input) => {
        issuedPurposes.push(input.purpose);
        return { clientSecret: "ek_actor", expiresAt: "2026-08-23T00:50:00.000Z", model: "gpt-realtime-2.1" };
      } }, createId: () => rehearsalSessionId, now: () => new Date("2026-08-23T00:40:00.000Z") });

    await handler(request({ type: "start", playId, sceneId, actorRoleId: roleId }));
    const response = await handler(request({ type: "role_output", rehearsalSessionId, roleId }));

    expect(response.status).toBe(422);
    expect(issuedPurposes).toEqual([{ type: "actor_input" }]);
  });

  it("does not ask the provider for role output after the rehearsal has stopped", async () => {
    let roleProviderCalls = 0;
    const handler = createRealtimeSessionHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      credentials: { issue: async (input) => {
        if (input.purpose.type === "role_output") roleProviderCalls += 1;
        return { clientSecret: "grant", expiresAt: "2026-08-23T00:50:00.000Z", model: "gpt-realtime-2.1" };
      } }, createId: () => rehearsalSessionId, supportedVoices: ["cedar"],
      now: () => new Date("2026-08-23T00:40:00.000Z") });
    await handler(request({ type: "start", playId, sceneId, actorRoleId: roleId }));
    await db.update(rehearsalSessions).set({ state: "stopped" })
      .where(eq(rehearsalSessions.id, rehearsalSessionId));

    const response = await handler(request({ type: "role_output", rehearsalSessionId, roleId: aiRoleIds[0]! }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Rehearsal session cannot issue another grant" });
    expect(roleProviderCalls).toBe(0);
  });

  it("discards a role-output secret when Stop wins during provider issuance", async () => {
    let roleProviderCalls = 0;
    const handler = createRealtimeSessionHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      credentials: { issue: async (input) => {
        if (input.purpose.type === "role_output") {
          roleProviderCalls += 1;
          await db.update(rehearsalSessions).set({ state: "stopped" })
            .where(eq(rehearsalSessions.id, rehearsalSessionId));
        }
        return { clientSecret: input.purpose.type === "actor_input" ? "ek_actor" : "discarded-role-secret",
          expiresAt: "2026-08-23T00:50:00.000Z", model: "gpt-realtime-2.1" };
      } }, createId: () => rehearsalSessionId, supportedVoices: ["cedar"],
      now: () => new Date("2026-08-23T00:40:00.000Z") });
    await handler(request({ type: "start", playId, sceneId, actorRoleId: roleId }));
    const originalExpiry = (await db.select().from(rehearsalSessions))[0]!.grantExpiresAt;

    const response = await handler(request({ type: "role_output", rehearsalSessionId, roleId: aiRoleIds[0]! }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Rehearsal session cannot issue another grant" });
    expect(roleProviderCalls).toBe(1);
    expect((await db.select().from(rehearsalSessions))[0]!.grantExpiresAt).toEqual(originalExpiry);
  });

  it("does not ask the provider for role output after reducer completion", async () => {
    let roleProviderCalls = 0;
    const handler = createRealtimeSessionHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      credentials: { issue: async (input) => {
        if (input.purpose.type === "role_output") roleProviderCalls += 1;
        return { clientSecret: "grant", expiresAt: "2026-08-23T00:50:00.000Z", model: "gpt-realtime-2.1" };
      } }, createId: () => rehearsalSessionId, supportedVoices: ["cedar"],
      now: () => new Date("2026-08-23T00:40:00.000Z") });
    await handler(request({ type: "start", playId, sceneId, actorRoleId: roleId }));
    await client.exec(`UPDATE rehearsal_sessions SET state = 'completed' WHERE id = '${rehearsalSessionId}'`);

    const response = await handler(request({ type: "role_output", rehearsalSessionId, roleId: aiRoleIds[0]! }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Rehearsal session cannot issue another grant" });
    expect(roleProviderCalls).toBe(0);
  });

  it("discards a role-output secret when reducer completion wins during provider issuance", async () => {
    const handler = createRealtimeSessionHandler({ authenticate: async () => ({ id: ownerUserId }), db,
      credentials: { issue: async (input) => {
        if (input.purpose.type === "role_output") {
          await client.exec(`UPDATE rehearsal_sessions SET state = 'completed' WHERE id = '${rehearsalSessionId}'`);
        }
        return { clientSecret: input.purpose.type === "actor_input" ? "ek_actor" : "discarded-role-secret",
          expiresAt: "2026-08-23T00:50:00.000Z", model: "gpt-realtime-2.1" };
      } }, createId: () => rehearsalSessionId, supportedVoices: ["cedar"],
      now: () => new Date("2026-08-23T00:40:00.000Z") });
    await handler(request({ type: "start", playId, sceneId, actorRoleId: roleId }));
    const originalExpiry = (await db.select().from(rehearsalSessions))[0]!.grantExpiresAt;

    const response = await handler(request({ type: "role_output", rehearsalSessionId, roleId: aiRoleIds[0]! }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Rehearsal session cannot issue another grant" });
    expect((await db.select().from(rehearsalSessions))[0]!.grantExpiresAt).toEqual(originalExpiry);
  });
});

function request(body: Record<string, unknown>) {
  return new Request("http://local/api/realtime/session", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function playModel() {
  return { id: "model:v1", title: "Private Play", language: "en" as const,
    characters: [{ id: roleId, name: "Alex", aliases: [] }, ...aiRoleIds.map((id, index) =>
      ({ id, name: `Partner ${index + 1}`, aliases: [] }))], acts: [{ id: "act", ordinal: 1,
      title: "Act I", scenes: [{ id: sceneId, ordinal: 1, title: "Scene", characterIds: [roleId, ...aiRoleIds],
        elements: [{ id: "line", ordinal: 1, kind: "dialogue" as const, characterId: roleId,
          text: "We begin.", sourcePage: 1 }, ...aiRoleIds.map((characterId, index) => ({
          id: `line-${index + 2}`, ordinal: index + 2, kind: "dialogue" as const, characterId,
          text: `Partner ${index + 1} speaks.`, sourcePage: 1 }))] }] }] };
}
