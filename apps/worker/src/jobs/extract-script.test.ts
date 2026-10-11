import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { jobs, plays, sourceFiles, users } from "@drama/db/schema";
import { ScriptExtractor } from "@drama/media/scripts/extract";

import { runExtractScriptJob } from "./extract-script";

const migrationUrls = [
  new URL("../../../../packages/db/migrations/0001_foundation.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0002_play_processing_status.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0003_reviewable_parse_jobs.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0004_job_lease_fencing.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0019_account_deletion.sql", import.meta.url),
];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const otherOwnerUserId = "22222222-2222-4222-8222-222222222222";
const playId = "33333333-3333-4333-8333-333333333333";
const sourceFileId = "44444444-4444-4444-8444-444444444444";
const jobId = "55555555-5555-4555-8555-555555555555";
const leaseToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("runExtractScriptJob", () => {
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
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(sourceFiles).values({
      id: sourceFileId,
      ownerUserId,
      playId,
      filename: "pasted-text.txt",
      sourceText: "PRIVATE PLAY\nALEX: We begin.",
    });
    await db.insert(jobs).values({
      id: jobId,
      ownerUserId,
      playId,
      kind: "extract_script",
      status: "running",
      attemptCount: 1,
      leaseToken,
      dedupeKey: `extract_script:${sourceFileId}`,
      payload: { sourceFileId },
    });
  });

  afterEach(async () => {
    await client.close();
  });

  it("extracts private source and idempotently enqueues one parse job", async () => {
    const first = await runExtractScriptJob({
      db, ownerUserId, jobId, extractor: new ScriptExtractor(), leaseToken, attemptCount: 1,
    });
    const second = await runExtractScriptJob({
      db, ownerUserId, jobId, extractor: new ScriptExtractor(), leaseToken, attemptCount: 1,
    });

    expect(second.parseJobId).toBe(first.parseJobId);
    const stored = await db.select().from(jobs);
    const extractJob = stored.find((job) => job.id === jobId);
    const parseJob = stored.find((job) => job.id === first.parseJobId);
    expect(stored).toHaveLength(2);
    expect(extractJob).toMatchObject({ id: jobId, status: "completed" });
    expect(parseJob).toMatchObject({
      id: first.parseJobId,
      ownerUserId,
      playId,
      kind: "parse_play",
      status: "queued",
      dedupeKey: `parse_play:${playId}:${sourceFileId}`,
    });
    expect(parseJob!.payload).toMatchObject({
      sourceFileId,
      extracted: { pages: [{ page: null, text: "PRIVATE PLAY\nALEX: We begin.", extraction: "native" }] },
    });
  });

  it("extracts a stored full-length TXT and removes publisher front matter", async () => {
    const bytes = await readFile(new URL("../../../../fixtures/plays/hamlet.txt", import.meta.url));
    await db.update(sourceFiles).set({ filename: "hamlet.txt", sourceText: null,
      objectKey: `users/${ownerUserId}/plays/${playId}/source/${sourceFileId}` });

    const result = await runExtractScriptJob({
      db, ownerUserId, jobId, extractor: new ScriptExtractor(), leaseToken, attemptCount: 1,
      loadPrivateObject: async () => bytes,
    });

    const [parseJob] = await db.select().from(jobs).where(eq(jobs.id, result.parseJobId));
    const extracted = parseJob!.payload.extracted as { titleHint: string; pages: Array<{ text: string }> };
    expect(extracted.titleHint).toBe("hamlet");
    expect(extracted.pages[0]!.text).toContain("Scene I. Elsinore.");
    expect(extracted.pages[0]!.text).not.toContain("Project Gutenberg EBook");
  });

  it("reports a safe source-load code instead of an opaque job failure", async () => {
    await db.update(sourceFiles).set({ sourceText: null, objectKey: "users/private/source" });

    await expect(runExtractScriptJob({
      db, ownerUserId, jobId, extractor: new ScriptExtractor(), leaseToken, attemptCount: 1,
      loadPrivateObject: async () => { throw new Error("private provider detail"); },
    })).rejects.toMatchObject({ code: "SOURCE_LOAD_FAILURE" });
  });

  it("reports a safe metadata code when the queued source no longer exists", async () => {
    await db.delete(sourceFiles).where(eq(sourceFiles.id, sourceFileId));

    await expect(runExtractScriptJob({
      db, ownerUserId, jobId, extractor: new ScriptExtractor(), leaseToken, attemptCount: 1,
    })).rejects.toMatchObject({ code: "SOURCE_METADATA_FAILURE" });
  });

  it("reports a safe extraction code for unreadable bytes", async () => {
    await db.update(sourceFiles).set({ filename: "broken.txt", sourceText: null,
      objectKey: "users/private/source" });

    await expect(runExtractScriptJob({
      db, ownerUserId, jobId, extractor: new ScriptExtractor(), leaseToken, attemptCount: 1,
      loadPrivateObject: async () => new Uint8Array([0xff, 0xfe]),
    })).rejects.toMatchObject({ code: "SCRIPT_EXTRACTION_FAILURE" });
  });

  it("does not extract another owner's source job", async () => {
    await expect(runExtractScriptJob({
      db,
      ownerUserId: otherOwnerUserId,
      jobId,
      extractor: new ScriptExtractor(),
      leaseToken,
      attemptCount: 1,
    })).rejects.toThrow("Extract job not found");

    expect(await db.select().from(jobs)).toHaveLength(1);
  });
});
