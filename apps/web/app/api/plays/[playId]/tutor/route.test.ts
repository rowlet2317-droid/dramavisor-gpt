import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ContextualTutor, TutorRequest, TutorResponse } from "@drama/ai/tutor/port";
import * as schema from "@drama/db/schema";
import { analysisArtifacts, playModels, plays, users } from "@drama/db/schema";
import type { GroundedClaim, StudyArtifact } from "@drama/domain/study";

import { createTutorHandler, createTutorRoute } from "./handler";

const migrations = [...[1, 2, 3, 4, 5, 6].map((number) => new URL(
  `../../../../../../../packages/db/migrations/000${number}_${[
    "foundation", "play_processing_status", "reviewable_parse_jobs", "job_lease_fencing", "grounded_study",
    "current_artifact_uniqueness",
  ][number - 1]}.sql`, import.meta.url,
)), new URL("../../../../../../../packages/db/migrations/0019_account_deletion.sql", import.meta.url)];
const ownerId = "11111111-1111-4111-8111-111111111111";
const otherOwnerId = "22222222-2222-4222-8222-222222222222";
const playId = "33333333-3333-4333-8333-333333333333";
const characterId = `${playId}:v2:character:1`;
const sceneId = `${playId}:v2:act:1:scene:1`;
const otherSceneId = `${playId}:v2:act:1:scene:2`;
const elementId = `${playId}:v2:element:1`;
const model = {
  id: `${playId}:v2`, title: "Private Play", language: "en" as const,
  characters: [{ id: characterId, name: "Alex", aliases: [] }],
  acts: [{ id: `${playId}:v2:act:1`, ordinal: 1, title: "Act I", scenes: [
    { id: sceneId, ordinal: 1, title: "Scene 1", characterIds: [characterId], elements: [
      { id: elementId, ordinal: 1, kind: "dialogue" as const, characterId, text: "We begin.", sourcePage: 1 },
    ] },
    { id: otherSceneId, ordinal: 2, title: "Scene 2", characterIds: [characterId], elements: [
      { id: `${playId}:v2:element:2`, ordinal: 1, kind: "dialogue" as const,
        characterId, text: "We continue.", sourcePage: 2 },
    ] },
  ] }],
};

