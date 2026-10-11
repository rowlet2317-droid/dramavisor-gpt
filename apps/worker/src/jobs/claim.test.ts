import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { jobs, plays, users } from "@drama/db/schema";

import { claimNextJob, failJob } from "./claim";

const migrationUrls = [
  new URL("../../../../packages/db/migrations/0001_foundation.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0002_play_processing_status.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0002_practice_sessions.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0003_reviewable_parse_jobs.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0004_job_lease_fencing.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0005_grounded_study.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0006_current_artifact_uniqueness.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0007_take_transcripts.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0008_ordered_transcript_evidence.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0009_take_metrics.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0010_normalized_audio_artifacts.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0011_stale_attempt_cleanup.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0012_cleanup_attempt_history.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0013_immutable_normalized_audio_keys.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0015_take_audio_retention.sql", import.meta.url),
  new URL("../../../../packages/db/migrations/0019_account_deletion.sql", import.meta.url),
];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const otherOwnerUserId = "22222222-2222-4222-8222-222222222222";
const playId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-08-02T12:00:00.000Z");

describe("restartable job claiming", () => {
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
  });

  afterEach(async () => {
    await client.close();
  });

  it("claims one owner-scoped queued job with a ten-minute lease", async () => {
    const [queued] = await db.insert(jobs).values({
      ownerUserId,
      playId,
      kind: "parse_play",
      dedupeKey: "parse:one",
      availableAt: now,
      payload: {},
    }).returning();
    await db.insert(jobs).values({
      ownerUserId: otherOwnerUserId,
      kind: "cleanup",
      dedupeKey: "other:one",
      availableAt: now,
      payload: {},
    });

    const claimed = await claimNextJob({ db, ownerUserId, now });

    expect(claimed).toMatchObject({ id: queued!.id, status: "running", attemptCount: 1 });
    expect(claimed!.leaseExpiresAt).toEqual(new Date("2026-08-02T12:10:00.000Z"));
    expect(claimed!.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reclaims an expired lease but leaves an active lease alone", async () => {
    const [expired] = await db.insert(jobs).values({
      ownerUserId,
      playId,
      kind: "parse_play",
      status: "running",
      attemptCount: 1,
      dedupeKey: "parse:expired",
      availableAt: now,
      leaseExpiresAt: new Date("2026-08-02T11:59:59.000Z"),
      payload: {},
    }).returning();
    await db.insert(jobs).values({
      ownerUserId,
      playId,
      kind: "parse_play",
      status: "running",
      attemptCount: 1,
      dedupeKey: "parse:active",
      availableAt: now,
      leaseExpiresAt: new Date("2026-08-02T12:00:01.000Z"),
      payload: {},
    });

    const claimed = await claimNextJob({ db, ownerUserId, now });
    const noSecondClaim = await claimNextJob({ db, ownerUserId, now });

    expect(claimed).toMatchObject({ id: expired!.id, attemptCount: 2 });
    expect(noSecondClaim).toBeNull();
  });

  it("makes dedupe keys unique", async () => {
    await db.insert(jobs).values({ ownerUserId, kind: "parse_play", dedupeKey: "same", payload: {} });

    await expect(db.insert(jobs).values({
      ownerUserId: otherOwnerUserId,
      kind: "parse_play",
      dedupeKey: "same",
      payload: {},
    })).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("terminalizes an expired third lease without reclaiming it", async () => {
    const [exhausted] = await db.insert(jobs).values({
      ownerUserId,
      playId,
      kind: "parse_play",
      status: "running",
      attemptCount: 3,
      dedupeKey: "parse:crashed-third",
      availableAt: now,
      leaseExpiresAt: new Date("2026-08-02T11:59:59.000Z"),
      payload: {},
    }).returning();

    const claimed = await claimNextJob({ db, ownerUserId, now });
    const [stored] = await db.select().from(jobs);

    expect(claimed).toBeNull();
    expect(stored).toMatchObject({
      id: exhausted!.id,
      status: "action_required",
      errorCode: "LEASE_EXPIRED",
      leaseExpiresAt: null,
    });
  });

  it("does not claim unsupported downstream job kinds", async () => {
    await db.insert(jobs).values({
      ownerUserId,
      playId,
      kind: "generate_tutor_session",
      dedupeKey: "tutor:one",
      availableAt: now,
      payload: {},
    });

    await expect(claimNextJob({ db, ownerUserId, now })).resolves.toBeNull();
    expect((await db.select().from(jobs))[0]).toMatchObject({ status: "queued", attemptCount: 0 });
  });

  it("fences all non-deletion work once an account is deleting", async () => {
    await db.update(users).set({ accountStatus: "deleting" }).where(eq(users.id, ownerUserId));
    await db.insert(jobs).values({ ownerUserId, playId, kind: "parse_play", dedupeKey: "parse:deleting",
      availableAt: now, payload: {} });
    const [deletion] = await db.insert(jobs).values({ ownerUserId, kind: "delete_account",
      dedupeKey: "delete:deleting", availableAt: now, payload: {} }).returning();

    const claimed = await claimNextJob({ db, ownerUserId, now });

    expect(claimed).toMatchObject({ id: deletion!.id, kind: "delete_account" });
    expect((await db.select().from(jobs)).find(({ kind }) => kind === "parse_play"))
      .toMatchObject({ status: "queued", attemptCount: 0 });
  });

  it("rejects failure from a stale lease after the job is reclaimed", async () => {
    const [job] = await db.insert(jobs).values({
      ownerUserId,
      playId,
      kind: "parse_play",
      status: "running",
      attemptCount: 2,
      leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      dedupeKey: "parse:fenced",
      leaseExpiresAt: new Date("2026-08-02T12:10:00.000Z"),
      payload: {},
    }).returning();
    await client.query("UPDATE jobs SET lease_token = $1 WHERE id = $2", [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      job!.id,
    ]);

    await expect(failJob({
      db,
      ownerUserId,
      jobId: job!.id,
      leaseToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      attemptCount: 1,
      code: "STALE_FAILURE",
      now,
    })).rejects.toThrow("Stale job lease");

    const [stored] = await db.select().from(jobs);
    expect(stored).toMatchObject({ status: "running", attemptCount: 2, errorCode: null });
  });

  it("requeues failures before attempt three and requires action on attempt three", async () => {
    const [retryable] = await db.insert(jobs).values({
      ownerUserId,
      playId,
      kind: "parse_play",
      status: "running",
      attemptCount: 2,
      leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      dedupeKey: "parse:retryable",
      payload: {},
    }).returning();
    const [exhausted] = await db.insert(jobs).values({
      ownerUserId,
      playId,
      kind: "parse_play",
      status: "running",
      attemptCount: 3,
      leaseToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      dedupeKey: "parse:exhausted",
      payload: {},
    }).returning();

    const retryResult = await failJob({
      db, ownerUserId, jobId: retryable!.id, leaseToken: retryable!.leaseToken!, attemptCount: 2, code: "TEMPORARY", now,
    });
    const exhaustedResult = await failJob({
      db, ownerUserId, jobId: exhausted!.id, leaseToken: exhausted!.leaseToken!, attemptCount: 3, code: "TEMPORARY", now,
    });

    expect(retryResult).toMatchObject({ status: "queued", errorCode: "TEMPORARY", leaseExpiresAt: null });
    expect(exhaustedResult).toMatchObject({ status: "action_required", errorCode: "TEMPORARY", leaseExpiresAt: null });
  });

  it("does not fail another owner's job", async () => {
    const [job] = await db.insert(jobs).values({
      ownerUserId,
      playId,
      kind: "parse_play",
      status: "running",
      attemptCount: 3,
      leaseToken: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      dedupeKey: "parse:private",
      payload: {},
    }).returning();

    await expect(failJob({
      db,
      ownerUserId: otherOwnerUserId,
      jobId: job!.id,
      leaseToken: job!.leaseToken!,
      attemptCount: 3,
      code: "TEMPORARY",
      now,
    })).rejects.toThrow("Stale job lease");
  });
});
