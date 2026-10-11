import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";

import type { ParseProposal } from "@drama/domain/parse-review";
import * as schema from "@drama/db/schema";
import { jobs, playModels, plays, users } from "@drama/db/schema";
import { ScriptExtractor } from "@drama/media/scripts/extract";

import { runWorkerOnce } from "./index";

const migrationUrls = [
  new URL("../../../packages/db/migrations/0001_foundation.sql", import.meta.url),
  new URL("../../../packages/db/migrations/0002_play_processing_status.sql", import.meta.url),
  new URL("../../../packages/db/migrations/0002_practice_sessions.sql", import.meta.url),
  new URL("../../../packages/db/migrations/0003_reviewable_parse_jobs.sql", import.meta.url),
  new URL("../../../packages/db/migrations/0004_job_lease_fencing.sql", import.meta.url),
  new URL("../../../packages/db/migrations/0005_grounded_study.sql", import.meta.url),
  new URL("../../../packages/db/migrations/0006_current_artifact_uniqueness.sql", import.meta.url),
  new URL("../../../packages/db/migrations/0007_take_transcripts.sql", import.meta.url),
  new URL("../../../packages/db/migrations/0008_ordered_transcript_evidence.sql", import.meta.url),
  new URL("../../../packages/db/migrations/0009_take_metrics.sql", import.meta.url),
  new URL("../../../packages/db/migrations/0010_normalized_audio_artifacts.sql", import.meta.url),
  new URL("../../../packages/db/migrations/0011_stale_attempt_cleanup.sql", import.meta.url),
  new URL("../../../packages/db/migrations/0012_cleanup_attempt_history.sql", import.meta.url),
  new URL("../../../packages/db/migrations/0013_immutable_normalized_audio_keys.sql", import.meta.url),
  new URL("../../../packages/db/migrations/0015_take_audio_retention.sql", import.meta.url),
  new URL("../../../packages/db/migrations/0019_account_deletion.sql", import.meta.url),
];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const playId = "22222222-2222-4222-8222-222222222222";

describe("worker lease fencing", () => {
  let client: PGlite;

  afterEach(async () => {
    await client.close();
  });

  it("ignores a stale completion after a newer worker reclaimed the job", async () => {
    client = new PGlite();
    for (const migrationUrl of migrationUrls) await client.exec(await readFile(migrationUrl, "utf8"));
    const db = drizzle(client, { schema });
    await db.insert(users).values({ id: ownerUserId, email: "actor@example.com", passwordHash: "hash" });
    await db.insert(plays).values({ id: playId, ownerUserId, title: "The First Step" });
    await db.insert(jobs).values({
      ownerUserId,
      playId,
      kind: "parse_play",
      dedupeKey: "parse:race",
      availableAt: new Date("2026-08-02T12:00:00.000Z"),
      payload: {
        extracted: {
          titleHint: "The First Step",
          pages: [{ page: 1, text: "ACT I\nALEX: We begin.", extraction: "native" }],
          warnings: [],
        },
      },
    });
    const proposal: ParseProposal = {
      playModel: {
        id: "play",
        title: "The First Step",
        language: "en",
        characters: [{ id: "alex", name: "Alex", aliases: [] }],
        acts: [{
          id: "act",
          ordinal: 1,
          title: "Act I",
          scenes: [{
            id: "scene",
            ordinal: 1,
            title: "Scene 1",
            characterIds: ["alex"],
            elements: [{
              id: "line",
              ordinal: 1,
              kind: "dialogue",
              characterId: "alex",
              text: "We begin.",
              sourcePage: 1,
            }],
          }],
        }],
      },
      issues: [],
    };

    await expect(runWorkerOnce({
      db,
      ownerUserId,
      extractor: new ScriptExtractor(),
      parser: {
        parse: async () => {
          await db.update(jobs).set({
            attemptCount: 2,
            leaseToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            leaseExpiresAt: new Date("2026-08-02T12:20:00.000Z"),
          });
          return proposal;
        },
      },
      now: new Date("2026-08-02T12:00:00.000Z"),
    })).resolves.toBe(true);

    expect(await db.select().from(playModels)).toEqual([]);
    expect((await db.select().from(jobs))[0]).toMatchObject({ status: "running", attemptCount: 2 });
  }, 10_000);

  it("continues after non-English input is terminalized", async () => {
    client = new PGlite();
    for (const migrationUrl of migrationUrls) await client.exec(await readFile(migrationUrl, "utf8"));
    const db = drizzle(client, { schema });
    await db.insert(users).values({ id: ownerUserId, email: "actor@example.com", passwordHash: "hash" });
    await db.insert(plays).values({ id: playId, ownerUserId, title: "La escena" });
    await db.insert(jobs).values({
      ownerUserId,
      playId,
      kind: "parse_play",
      dedupeKey: "parse:spanish",
      availableAt: new Date("2026-08-02T12:00:00.000Z"),
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

    await expect(runWorkerOnce({
      db,
      ownerUserId,
      extractor: new ScriptExtractor(),
      parser: { parse: async () => { throw new Error("parser must not run"); } },
      now: new Date("2026-08-02T12:00:00.000Z"),
    })).resolves.toBe(true);

    expect((await db.select().from(jobs))[0]).toMatchObject({
      status: "action_required",
      errorCode: "NON_ENGLISH_SOURCE",
    });
  });

  it("continues when a generic failure is fenced before failJob", async () => {
    client = new PGlite();
    for (const migrationUrl of migrationUrls) await client.exec(await readFile(migrationUrl, "utf8"));
    const db = drizzle(client, { schema });
    await db.insert(users).values({ id: ownerUserId, email: "actor@example.com", passwordHash: "hash" });
    await db.insert(plays).values({ id: playId, ownerUserId, title: "The First Step" });
    await db.insert(jobs).values({
      ownerUserId,
      playId,
      kind: "parse_play",
      dedupeKey: "parse:stale-failure",
      availableAt: new Date("2026-08-02T12:00:00.000Z"),
      payload: {
        extracted: {
          titleHint: "The First Step",
          pages: [{ page: 1, text: "ACT I\nALEX: We begin.", extraction: "native" }],
          warnings: [],
        },
      },
    });

    await expect(runWorkerOnce({
      db,
      ownerUserId,
      extractor: new ScriptExtractor(),
      parser: {
        parse: async () => {
          await db.update(jobs).set({
            attemptCount: 2,
            leaseToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          });
          throw new Error("temporary provider failure");
        },
      },
      now: new Date("2026-08-02T12:00:00.000Z"),
    })).resolves.toBe(true);

    expect((await db.select().from(jobs))[0]).toMatchObject({ status: "running", attemptCount: 2 });
  });
});
