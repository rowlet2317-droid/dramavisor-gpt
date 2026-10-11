import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { analysisArtifacts, jobs, playModels, plays, users } from "@drama/db/schema";
import type { ParseIssue } from "@drama/domain/parse-review";
import type { PlayModel } from "@drama/domain/play-model";

import { createReviewHandler } from "./handler";

const migrationUrls = [
  new URL("../../../../../../../packages/db/migrations/0001_foundation.sql", import.meta.url),
  new URL("../../../../../../../packages/db/migrations/0002_play_processing_status.sql", import.meta.url),
  new URL("../../../../../../../packages/db/migrations/0003_reviewable_parse_jobs.sql", import.meta.url),
  new URL("../../../../../../../packages/db/migrations/0004_job_lease_fencing.sql", import.meta.url),
  new URL("../../../../../../../packages/db/migrations/0005_grounded_study.sql", import.meta.url),
  new URL("../../../../../../../packages/db/migrations/0006_current_artifact_uniqueness.sql", import.meta.url),
  new URL("../../../../../../../packages/db/migrations/0019_account_deletion.sql", import.meta.url),
];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const otherOwnerUserId = "22222222-2222-4222-8222-222222222222";
const playId = "33333333-3333-4333-8333-333333333333";
const versionId = "44444444-4444-4444-8444-444444444444";
const analysisId = "55555555-5555-4555-8555-555555555555";
const issueId = `${playId}:v1:issue:1`;
const elementId = `${playId}:v1:element:1`;

const model: PlayModel = {
  id: `${playId}:v1`,
  title: "Private Play",
  language: "en",
  characters: [{ id: `${playId}:v1:character:1`, name: "Alex", aliases: [] }],
  acts: [{
    id: `${playId}:v1:act:1`,
    ordinal: 1,
    title: "Act I",
    scenes: [{
      id: `${playId}:v1:act:1:scene:1`,
      ordinal: 1,
      title: "Scene 1",
      characterIds: [`${playId}:v1:character:1`],
      elements: [{
        id: elementId,
        ordinal: 1,
        kind: "dialogue",
        characterId: `${playId}:v1:character:1`,
        text: "We begn.",
        sourcePage: 1,
      }],
    }],
  }],
};
const issues: ParseIssue[] = [{
  id: issueId,
  kind: "unreadable_text",
  elementIds: [elementId],
  message: "Confirm the unreadable word.",
}];

