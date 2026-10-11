import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeStudyGenerator } from "@drama/ai/study/fake-study";
import * as schema from "@drama/db/schema";
import { actorNotes, analysisArtifacts, playModels, plays, users } from "@drama/db/schema";
import type { RoleWorkbook } from "@drama/domain/study";

import { createMyRoleHandler, createMyRoleRoute } from "./handler";

const migrationUrls = [...[1, 2, 3, 4, 5, 6].map((number) => new URL(
  `../../../../../../../packages/db/migrations/000${number}_${[
    "foundation", "play_processing_status", "reviewable_parse_jobs", "job_lease_fencing", "grounded_study",
    "current_artifact_uniqueness",
  ][number - 1]}.sql`, import.meta.url,
)), new URL("../../../../../../../packages/db/migrations/0019_account_deletion.sql", import.meta.url)];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const otherOwnerUserId = "22222222-2222-4222-8222-222222222222";
const playId = "33333333-3333-4333-8333-333333333333";
const characterId = `${playId}:v2:character:1`;
const elementId = `${playId}:v2:element:1`;
const stageDirectionId = `${playId}:v2:element:2`;
const generatedAt = new Date("2026-08-02T16:00:00.000Z");
const model = {
  id: `${playId}:v2`, title: "Private Play", language: "en" as const,
  characters: [{ id: characterId, name: "Alex", aliases: [] }],
  acts: [{ id: `${playId}:v2:act:1`, ordinal: 1, title: "Act I", scenes: [{
    id: `${playId}:v2:act:1:scene:1`, ordinal: 1, title: "Scene 1", characterIds: [characterId],
    elements: [{ id: elementId, ordinal: 1, kind: "dialogue" as const, characterId,
      text: "We begin.", sourcePage: 1 }, { id: stageDirectionId, ordinal: 2,
      kind: "stage_direction" as const, text: "[Alex crosses to the door.]", sourcePage: 1 }],
  }] }],
};

