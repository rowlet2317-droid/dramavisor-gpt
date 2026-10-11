import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeStudyGenerator } from "@drama/ai/study/fake-study";
import * as schema from "@drama/db/schema";
import { analysisArtifacts, jobs, playModels, plays, users } from "@drama/db/schema";
import type { StudyArtifact, StudySectionKind } from "@drama/domain/study";

import { runGenerateStudyJob } from "./generate-study";

const migrationUrls = [...[1, 2, 3, 4, 5, 6].map((number) => new URL(
  `../../../../packages/db/migrations/000${number}_${[
    "foundation", "play_processing_status", "reviewable_parse_jobs", "job_lease_fencing", "grounded_study",
    "current_artifact_uniqueness",
  ][number - 1]}.sql`,
  import.meta.url,
)), new URL("../../../../packages/db/migrations/0019_account_deletion.sql", import.meta.url)];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const otherOwnerUserId = "22222222-2222-4222-8222-222222222222";
const playId = "33333333-3333-4333-8333-333333333333";
const modelRowId = "44444444-4444-4444-8444-444444444444";
const jobId = "55555555-5555-4555-8555-555555555555";
const leaseToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const generatedAt = new Date("2026-08-02T15:00:00.000Z");
const elementId = `${playId}:v2:element:1`;
const sceneId = `${playId}:v2:act:1:scene:1`;
const model = {
  id: `${playId}:v2`, title: "Private Play", language: "en" as const,
  characters: [{ id: `${playId}:v2:character:1`, name: "Alex", aliases: [] }],
  acts: [{ id: `${playId}:v2:act:1`, ordinal: 1, title: "Act I", scenes: [{
    id: sceneId, ordinal: 1, title: "Scene 1", characterIds: [`${playId}:v2:character:1`],
    elements: [{ id: elementId, ordinal: 1, kind: "dialogue" as const,
      characterId: `${playId}:v2:character:1`, text: "We begin.", sourcePage: 1 }],
  }] }],
};

