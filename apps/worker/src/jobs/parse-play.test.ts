import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakePlayParser } from "@drama/ai/play-parser/fake-parser";
import { ModelSchemaFailure } from "@drama/ai/play-parser/openai-parser";
import type { ParseProposal } from "@drama/domain/parse-review";
import * as schema from "@drama/db/schema";
import { jobs, playModels, plays, users } from "@drama/db/schema";
import type { ExtractedScript } from "@drama/media/scripts/extract";

import { runParseJob } from "./parse-play";

const migrationUrls = [
  new URL("../../../../packages/db/migrations/0001_foundation.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0002_play_processing_status.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0003_reviewable_parse_jobs.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0004_job_lease_fencing.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0019_account_deletion.sql", import.meta.url),
];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const playId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const leaseToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const extracted: ExtractedScript = {
  titleHint: "The First Step",
  pages: [
    { page: 1, text: "ACT I\nSCENE 1\nALEX: We begin.", extraction: "native" },
  ],
  warnings: [],
};

function providerProposal(overrides: Partial<ParseProposal["playModel"]> = {}): ParseProposal {
  return {
    playModel: {
      id: "provider-play-id",
      title: "The First Step",
      language: "en",
      characters: [{ id: "provider-alex", name: "Alex", aliases: [] }],
      acts: [{
        id: "provider-act-id",
        ordinal: 1,
        title: "Act I",
        scenes: [{
          id: "provider-scene-id",
          ordinal: 1,
          title: "Scene 1",
          characterIds: ["provider-alex"],
          elements: [
            { id: "provider-heading", ordinal: 1, kind: "heading", text: "ACT I", sourcePage: 1 },
            {
              id: "provider-dialogue",
              ordinal: 2,
              kind: "dialogue",
              characterId: "provider-alex",
              text: "We begin.",
              sourcePage: 1,
            },
          ],
        }],
      }],
      ...overrides,
    },
    issues: [{
      id: "provider-issue",
      kind: "scene_boundary",
      elementIds: ["provider-heading"],
      message: "Confirm the scene boundary.",
    }],
  };
}

