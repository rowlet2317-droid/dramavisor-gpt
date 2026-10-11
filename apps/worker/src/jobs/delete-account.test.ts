import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthRepository } from "@drama/db/repositories/auth";
import * as schema from "@drama/db/schema";
import { accountDeletionAudits, accountDeletions, cueResponseEvidence, jobs, playModels, plays,
  practiceSessions, rehearsalEvents, rehearsalSessions, sourceFiles, takes, users } from "@drama/db/schema";
import type { ObjectStorage } from "@drama/storage/port";
import { runDeleteAccountJob } from "./delete-account";

const migrations = ["0001_foundation.sql", "0002_play_processing_status.sql", "0002_practice_sessions.sql",
  "0003_reviewable_parse_jobs.sql", "0004_job_lease_fencing.sql", "0005_grounded_study.sql",
  "0006_current_artifact_uniqueness.sql", "0007_take_transcripts.sql", "0008_ordered_transcript_evidence.sql",
  "0009_take_metrics.sql", "0010_normalized_audio_artifacts.sql", "0011_stale_attempt_cleanup.sql",
  "0012_cleanup_attempt_history.sql", "0013_immutable_normalized_audio_keys.sql",
  "0014_coaching_reports.sql", "0015_take_audio_retention.sql", "0016_global_job_lease_history.sql",
  "0017_rehearsal_sessions.sql", "0018_rehearsal_events.sql", "0019_account_deletion.sql",
  "0020_rehearsal_linked_coaching.sql"];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const playId = "22222222-2222-4222-8222-222222222222";
