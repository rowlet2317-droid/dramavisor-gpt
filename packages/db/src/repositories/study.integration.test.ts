import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RoleWorkbook } from "@drama/domain/study";
import * as schema from "../schema";
import { actorNotes, analysisArtifacts, plays, users } from "../schema";
import { StudyRepository } from "./study";

const migrationNames = ["foundation", "play_processing_status", "reviewable_parse_jobs",
  "job_lease_fencing", "grounded_study", "current_artifact_uniqueness"];
const accountDeletionMigrationUrl = new URL("../../migrations/0019_account_deletion.sql", import.meta.url);
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const playId = "22222222-2222-4222-8222-222222222222";
const characterId = `${playId}:v1:character:1`;

describe("StudyRepository concurrent workbook replacement", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    for (const [index, name] of migrationNames.entries()) {
      await client.exec(await readFile(new URL(`../../migrations/000${index + 1}_${name}.sql`, import.meta.url), "utf8"));
    }
    await client.exec(await readFile(accountDeletionMigrationUrl, "utf8"));
    db = drizzle(client, { schema });
    await db.insert(users).values({ id: ownerUserId, email: "actor@example.com", passwordHash: "hash" });
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(actorNotes).values({ ownerUserId, playId, characterId,
      notes: { privateThoughts: "Keep this choice personal." } });
  });

  afterEach(async () => client.close());

  it("serializes concurrent replacements to one current workbook without touching actor notes", async () => {
    const repository = new StudyRepository(db);
    const provenance = { promptVersion: "role-v1", modelName: "test-model", playModelVersion: 1,
      generatedAt: new Date("2026-08-02T10:00:00.000Z") };

    await Promise.all([
      repository.replaceRoleWorkbook(ownerUserId, playId, workbook("first"), provenance),
      repository.replaceRoleWorkbook(ownerUserId, playId, workbook("second"), provenance),
    ]);

    const artifacts = await db.select().from(analysisArtifacts);
    expect(artifacts).toHaveLength(2);
    expect(artifacts.filter(({ status }) => status === "current")).toHaveLength(1);
    expect(artifacts.filter(({ status }) => status === "stale")).toHaveLength(1);
    expect(await db.select().from(actorNotes)).toEqual([expect.objectContaining({
      ownerUserId, playId, characterId, notes: { privateThoughts: "Keep this choice personal." },
    })]);
  });

  it("refuses workbook and actor-note writes for a deleting owner", async () => {
    await db.update(users).set({ accountStatus: "deleting" }).where(eq(users.id, ownerUserId));
    const repository = new StudyRepository(db);
    const provenance = { promptVersion: "role-v1", modelName: "test-model", playModelVersion: 1,
      generatedAt: new Date("2026-08-23T12:00:00.000Z") };

    await expect(repository.replaceRoleWorkbook(ownerUserId, playId, workbook("blocked"), provenance))
      .rejects.toThrow("ACCOUNT_NOT_ACTIVE");
    await expect(repository.saveActorNotes(ownerUserId, playId, characterId, { privateThoughts: "changed" }))
      .rejects.toThrow("ACCOUNT_NOT_ACTIVE");

    expect(await db.select().from(analysisArtifacts)).toEqual([]);
    expect(await db.select().from(actorNotes)).toEqual([expect.objectContaining({
      notes: { privateThoughts: "Keep this choice personal." },
    })]);
  });
});

function workbook(id: string): RoleWorkbook {
  return { id, characterId, directorConcept: null, circumstances: [], relationships: [],
    superObjectiveOptions: [], sceneObjectives: [], obstacles: [], stakes: [], tactics: [],
    entranceExitStates: [], beats: [], subtextOptions: [], referencedStageDirections: [] };
}