describe("runParseJob", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    for (const migrationUrl of migrationUrls) {
      await client.exec(await readFile(migrationUrl, "utf8"));
    }
    db = drizzle(client, { schema });
    await db.insert(users).values({ id: ownerUserId, email: "actor@example.com", passwordHash: "hash" });
    await db.insert(plays).values({ id: playId, ownerUserId, title: "The First Step" });
    await db.insert(jobs).values({
      id: jobId,
      ownerUserId,
      playId,
      kind: "parse_play",
      status: "running",
      dedupeKey: `parse_play:${playId}:source-1`,
      payload: { extracted },
      attemptCount: 1,
      leaseToken,
    });
  });

  afterEach(async () => {
    await client.close();
  });

  it("reuses the completed result when the same job is retried", async () => {
    const parser = new FakePlayParser([providerProposal()]);

    const first = await runParseJob({ db, ownerUserId, jobId, parser, leaseToken, attemptCount: 1 });
    const second = await runParseJob({ db, ownerUserId, jobId, parser, leaseToken, attemptCount: 1 });

    expect(second.playModelVersionId).toBe(first.playModelVersionId);
    expect(parser.calls).toBe(1);
    expect(await db.select().from(playModels)).toHaveLength(1);
  });

  it("replaces every provider ID with stable version-and-ordinal IDs", async () => {
    const parser = new FakePlayParser([providerProposal()]);

    const result = await runParseJob({ db, ownerUserId, jobId, parser, leaseToken, attemptCount: 1 });
    const [stored] = await db.select().from(playModels);

    expect(stored!.id).toBe(result.playModelVersionId);
    expect(stored!.model).toMatchObject({
      id: `${playId}:v1`,
      characters: [{ id: `${playId}:v1:character:1`, name: "Alex" }],
      acts: [{
        id: `${playId}:v1:act:1`,
        scenes: [{
          id: `${playId}:v1:act:1:scene:1`,
          characterIds: [`${playId}:v1:character:1`],
          elements: [
            { id: `${playId}:v1:element:1`, ordinal: 1 },
            { id: `${playId}:v1:element:2`, ordinal: 2, characterId: `${playId}:v1:character:1` },
          ],
        }],
      }],
    });
    expect(stored!.issues).toEqual([{
      id: `${playId}:v1:issue:1`,
      kind: "scene_boundary",
      elementIds: [`${playId}:v1:element:1`],
      message: "Confirm the scene boundary.",
    }]);
    expect(JSON.stringify({ model: stored!.model, issues: stored!.issues })).not.toContain("provider-");
  });

  it("rejects references to unknown characters without creating a version", async () => {
    const proposal = providerProposal();
    const dialogue = proposal.playModel.acts[0]!.scenes[0]!.elements[1]!;
    if (dialogue.kind === "dialogue") dialogue.characterId = "missing-character";
    const parser = new FakePlayParser([proposal]);

    await expect(runParseJob({ db, ownerUserId, jobId, parser, leaseToken, attemptCount: 1 })).rejects.toThrow("unknown character");

    expect(await db.select().from(playModels)).toEqual([]);
  });

  it("canonicalizes element ordinals when the provider restarts numbering in a later scene", async () => {
    const proposal = providerProposal();
    const firstScene = proposal.playModel.acts[0]!.scenes[0]!;
    proposal.playModel.acts[0]!.scenes.push({
      ...structuredClone(firstScene),
      id: "provider-scene-two",
      ordinal: 2,
      title: "Scene 2",
      elements: [
        { ...structuredClone(firstScene.elements[0]!), id: "provider-heading-two", ordinal: 1 },
        { ...structuredClone(firstScene.elements[1]!), id: "provider-dialogue-two", ordinal: 2 },
      ],
    });
    const parser = new FakePlayParser([proposal]);

    await expect(runParseJob({ db, ownerUserId, jobId, parser, leaseToken, attemptCount: 1 })).resolves.toBeDefined();

    const [stored] = await db.select().from(playModels);
    expect(stored!.model).toMatchObject({
      acts: [{
        scenes: [{}, {
          elements: [
            { ordinal: 3 },
            { ordinal: 4 },
          ],
        }],
      }],
    });
  });

  it("rejects dialogue without an owner without creating a version", async () => {
    const proposal = providerProposal() as unknown as ParseProposal;
    const dialogue = proposal.playModel.acts[0]!.scenes[0]!.elements[1]!;
    if (dialogue.kind === "dialogue") dialogue.characterId = "";
    const parser = new FakePlayParser([proposal]);

    await expect(runParseJob({ db, ownerUserId, jobId, parser, leaseToken, attemptCount: 1 })).rejects.toThrow("dialogue owner");

    expect(await db.select().from(playModels)).toEqual([]);
  });

  it("rejects duplicate act ordinals before canonical IDs collide", async () => {
    const proposal = providerProposal();
    proposal.playModel.acts.push({ ...structuredClone(proposal.playModel.acts[0]!), id: "provider-act-two" });

    await expect(runParseJob({
      db, ownerUserId, jobId, parser: new FakePlayParser([proposal]), leaseToken, attemptCount: 1,
    })).rejects.toThrow("duplicate act ordinal");
    expect(await db.select().from(playModels)).toEqual([]);
  });

  it("rejects duplicate scene ordinals within an act", async () => {
    const proposal = providerProposal();
    proposal.playModel.acts[0]!.scenes.push({
      ...structuredClone(proposal.playModel.acts[0]!.scenes[0]!),
      id: "provider-scene-two",
      elements: [],
    });

    await expect(runParseJob({
      db, ownerUserId, jobId, parser: new FakePlayParser([proposal]), leaseToken, attemptCount: 1,
    })).rejects.toThrow("duplicate scene ordinal");
    expect(await db.select().from(playModels)).toEqual([]);
  });

  it("rejects duplicate provider element IDs before remapping issue references", async () => {
    const proposal = providerProposal();
    proposal.playModel.acts[0]!.scenes[0]!.elements[1]!.id = "provider-heading";

    await expect(runParseJob({
      db, ownerUserId, jobId, parser: new FakePlayParser([proposal]), leaseToken, attemptCount: 1,
    })).rejects.toThrow("duplicate provider ID");
    expect(await db.select().from(playModels)).toEqual([]);
  });

  it("rejects non-English extracted text before calling the parser", async () => {
    const parser = new FakePlayParser([providerProposal()]);
    await db.update(jobs).set({
      payload: {
        extracted: {
          titleHint: "La escena",
          pages: [{
            page: 1,
            text: "Buenas noches a todos. Comenzamos esta escena con los personajes y continuamos hablando solamente en español durante toda la obra.",
            extraction: "native",
          }],
          warnings: [],
        },
      },
    });

    await expect(runParseJob({
      db, ownerUserId, jobId, parser, leaseToken, attemptCount: 1,
    })).rejects.toThrow("English scripts only");

    expect(parser.calls).toBe(0);
    expect((await db.select().from(jobs))[0]).toMatchObject({
      status: "action_required",
      errorCode: "NON_ENGLISH_SOURCE",
    });
  });

  it("does not read or create a model for a different owner", async () => {
    const parser = new FakePlayParser([providerProposal()]);

    await expect(runParseJob({
      db,
      ownerUserId: "44444444-4444-4444-8444-444444444444",
      jobId,
      parser,
      leaseToken,
      attemptCount: 1,
    })).rejects.toThrow("Parse job not found");

    expect(parser.calls).toBe(0);
    expect(await db.select().from(playModels)).toEqual([]);
  });

  it("sets action_required with MODEL_SCHEMA_FAILURE after structured repair fails", async () => {
    const parser = {
      parse: async () => {
        throw new ModelSchemaFailure("invalid twice");
      },
    };

    await expect(runParseJob({ db, ownerUserId, jobId, parser, leaseToken, attemptCount: 1 })).rejects.toThrow("invalid twice");

    const [failed] = await db.select().from(jobs);
    expect(failed).toMatchObject({
      id: jobId,
      ownerUserId,
      status: "action_required",
      errorCode: "MODEL_SCHEMA_FAILURE",
      leaseExpiresAt: null,
    });
  });

  it("does not persist or complete after a newer lease fences the worker", async () => {
    await client.query(
      "UPDATE jobs SET attempt_count = 2, lease_token = $1, lease_expires_at = $2 WHERE id = $3",
      [
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        new Date("2026-08-02T12:20:00.000Z"),
        jobId,
      ],
    );
    const parser = new FakePlayParser([providerProposal()]);

    await expect(runParseJob({
      db,
      ownerUserId,
      jobId,
      parser,
      leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      attemptCount: 1,
    })).rejects.toThrow("Stale job lease");

    expect(await db.select().from(playModels)).toEqual([]);
    const [stored] = await db.select().from(jobs);
    expect(stored).toMatchObject({ status: "running", attemptCount: 2, resultPlayModelVersionId: null });
  });
});