describe("runGenerateStudyJob", () => {
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
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play", status: "study_queued" });
    await db.insert(playModels).values({ id: modelRowId, ownerUserId, playId, version: 2,
      status: "approved", model, issues: [] });
    await db.insert(jobs).values({ id: jobId, ownerUserId, playId, kind: "generate_study",
      status: "running", payload: { playModelVersion: 2 }, attemptCount: 1, leaseToken });
  });

  afterEach(async () => client.close());

  it("persists separately grounded whole-play and scene artifacts with provenance", async () => {
    const generator = validGenerator();

    const result = await runGenerateStudyJob({ db, ownerUserId, jobId, generator, leaseToken,
      attemptCount: 1, promptVersion: "study-v1", modelName: "gpt-test", generatedAt });

    expect(result).toEqual({ status: "completed", omittedSections: [] });
    const stored = await db.select().from(analysisArtifacts);
    expect(stored).toHaveLength(6);
    expect(stored.map((row) => row.kind).sort()).toEqual([
      "characters", "dramatic_structure", "overview", "relationships", `scene:${sceneId}`, "themes",
    ]);
    expect(stored).toEqual(expect.arrayContaining([expect.objectContaining({
      ownerUserId, playId, promptVersion: "study-v1", modelName: "gpt-test",
      playModelVersion: 2, generatedAt, status: "current",
    })]));
    expect(generator.studyCalls).toHaveLength(6);
    expect((await db.select().from(jobs))[0]).toMatchObject({ status: "completed", errorCode: null });
    expect((await db.select().from(plays))[0]).toMatchObject({ status: "study_ready" });
  });

  it("retries an invalid section twice then completes with limitations and omits it", async () => {
    await db.insert(analysisArtifacts).values({ ownerUserId, playId, kind: "themes", status: "current",
      content: validArtifact("themes"), promptVersion: "study-old", modelName: "old-model",
      playModelVersion: 1, generatedAt: new Date("2026-08-01T00:00:00.000Z") });
    const generator = validGenerator({
      themes: [invalidArtifact("themes"), invalidArtifact("themes")],
    });

    const result = await runGenerateStudyJob({ db, ownerUserId, jobId, generator, leaseToken,
      attemptCount: 1, promptVersion: "study-v1", modelName: "gpt-test", generatedAt });

    expect(result).toEqual({ status: "completed_with_limitations", omittedSections: ["themes"] });
    const stored = await db.select().from(analysisArtifacts);
    expect(stored.filter((row) => row.kind === "themes" && row.status === "current")).toEqual([]);
    expect(stored.find((row) => row.kind === "themes")).toMatchObject({ status: "stale" });
    const themeCalls = generator.studyCalls.filter((call) => call.kind === "themes");
    expect(themeCalls).toHaveLength(2);
    expect(themeCalls[1]?.validationError).toContain("UNKNOWN_SCRIPT_REFERENCE");
    expect((await db.select().from(jobs))[0]).toMatchObject({
      status: "completed_with_limitations", errorCode: "INVALID_STUDY_SECTION:themes",
    });
  });

  it("publishes grounded fallback sections when the analysis provider is unavailable", async () => {
    const generator = {
      generateStudySection: async () => { throw new Error("Analysis request failed with 429"); },
      generateRoleWorkbook: async () => { throw new Error("not used"); },
    };

    const result = await runGenerateStudyJob({ db, ownerUserId, jobId, generator, leaseToken,
      attemptCount: 1, promptVersion: "study-v1", modelName: "gpt-test", generatedAt });

    expect(result).toEqual({ status: "completed", omittedSections: [] });
    const stored = await db.select().from(analysisArtifacts);
    expect(stored).toHaveLength(6);
    expect(stored.every(({ content }) => (content as StudyArtifact).claims.length > 0)).toBe(true);
    expect((await db.select().from(jobs))[0]).toMatchObject({ status: "completed", errorCode: null });
  });

  it("does not read or write a different owner's job", async () => {
    const generator = validGenerator();

    await expect(runGenerateStudyJob({ db, ownerUserId: otherOwnerUserId, jobId, generator, leaseToken,
      attemptCount: 1, promptVersion: "study-v1", modelName: "gpt-test", generatedAt }))
      .rejects.toThrow("Study job not found");

    expect(generator.studyCalls).toEqual([]);
    expect(await db.select().from(analysisArtifacts)).toEqual([]);
  });

  it("does not persist after a newer lease fences the worker", async () => {
    await db.update(jobs).set({ attemptCount: 2, leaseToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });

    await expect(runGenerateStudyJob({ db, ownerUserId, jobId, generator: validGenerator(), leaseToken,
      attemptCount: 1, promptVersion: "study-v1", modelName: "gpt-test", generatedAt }))
      .rejects.toThrow("Stale job lease");

    expect(await db.select().from(analysisArtifacts)).toEqual([]);
    expect((await db.select().from(jobs))[0]).toMatchObject({ status: "running", attemptCount: 2 });
  });
});

function validGenerator(overrides: Record<string, StudyArtifact[]> = {}) {
  const kinds: StudySectionKind[] = ["overview", "themes", "dramatic_structure", "characters", "relationships"];
  const sectionResponses = Object.fromEntries(kinds.map((kind) => [kind, [validArtifact(kind)]]));
  sectionResponses[`scene:${sceneId}`] = [validArtifact("scene", sceneId)];
  return new FakeStudyGenerator({ sectionResponses: { ...sectionResponses, ...overrides } });
}

function validArtifact(kind: StudySectionKind, scopeId: string | null = null): StudyArtifact {
  return { id: `${kind}-artifact`, kind, scopeId, claims: [{ id: `${kind}-claim`, text: "Alex begins.",
    epistemicStatus: "explicit", reference: { playId, elementIds: [elementId] } }] };
}

function invalidArtifact(kind: StudySectionKind): StudyArtifact {
  return { ...validArtifact(kind), claims: [{ id: "invented", text: "Invented fact", epistemicStatus: "explicit",
    reference: { playId, elementIds: ["invented-element"] } }] };
}