describe("POST /api/plays/:playId/tutor", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    for (const migration of migrations) await client.exec(await readFile(migration, "utf8"));
    db = drizzle(client, { schema });
    await db.insert(users).values([
      { id: ownerId, email: "owner@example.com", passwordHash: "hash" },
      { id: otherOwnerId, email: "other@example.com", passwordHash: "hash" },
    ]);
    await db.insert(plays).values({ id: playId, ownerUserId: ownerId, title: model.title, status: "study_ready" });
    await db.insert(playModels).values({ id: "44444444-4444-4444-8444-444444444444", ownerUserId: ownerId,
      playId, version: 2, status: "approved", model, issues: [] });
    await db.insert(analysisArtifacts).values([
      artifactRow("overview", artifact("overview", null)),
      artifactRow(`scene:${sceneId}`, artifact("scene", sceneId)),
      artifactRow(`scene:${otherSceneId}`, artifact("scene", otherSceneId)),
      artifactRow(`role_workbook:${characterId}`, workbook()),
    ]);
  });

  afterEach(async () => client.close());

  it("loads only approved, selected context and relevant current study artifacts", async () => {
    const claim = explicitClaim();
    const tutor = new RecordingTutor([{ answer: "Alex starts the exchange.", claims: [claim] }]);

    const response = await handler(ownerId, tutor)(request({
      question: "What is Alex doing here?",
      context: { sceneId, characterId, elementIds: [elementId] },
    }), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answer: "Alex starts the exchange.", claims: [claim] });
    expect(tutor.calls).toHaveLength(1);
    expect(tutor.calls[0]).toMatchObject({ question: "What is Alex doing here?", context: {
      scene: { id: sceneId }, character: { id: characterId }, elements: [{ id: elementId }],
    } });
    expect(tutor.calls[0]!.artifacts.map((artifactValue) => (
      "kind" in artifactValue ? artifactValue.kind : `role:${artifactValue.characterId}`
    )).sort()).toEqual(["overview", `role:${characterId}`, "scene"]);
    expect(tutor.calls[0]!.artifacts.find((value) => "kind" in value && value.kind === "scene"))
      .toMatchObject({ scopeId: sceneId });
  });

  it("rejects selected passage IDs that do not belong to the requested play", async () => {
    const tutor = new RecordingTutor([{ answer: "unused", claims: [] }]);

    const response = await handler(ownerId, tutor)(request({
      question: "What happens?", context: { elementIds: ["another-play:v1:element:1"] },
    }), context());

    expect(response.status).toBe(422);
    expect(tutor.calls).toEqual([]);
  });

  it("does not reveal another owner's play or approved model", async () => {
    const tutor = new RecordingTutor([{ answer: "unused", claims: [] }]);

    const response = await handler(otherOwnerId, tutor)(request({
      question: "What happens?", context: { elementIds: [elementId] },
    }), context());

    expect(response.status).toBe(404);
    expect(tutor.calls).toEqual([]);
  });

  it("does not load provider configuration before rejecting another owner's URL", async () => {
    let loads = 0;
    const post = createTutorRoute({ authenticate: async () => ({ id: otherOwnerId }), db }, () => {
      loads += 1;
      throw new Error("provider configuration must stay lazy");
    });

    const response = await post(request({ question: "What happens?", context: {} }), context());

    expect(response.status).toBe(404);
    expect(loads).toBe(0);
  });

  it("discards tutor output when account deletion wins during provider work", async () => {
    // Break caught: omitting the active-owner finalization returns private derived output after the deletion cutoff.
    let providerCalls = 0;
    const tutor: ContextualTutor = { answer: async () => {
      providerCalls += 1;
      await db.update(users).set({ accountStatus: "deleting" }).where(eq(users.id, ownerId));
      return { answer: "Private interpretation must be discarded.", claims: [explicitClaim()] };
    } };

    const response = await handler(ownerId, tutor)(request({
      question: "What happens?", context: { elementIds: [elementId] },
    }), context());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Play not found" });
    expect(providerCalls).toBe(1);
  });

  it("returns the exact insufficient-evidence response when no script reference supports the answer", async () => {
    const tutor = new RecordingTutor([{ answer: "Perhaps Alex is afraid.", claims: [{
      id: "interpretation", text: "Alex may be afraid.", epistemicStatus: "interpretation", reference: null,
    }] }]);

    const response = await handler(ownerId, tutor)(request({
      question: "Is Alex afraid?", context: { sceneId },
    }), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answer: "The script does not establish this", claims: [] });
  });

  it("rejects tutor claims that fail the generated-study grounding validator", async () => {
    const invalid: GroundedClaim = { ...explicitClaim(), reference: {
      playId, elementIds: ["unknown-element"],
    } };
    const tutor = new RecordingTutor([
      { answer: "Unsupported", claims: [invalid] },
      { answer: "Still unsupported", claims: [invalid] },
    ]);

    const response = await handler(ownerId, tutor)(request({ question: "What happens?", context: {} }), context());

    expect(response.status).toBe(502);
    expect(tutor.calls).toHaveLength(2);
    expect(tutor.calls[1]!.validationError).toBe("UNKNOWN_SCRIPT_REFERENCE");
  });

  function handler(userId: string, tutor: ContextualTutor) {
    return createTutorHandler({ authenticate: async () => ({ id: userId }), db, tutor });
  }
});

class RecordingTutor implements ContextualTutor {
  readonly calls: TutorRequest[] = [];
  private index = 0;

  constructor(private readonly responses: TutorResponse[]) {}

  async answer(requestValue: TutorRequest): Promise<TutorResponse> {
    this.calls.push(structuredClone(requestValue));
    const response = this.responses[Math.min(this.index, this.responses.length - 1)]!;
    this.index += 1;
    return structuredClone(response);
  }
}

function request(body: unknown) {
  return new Request(`http://localhost/api/plays/${playId}/tutor`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function context() {
  return { params: Promise.resolve({ playId }) };
}

function explicitClaim(): GroundedClaim {
  return { id: "claim-1", text: "Alex starts the exchange.", epistemicStatus: "explicit",
    reference: { playId, elementIds: [elementId] } };
}

function artifact(kind: StudyArtifact["kind"], scopeId: string | null): StudyArtifact {
  return { id: `artifact-${kind}-${scopeId ?? "play"}`, kind, scopeId, claims: [explicitClaim()] };
}

function workbook() {
  const claims = [explicitClaim()];
  return { id: "role-workbook", characterId, directorConcept: null, circumstances: claims,
    relationships: claims, superObjectiveOptions: claims, sceneObjectives: claims, obstacles: claims,
    stakes: claims, tactics: claims, entranceExitStates: claims, beats: claims, subtextOptions: claims,
    referencedStageDirections: [] };
}

function artifactRow(kind: string, content: StudyArtifact | ReturnType<typeof workbook>) {
  return { ownerUserId: ownerId, playId, kind, content, status: "current", promptVersion: "study-v1",
    modelName: "test-model", playModelVersion: 2, generatedAt: new Date("2026-08-02T12:00:00Z") };
}