const deletionId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const leaseToken = "55555555-5555-4555-8555-555555555555";
const objectKey = `users/${ownerUserId}/plays/${playId}/source/original`;
const modelId = "66666666-6666-4666-8666-666666666666";
const practiceSessionId = "77777777-7777-4777-8777-777777777777";
const rehearsalSessionId = "88888888-8888-4888-8888-888888888888";
const takeId = "99999999-9999-4999-8999-999999999999";
const cueEventId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actorEventId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("delete account worker job", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let storage: ObjectStorage & { has(key: string): boolean; retainedVersionCount(key: string): number };

  beforeEach(async () => {
    client = new PGlite();
    for (const name of migrations) await client.exec(await readFile(new URL(
      `../../../../packages/db/migrations/${name}`, import.meta.url), "utf8"));
    db = drizzle(client, { schema });
    storage = inMemoryStorage();
    await db.insert(users).values({ id: ownerUserId, email: "actor@example.com", passwordHash: "hash",
      accountStatus: "deleting" });
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(sourceFiles).values({ ownerUserId, playId, filename: "source.pdf", objectKey });
    await db.insert(playModels).values({ id: modelId, ownerUserId, playId, version: 1, status: "approved",
      model: { id: "model", title: "Private Play", language: "en", characters: [], acts: [] }, issues: [] });
    await db.insert(practiceSessions).values({ id: practiceSessionId, ownerUserId, playId, playModelId: modelId,
      playModelVersion: 1, sceneId: "scene", roleId: "role", retentionChoice: "retain" });
    await db.insert(rehearsalSessions).values({ id: rehearsalSessionId, ownerUserId, playId,
      playModelId: modelId, playModelVersion: 1, sceneId: "scene", actorRoleId: "role", model: "realtime",
      grantExpiresAt: future(), state: "completed" });
    await db.insert(takes).values({ id: takeId, ownerUserId, practiceSessionId, rehearsalSessionId, playId,
      playModelId: modelId, playModelVersion: 1, sceneId: "scene", roleId: "role", retentionChoice: "retain",
      durationMs: 1_000, mediaType: "audio/wav", objectKey: `${objectKey}:take`, state: "completed" });
    await db.insert(rehearsalEvents).values([
      { id: cueEventId, ownerUserId, rehearsalSessionId, sequence: 1, type: "ai_speech_finished",
        event: { type: "ai_speech_finished", sequence: 1, characterId: "cue", elementId: "cue-line",
          endedAtMs: 100 } },
      { id: actorEventId, ownerUserId, rehearsalSessionId, sequence: 2, type: "manual_actor_line_completed",
        event: { type: "manual_actor_line_completed", sequence: 2, elementId: "actor-line", endedAtMs: 840 } },
    ]);
    await db.insert(cueResponseEvidence).values({ ownerUserId, takeId, rehearsalSessionId,
      measurementVersion: "cue-response-v1", cueEventId, actorEventId,
      clockId: `provider:${rehearsalSessionId}`, delayMs: 740, confidence: "high", score: 85 });
    await db.insert(accountDeletions).values({ id: deletionId, ownerUserId,
      objectInventory: { objectKeys: [objectKey], versionedObjects: [] } });
    await db.insert(jobs).values({ id: jobId, ownerUserId, kind: "delete_account", status: "running",
      payload: { deletionId }, attemptCount: 1, leaseToken, leaseExpiresAt: future() });
    await storage.putPrivate(objectKey, Uint8Array.from([1]), "application/pdf");
    await storage.putPrivate(objectKey, Uint8Array.from([2]), "application/pdf");
  });

  afterEach(async () => client.close());

  it("deletes every inventoried object before cascading account data and keeps only a nonidentifying audit", async () => {
    await expect(runDeleteAccountJob({ db, ownerUserId, jobId, leaseToken, attemptCount: 1, storage,
      now: new Date("2026-08-23T12:00:00Z") })).resolves.toBe("completed");

    expect(storage.has(objectKey)).toBe(false);
    expect(storage.retainedVersionCount(objectKey)).toBe(0);
    expect(await db.select().from(users)).toHaveLength(0);
    expect(await db.select().from(accountDeletions)).toHaveLength(0);
    expect(await db.select().from(jobs)).toHaveLength(0);
    expect(await db.select().from(accountDeletionAudits)).toEqual([expect.objectContaining({ deletionId,
      objectCount: 1, completedAt: new Date("2026-08-23T12:00:00Z") })]);
    await expect(runDeleteAccountJob({ db, ownerUserId, jobId, leaseToken, attemptCount: 1, storage,
      now: new Date("2026-08-23T12:00:00Z") })).resolves.toBe("already_completed");
  });

  it("refuses the database cascade when an object deletion fails", async () => {
    const failingStorage: ObjectStorage = { ...storage, purgePrivate: async () => {
      throw new Error("provider unavailable");
    } };

    await expect(runDeleteAccountJob({ db, ownerUserId, jobId, leaseToken, attemptCount: 1,
      storage: failingStorage, now: new Date("2026-08-23T12:00:00Z") })).rejects.toThrow("provider unavailable");
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(accountDeletions)).toHaveLength(1);
    expect(await db.select().from(accountDeletionAudits)).toHaveLength(0);
  });
});

function future() { return new Date("2026-08-24T12:00:00Z"); }

function inMemoryStorage(): ObjectStorage & { has(key: string): boolean; retainedVersionCount(key: string): number } {
  const objects = new Map<string, Uint8Array[]>();
  return {
    async putPrivate(key, bytes) { objects.set(key, [...(objects.get(key) ?? []), bytes]); },
    async putPrivateVersioned(key, bytes) { objects.set(key, [...(objects.get(key) ?? []), bytes]); return { versionToken: "version" }; },
    async getPrivate(key) {
      const value = objects.get(key)?.at(-1);
      if (!value) throw new Error("Private object not found");
      return value;
    },
    async deletePrivate(key) { objects.set(key, []); },
    async purgePrivate(key) { objects.delete(key); },
    async deletePrivateVersion(key) { return objects.delete(key); },
    has(key) { return (objects.get(key)?.length ?? 0) > 0; },
    retainedVersionCount(key) { return objects.get(key)?.length ?? 0; },
  };
}