describe("PATCH /api/plays/:playId/review", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    for (const migrationUrl of migrationUrls) await client.exec(await readFile(migrationUrl, "utf8"));
    db = drizzle(client, { schema });
    await db.insert(users).values([
      { id: ownerUserId, email: "a@example.com", passwordHash: "hash" },
      { id: otherOwnerUserId, email: "b@example.com", passwordHash: "hash" },
    ]);
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play", status: "review" });
    await db.insert(playModels).values({
      id: versionId,
      ownerUserId,
      playId,
      version: 1,
      status: "review_required",
      model,
      issues,
      sourceJobDedupeKey: "parse:private-play",
    });
    await db.insert(analysisArtifacts).values({
      id: analysisId,
      ownerUserId,
      playId,
      kind: "prior-analysis",
      status: "current",
      content: { note: "old" },
    });
  });

  afterEach(async () => {
    await client.close();
  });

  it("writes corrected elements as a new version and marks prior analysis stale", async () => {
    const response = await handler(ownerUserId)(request({
      corrections: [{ kind: "unreadable_text", issueId, elementId, text: "We begin." }],
      approve: false,
    }), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: { version: 2, status: "review_required" } });
    const stored = await db.select().from(playModels);
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ version: 1, status: "superseded" });
    expect(stored[1]).toMatchObject({ version: 2, status: "review_required", issues: [] });
    expect(stored[1]!.model.id).toBe(`${playId}:v2`);
    expect(stored[1]!.model.acts[0]!.scenes[0]!.elements[0]).toMatchObject({
      id: `${playId}:v2:element:1`,
      text: "We begin.",
      characterId: `${playId}:v2:character:1`,
    });
    expect((await db.select().from(analysisArtifacts))[0]).toMatchObject({ status: "stale" });
    expect(await db.select().from(jobs)).toEqual([]);
  });

  it("approves an issue-free corrected version and enqueues generate_study once", async () => {
    const patch = request({
      corrections: [{ kind: "unreadable_text", issueId, elementId, text: "We begin." }],
      approve: true,
    });
    const response = await handler(ownerUserId)(patch, context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: { version: 2, status: "approved" } });
    expect(await db.select().from(jobs)).toEqual([
      expect.objectContaining({
        ownerUserId,
        playId,
        kind: "generate_study",
        status: "queued",
        dedupeKey: `generate_study:${playId}:v2`,
        payload: { playModelVersion: 2 },
      }),
    ]);
  });

  it("returns the original approved result when the same approval is replayed", async () => {
    const body = { corrections: [{ kind: "unreadable_text", issueId, elementId, text: "We begin." }],
      approve: true };
    const first = await handler(ownerUserId)(request(body), context());
    const firstBody = await first.json();
    const replay = await handler(ownerUserId)(request(body), context());

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(await db.select().from(playModels)).toHaveLength(2);
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it("rejects a stale conflicting approval without creating a version or job", async () => {
    await handler(ownerUserId)(request({ corrections: [{ kind: "unreadable_text", issueId, elementId,
      text: "We begin." }], approve: true }), context());

    const stale = await handler(ownerUserId)(request({ corrections: [{ kind: "unreadable_text", issueId, elementId,
      text: "We commence." }], approve: true }), context());

    expect(stale.status).toBe(409);
    expect(await db.select().from(playModels)).toHaveLength(2);
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it("rejects a replayed downgrade after approval", async () => {
    const corrections = [{ kind: "unreadable_text", issueId, elementId, text: "We begin." }];
    await handler(ownerUserId)(request({ corrections, approve: true }), context());

    const downgrade = await handler(ownerUserId)(request({ corrections, approve: false }), context());

    expect(downgrade.status).toBe(409);
    expect(await db.select().from(playModels)).toHaveLength(2);
    expect((await db.select().from(playModels))[1]).toMatchObject({ status: "approved" });
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it("does not approve or enqueue while a blocking issue remains", async () => {
    const response = await handler(ownerUserId)(request({ corrections: [], approve: true }), context());

    expect(response.status).toBe(422);
    expect(await db.select().from(playModels)).toHaveLength(1);
    expect(await db.select().from(jobs)).toEqual([]);
  });

  it("rejects corrections that do not match an issue and source element", async () => {
    const response = await handler(ownerUserId)(request({
      corrections: [{ kind: "unreadable_text", issueId: "unknown", elementId, text: "Changed" }],
      approve: false,
    }), context());

    expect(response.status).toBe(422);
    expect(await db.select().from(playModels)).toHaveLength(1);
  });

  it("does not reveal or modify another owner's review", async () => {
    const response = await handler(otherOwnerUserId)(request({
      corrections: [{ kind: "unreadable_text", issueId, elementId, text: "Stolen" }],
      approve: true,
    }), context());

    expect(response.status).toBe(404);
    expect(await db.select().from(playModels)).toHaveLength(1);
    expect((await db.select().from(playModels))[0]!.model).toEqual(model);
    expect((await db.select().from(analysisArtifacts))[0]).toMatchObject({ status: "current" });
    expect(await db.select().from(jobs)).toEqual([]);
  });

  it("does not persist review changes after the owner starts account deletion", async () => {
    await db.update(users).set({ accountStatus: "deleting" }).where(eq(users.id, ownerUserId));

    const response = await handler(ownerUserId)(request({
      corrections: [{ kind: "unreadable_text", issueId, elementId, text: "We begin." }],
      approve: true,
    }), context());

    expect(response.status).toBe(404);
    expect(await db.select().from(playModels)).toEqual([expect.objectContaining({
      id: versionId, status: "review_required", model,
    })]);
    expect((await db.select().from(analysisArtifacts))[0]).toMatchObject({ status: "current" });
    expect(await db.select().from(jobs)).toEqual([]);
  });

  it("keeps a multi-element issue blocking until every referenced passage is corrected", async () => {
    const secondElementId = `${playId}:v1:element:2`;
    const multiModel = structuredClone(model);
    multiModel.acts[0]!.scenes[0]!.elements.push({
      id: secondElementId,
      ordinal: 2,
      kind: "stage_direction",
      text: "[An unreadable movement.]",
      sourcePage: 1,
    });
    await db.update(playModels).set({
      model: multiModel,
      issues: [{ ...issues[0]!, elementIds: [elementId, secondElementId] }],
    });

    const response = await handler(ownerUserId)(request({
      corrections: [{ kind: "unreadable_text", issueId, elementId, text: "We begin." }],
      approve: true,
    }), context());

    expect(response.status).toBe(422);
    expect(await db.select().from(playModels)).toHaveLength(1);
    expect(await db.select().from(jobs)).toEqual([]);
  });

  it("applies a dedicated character-name correction and resolves only named passages", async () => {
    await db.update(playModels).set({
      issues: [{ ...issues[0]!, kind: "character_name", message: "Confirm the character spelling." }],
    });

    const response = await handler(ownerUserId)(request({
      corrections: [{
        kind: "character_name",
        issueId,
        characterId: `${playId}:v1:character:1`,
        name: "Alexandra",
        elementIds: [elementId],
      }],
      approve: true,
    }), context());

    expect(response.status).toBe(200);
    const stored = await db.select().from(playModels);
    expect(stored[1]).toMatchObject({ status: "approved", issues: [] });
    expect(stored[1]!.model.characters[0]).toMatchObject({ name: "Alexandra" });
  });

  it("rejects a character rename unrelated to the issue's implicated dialogue", async () => {
    const unrelatedCharacterId = `${playId}:v1:character:2`;
    const twoCharacterModel = structuredClone(model);
    twoCharacterModel.characters.push({ id: unrelatedCharacterId, name: "Beth", aliases: [] });
    await db.update(playModels).set({
      model: twoCharacterModel,
      issues: [{ ...issues[0]!, kind: "character_name", message: "Confirm Alex's spelling." }],
    });

    const response = await handler(ownerUserId)(request({
      corrections: [{
        kind: "character_name",
        issueId,
        characterId: unrelatedCharacterId,
        name: "Bethany",
        elementIds: [elementId],
      }],
      approve: true,
    }), context());

    expect(response.status).toBe(422);
    expect(await db.select().from(playModels)).toHaveLength(1);
  });

  it("rejects a no-op scene-boundary confirmation", async () => {
    await db.update(playModels).set({
      issues: [{ ...issues[0]!, kind: "scene_boundary", message: "Confirm the scene boundary." }],
    });

    const response = await handler(ownerUserId)(request({
      corrections: [{ kind: "scene_boundary", issueId, elementId, confirmed: true }],
      approve: true,
    }), context());

    expect(response.status).toBe(422);
    expect(await db.select().from(playModels)).toHaveLength(1);
  });

  it("splits a scene at an implicated element and retains unresolved boundary references", async () => {
    const secondElementId = `${playId}:v1:element:2`;
    const thirdElementId = `${playId}:v1:element:3`;
    const structuralModel = structuredClone(model);
    structuralModel.acts[0]!.scenes[0]!.elements.push(
      { id: secondElementId, ordinal: 2, kind: "stage_direction", text: "[Blackout.]", sourcePage: 1 },
      { id: thirdElementId, ordinal: 3, kind: "heading", text: "A new place", sourcePage: 2 },
    );
    await db.update(playModels).set({
      model: structuralModel,
      issues: [{
        ...issues[0]!,
        kind: "scene_boundary",
        elementIds: [secondElementId, thirdElementId],
        message: "Resolve both possible scene boundaries.",
      }],
    });

    const response = await handler(ownerUserId)(request({
      corrections: [{
        kind: "scene_boundary",
        issueId,
        operation: "split_scene",
        sourceSceneId: `${playId}:v1:act:1:scene:1`,
        beforeElementId: secondElementId,
        newSceneTitle: "Scene 2",
      }],
      approve: false,
    }), context());

    expect(response.status).toBe(200);
    const stored = await db.select().from(playModels);
    expect(stored[1]).toMatchObject({
      version: 2,
      status: "review_required",
      issues: [{ kind: "scene_boundary", elementIds: [`${playId}:v2:element:3`] }],
    });
    expect(stored[1]!.model.acts[0]!.scenes).toMatchObject([
      { ordinal: 1, elements: [{ id: `${playId}:v2:element:1` }] },
      {
        ordinal: 2,
        title: "Scene 2",
        elements: [{ id: `${playId}:v2:element:2` }, { id: `${playId}:v2:element:3` }],
      },
    ]);
  });

  function handler(ownerId: string) {
    return createReviewHandler({ authenticate: async () => ({ id: ownerId }), db });
  }
});

function request(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/plays/${playId}/review`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedModelId: versionId, expectedModelVersion: 1, ...body }),
  });
}

function context() {
  return { params: Promise.resolve({ playId }) };
}
