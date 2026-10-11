import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../schema";
import { jobs, practiceSessions, takeEvents, takes, takeStageJobChains, users, plays,
  playModels } from "../schema";
import { PracticeRepository } from "./practice";

const migrationNames = ["0001_foundation.sql", "0002_play_processing_status.sql",
  "0002_practice_sessions.sql", "0003_reviewable_parse_jobs.sql", "0004_job_lease_fencing.sql",
  "0005_grounded_study.sql", "0006_current_artifact_uniqueness.sql", "0007_take_transcripts.sql",
  "0008_ordered_transcript_evidence.sql", "0009_take_metrics.sql",
  "0010_normalized_audio_artifacts.sql", "0015_take_audio_retention.sql", "0017_rehearsal_sessions.sql",
  "0018_rehearsal_events.sql", "0019_account_deletion.sql", "0020_rehearsal_linked_coaching.sql"];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const playId = "22222222-2222-4222-8222-222222222222";
const modelId = "33333333-3333-4333-8333-333333333333";

describe("PracticeRepository", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    for (const name of migrationNames) {
      await client.exec(await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
    }
    db = drizzle(client, { schema });
    await db.insert(users).values({ id: ownerUserId, email: "actor@example.com", passwordHash: "hash" });
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(playModels).values({ id: modelId, ownerUserId, playId, version: 2,
      status: "approved", model: playModel(), issues: [] });
  });

  afterEach(async () => client.close());

  it("creates a complete queued take and processing job in one transaction", async () => {
    const repository = new PracticeRepository(db);

    const result = await repository.createQueuedTake({
      ownerUserId, playId, playModelId: modelId, playModelVersion: 2, sceneId: "scene-1", roleId: "role-1",
      selectedInterpretation: "Play the silence as a challenge", retentionChoice: "retain",
      durationMs: 1_250, mediaType: "audio/wav", objectKey: "private/take.wav",
    });

    expect(result.take).toMatchObject({ ownerUserId, playId, playModelId: modelId, playModelVersion: 2,
      sceneId: "scene-1", roleId: "role-1", selectedInterpretation: "Play the silence as a challenge",
      retentionChoice: "retain", durationMs: 1_250, mediaType: "audio/wav", state: "queued" });
    expect(await db.select().from(practiceSessions)).toHaveLength(1);
    expect(await db.select().from(takes)).toHaveLength(1);
    expect(await db.select().from(takeEvents)).toEqual([expect.objectContaining({
      ownerUserId, takeId: result.take.id, state: "queued",
    })]);
    expect(await db.select().from(jobs)).toEqual([expect.objectContaining({
      ownerUserId, playId, kind: "process_take", status: "queued",
      dedupeKey: `process_take:${result.take.id}`, payload: { takeId: result.take.id },
    })]);
    expect(await db.select().from(takeStageJobChains)).toEqual([expect.objectContaining({
      ownerUserId,
      playId,
      takeId: result.take.id,
      transcriptId: null,
      transcriptStatus: null,
      stageKind: "process_take",
    })]);
  });

  it("rolls back every practice row when the process_take job cannot be inserted", async () => {
    await client.exec("ALTER TABLE jobs ADD CONSTRAINT reject_process_take CHECK (kind <> 'process_take')");
    const repository = new PracticeRepository(db);

    await expect(repository.createQueuedTake({ ownerUserId, playId, playModelId: modelId,
      playModelVersion: 2, sceneId: "scene-1", roleId: "role-1", selectedInterpretation: null,
      retentionChoice: "delete_after_analysis", durationMs: 1_250, mediaType: "audio/webm",
      objectKey: "private/take.webm" })).rejects.toThrow();

    expect(await db.select().from(practiceSessions)).toEqual([]);
    expect(await db.select().from(takes)).toEqual([]);
    expect(await db.select().from(takeEvents)).toEqual([]);
    expect(await db.select().from(jobs)).toEqual([]);
    expect(await db.select().from(takeStageJobChains)).toEqual([]);
  });
});

function playModel() {
  return { id: "model", title: "Private Play", language: "en" as const,
    characters: [{ id: "role-1", name: "Alex", aliases: [] }],
    acts: [{ id: "act-1", ordinal: 1, title: "Act I", scenes: [{ id: "scene-1", ordinal: 1,
      title: "Scene One", characterIds: ["role-1"], elements: [] }] }] };
}