describe("POST /api/plays/:playId/my-role", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    for (const url of migrationUrls) await client.exec(await readFile(url, "utf8"));
    db = drizzle(client, { schema });
    await db.insert(users).values([
      { id: ownerUserId, email: "a@example.com", passwordHash: "hash" },
      { id: otherOwnerUserId, email: "b@example.com", passwordHash: "hash" },
    ]);
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play", status: "study_ready" });
    await db.insert(playModels).values({ id: "44444444-4444-4444-8444-444444444444", ownerUserId,
      playId, version: 2, status: "approved", model, issues: [] });
  });

  afterEach(async () => client.close());

  it("generates every workbook field for a member character with optional director concept", async () => {
    const generator = new FakeStudyGenerator({ roleResponses: [workbook("Find the light in the conflict")] });

    const response = await handler(ownerUserId, generator)(request({
      characterId, directorConcept: "Find the light in the conflict",
    }), context());

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.workbook).toMatchObject({ characterId, directorConcept: "Find the light in the conflict" });
    expect(Object.keys(body.workbook)).toEqual(expect.arrayContaining([
      "circumstances", "relationships", "superObjectiveOptions", "sceneObjectives", "obstacles", "stakes",
      "tactics", "entranceExitStates", "beats", "subtextOptions", "referencedStageDirections",
    ]));
    expect(generator.roleCalls[0]).toMatchObject({ characterId, directorConcept: "Find the light in the conflict" });
    expect((await db.select().from(analysisArtifacts))[0]).toMatchObject({ ownerUserId, playId,
      kind: `role_workbook:${characterId}`, promptVersion: "role-v1", modelName: "gpt-test",
      playModelVersion: 2, generatedAt, status: "current" });
  });

  it("rejects a character outside the approved Play Model before generation", async () => {
    const generator = new FakeStudyGenerator({ roleResponses: [workbook(null)] });

    const response = await handler(ownerUserId, generator)(request({ characterId: "missing-character" }), context());

    expect(response.status).toBe(422);
    expect(generator.roleCalls).toEqual([]);
    expect(await db.select().from(analysisArtifacts)).toEqual([]);
  });

  it("builds a grounded fallback workbook when the analysis provider is rate limited", async () => {
    const generator = {
      generateStudySection: async () => { throw new Error("not used"); },
      generateRoleWorkbook: async () => { throw new Error("Analysis request failed with 429"); },
    };

    const response = await createMyRoleHandler({ authenticate: async () => ({ id: ownerUserId }), db, generator,
      promptVersion: "role-v1", modelName: "gpt-test", now: () => generatedAt })(request({ characterId }), context());

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.workbook).toMatchObject({ characterId, directorConcept: null });
    expect(body.workbook.circumstances).toHaveLength(1);
    expect(body.workbook.circumstances[0].reference.elementIds).toEqual([elementId]);
    expect((await db.select().from(analysisArtifacts))[0]).toMatchObject({
      kind: `role_workbook:${characterId}`, status: "current",
    });
  });

  it("does not reveal another owner's approved model", async () => {
    const generator = new FakeStudyGenerator({ roleResponses: [workbook(null)] });

    const response = await handler(otherOwnerUserId, generator)(request({ characterId }), context());

    expect(response.status).toBe(404);
    expect(generator.roleCalls).toEqual([]);
  });

  it("does not call the study provider or persist after the owner starts account deletion", async () => {
    await db.update(users).set({ accountStatus: "deleting" }).where(eq(users.id, ownerUserId));
    const generator = new FakeStudyGenerator({ roleResponses: [workbook(null)] });

    const response = await handler(ownerUserId, generator)(request({ characterId }), context());

    expect(response.status).toBe(404);
    expect(generator.roleCalls).toEqual([]);
    expect(await db.select().from(analysisArtifacts)).toEqual([]);
  });

  it("discards provider output when account deletion starts during generation", async () => {
    let roleCalls = 0;
    const generator = {
      generateStudySection: async () => { throw new Error("not used"); },
      generateRoleWorkbook: async () => {
        roleCalls += 1;
        await db.update(users).set({ accountStatus: "deleting" }).where(eq(users.id, ownerUserId));
        return workbook(null);
      },
    };

    const response = await createMyRoleHandler({ authenticate: async () => ({ id: ownerUserId }), db, generator,
      promptVersion: "role-v1", modelName: "gpt-test", now: () => generatedAt })(
        request({ characterId }), context());

    expect(response.status).toBe(404);
    expect(roleCalls).toBe(1);
    expect(await db.select().from(analysisArtifacts)).toEqual([]);
  });

  it("does not load provider configuration before rejecting another owner's play", async () => {
    let providerLoaded = false;
    const post = createMyRoleRoute({ authenticate: async () => ({ id: otherOwnerUserId }), db }, () => {
      providerLoaded = true;
      throw new Error("provider configuration must stay lazy");
    });

    const response = await post(request({ characterId }), context());

    expect(response.status).toBe(404);
    expect(providerLoaded).toBe(false);
  });

  it("regenerates the workbook without overwriting separately stored actor notes", async () => {
    await db.insert(actorNotes).values({ ownerUserId, playId, characterId,
      notes: { privateThoughts: "Keep this choice personal." } });
    await db.insert(analysisArtifacts).values({ ownerUserId, playId, kind: `role_workbook:${characterId}`,
      content: workbook(null), status: "current", promptVersion: "role-old", modelName: "old-model",
      playModelVersion: 2, generatedAt: new Date("2026-08-01T00:00:00.000Z") });

    const response = await handler(ownerUserId, new FakeStudyGenerator({ roleResponses: [workbook(null)] }))(
      request({ characterId }), context(),
    );

    expect(response.status).toBe(201);
    expect(await db.select().from(actorNotes)).toEqual([expect.objectContaining({
      ownerUserId, playId, characterId, notes: { privateThoughts: "Keep this choice personal." },
    })]);
    const artifacts = await db.select().from(analysisArtifacts);
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((artifact) => artifact.status).sort()).toEqual(["current", "stale"]);
  });

  function handler(ownerId: string, generator: FakeStudyGenerator) {
    return createMyRoleHandler({ authenticate: async () => ({ id: ownerId }), db, generator,
      promptVersion: "role-v1", modelName: "gpt-test", now: () => generatedAt });
  }
});

function request(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/plays/${playId}/my-role`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
function context() { return { params: Promise.resolve({ playId }) }; }

function workbook(directorConcept: string | null): RoleWorkbook {
  const claim = (id: string) => ({ id, text: "Alex begins.", epistemicStatus: "explicit" as const,
    reference: { playId, elementIds: [elementId] } });
  return { id: "alex-workbook", characterId, directorConcept,
    circumstances: [claim("circumstance")], relationships: [claim("relationship")],
    superObjectiveOptions: [claim("super-objective")], sceneObjectives: [claim("scene-objective")],
    obstacles: [claim("obstacle")], stakes: [claim("stakes")], tactics: [claim("tactic")],
    entranceExitStates: [claim("state")], beats: [claim("beat")], subtextOptions: [claim("subtext")],
    referencedStageDirections: [{ ...claim("stage-direction"),
      reference: { playId, elementIds: [stageDirectionId] } }] };
}
