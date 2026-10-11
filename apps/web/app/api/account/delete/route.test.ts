import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthRepository } from "@drama/db/repositories/auth";
import * as schema from "@drama/db/schema";
import { accountDeletions, characterVoiceAssignments, jobs, normalizedAudioArtifacts, playModels, plays,
  privateObjectCleanupTasks, rehearsalSessions, sessions, sourceFiles, takeStageJobChains, takes, users } from "@drama/db/schema";
import { hashPassword } from "../../../../lib/auth/password";
import { createDeleteAccountHandler } from "./handler";

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
const modelId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const rehearsalId = "55555555-5555-4555-8555-555555555555";
const takeId = "66666666-6666-4666-8666-666666666666";
const cleanupJobId = "99999999-9999-4999-8999-999999999999";
const cleanupLeaseToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("DELETE /api/account/delete", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let auth: AuthRepository<any>;

  beforeEach(async () => {
    client = new PGlite();
    for (const name of migrations) await client.exec(await readFile(new URL(
      `../../../../../../packages/db/migrations/${name}`, import.meta.url), "utf8"));
    db = drizzle(client, { schema });
    auth = new AuthRepository(db);
    await db.insert(users).values({ id: ownerUserId, email: "actor@example.com",
      passwordHash: await hashPassword("correct horse battery staple") });
    await db.insert(sessions).values({ id: sessionId, ownerUserId, tokenHash: "active", expiresAt: future() });
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(playModels).values({ id: modelId, ownerUserId, playId, version: 1, status: "approved",
      model: playModel(), issues: [] });
    await db.insert(sourceFiles).values({ ownerUserId, playId, filename: "source.pdf",
      objectKey: `users/${ownerUserId}/plays/${playId}/source/original` });
    await db.insert(rehearsalSessions).values({ id: rehearsalId, ownerUserId, playId, playModelId: modelId,
      playModelVersion: 1, sceneId: "scene", actorRoleId: "alex", model: "gpt-realtime-2.1",
      grantExpiresAt: future() });
    await db.insert(characterVoiceAssignments).values({ ownerUserId, rehearsalSessionId: rehearsalId,
      characterId: "alex", voice: "alloy", engine: "realtime" });
    await db.insert(takes).values({ id: takeId, ownerUserId, practiceSessionId: await practiceSession(), playId,
      playModelId: modelId, playModelVersion: 1, sceneId: "scene", roleId: "alex", retentionChoice: "retain",
      durationMs: 1_000, mediaType: "audio/wav", objectKey: `users/${ownerUserId}/plays/${playId}/takes/${takeId}`,
      state: "completed" });
    const transcriptId = await transcript();
    await db.insert(normalizedAudioArtifacts).values({ ownerUserId, playId, takeId,
      transcriptId, canonicalObjectKey: `users/${ownerUserId}/plays/${playId}/takes/${takeId}`
        + `/transcripts/88888888-8888-4888-8888-888888888888/normalized.wav`,
      contentSha256: "a".repeat(64), storageVersionToken: "version-1" });
    await db.insert(jobs).values({ id: cleanupJobId, ownerUserId, playId, kind: "process_take", status: "running",
      payload: { takeId }, attemptCount: 1, leaseToken: cleanupLeaseToken, leaseExpiresAt: future() });
    await db.insert(takeStageJobChains).values({ jobId: cleanupJobId, ownerUserId, playId, takeId,
      stageKind: "process_take" });
    await db.insert(privateObjectCleanupTasks).values({ ownerUserId, playId, takeId, transcriptId,
      transcriptStatus: "attempted", sourceJobId: cleanupJobId, sourceAttemptCount: 1, sourceLeaseToken: cleanupLeaseToken,
      objectKey: `users/${ownerUserId}/plays/${playId}/takes/${takeId}/transcripts/${transcriptId}/normalized.wav.staging`,
      storageVersionToken: "cleanup-version", failureCode: "DB_PUBLICATION_FAILED", status: "action_required" });
    await db.insert(jobs).values([
      { ownerUserId, playId, kind: "delete_private_object", status: "action_required",
        dedupeKey: "delete_private_object:durable", payload: {
          objectKey: `users/${ownerUserId}/plays/${playId}/takes/durable-upload.wav`,
          reason: "take_upload_compensation",
        } },
      { ownerUserId, playId, kind: "purge_play_audio", status: "action_required",
        dedupeKey: "purge_play_audio:durable", payload: { playId,
          originalObjectKeys: [`users/${ownerUserId}/plays/${playId}/source/deleted-source`],
          normalizedObjects: [{ objectKey: `users/${ownerUserId}/plays/${playId}/takes/deleted/normalized.wav`,
            storageVersionToken: "deleted-version" }],
        } },
    ]);
  });

  afterEach(async () => client.close());

  it("requires password reauthentication, then revokes sessions/grants and persists the object inventory", async () => {
    const response = await handler()(request("correct horse battery staple"));

    expect(response.status).toBe(202);
    expect((await db.select().from(users))[0]).toMatchObject({ accountStatus: "deleting" });
    expect((await db.select().from(sessions))[0]!.revokedAt).toEqual(new Date("2026-08-23T12:00:00Z"));
    expect((await db.select().from(rehearsalSessions))[0]).toMatchObject({ state: "stopped",
      grantExpiresAt: new Date("2026-08-23T12:00:00Z") });
    expect((await db.select().from(jobs)).find(({ kind }) => kind === "delete_account"))
      .toMatchObject({ kind: "delete_account", status: "queued" });
    expect((await db.select().from(accountDeletions))[0]!.objectInventory).toEqual({
      objectKeys: [
        `users/${ownerUserId}/plays/${playId}/source/deleted-source`,
        `users/${ownerUserId}/plays/${playId}/source/original`,
        `users/${ownerUserId}/plays/${playId}/takes/${takeId}`,
        `users/${ownerUserId}/plays/${playId}/takes/durable-upload.wav`,
      ],
      versionedObjects: [{ objectKey: `users/${ownerUserId}/plays/${playId}/takes/${takeId}`
        + `/transcripts/88888888-8888-4888-8888-888888888888/normalized.wav`, versionToken: "version-1" },
      { objectKey: `users/${ownerUserId}/plays/${playId}/takes/${takeId}`
        + `/transcripts/88888888-8888-4888-8888-888888888888/normalized.wav.staging`, versionToken: "cleanup-version" },
      { objectKey: `users/${ownerUserId}/plays/${playId}/takes/deleted/normalized.wav`, versionToken: "deleted-version" }],
    });
  });

  it("does not change account state when password reauthentication fails", async () => {
    expect((await handler()(request("wrong password"))).status).toBe(401);
    expect((await db.select().from(users))[0]!.accountStatus).toBe("active");
    expect(await db.select().from(accountDeletions)).toHaveLength(0);
  });

  it("returns the same queued response without duplicating deletion work", async () => {
    expect((await handler()(request("correct horse battery staple"))).status).toBe(202);
    expect((await handler()(request("correct horse battery staple"))).status).toBe(202);
    expect(await db.select().from(accountDeletions)).toHaveLength(1);
    expect((await db.select().from(jobs)).filter(({ kind }) => kind === "delete_account")).toHaveLength(1);
  });

  it("retains unresolved cleanup identities until account deletion completes", async () => {
    await handler()(request("correct horse battery staple"));
    expect(await db.select().from(privateObjectCleanupTasks)).toHaveLength(1);

    const deletion = (await db.select().from(accountDeletions))[0]!;
    await expect(auth.completeAccountDeletion({ ownerUserId, deletionId: deletion.id,
      completedAt: new Date("2026-08-23T12:01:00Z") })).resolves.toBe("completed");

    expect(await db.select().from(privateObjectCleanupTasks)).toEqual([]);
  });

  it.each([
    { name: "missing", payload: { reason: "take_upload_compensation" } },
    { name: "outside the owner prefix", payload: {
      objectKey: "users/99999999-9999-4999-8999-999999999999/plays/private/take.wav",
      reason: "take_upload_compensation",
    } },
  ])("fails closed when a cleanup identity is $name", async ({ name, payload }) => {
    // Break caught: skipping an invalid cleanup payload lets account deletion cascade past an unknown private object.
    await db.insert(jobs).values({ ownerUserId, playId, kind: "delete_private_object",
      status: "action_required", dedupeKey: `invalid-cleanup:${name}`, payload });

    await expect(handler()(request("correct horse battery staple")))
      .rejects.toThrow("INVALID_PRIVATE_OBJECT_CLEANUP_IDENTITY");

    expect((await db.select().from(users).where(eq(users.id, ownerUserId)))[0]!.accountStatus).toBe("active");
    expect(await db.select().from(accountDeletions)).toEqual([]);
  });

  function handler() {
    return createDeleteAccountHandler({ authenticate: async () => ({ id: ownerUserId }), auth,
      now: () => new Date("2026-08-23T12:00:00Z") });
  }

  async function practiceSession() {
    const id = "77777777-7777-4777-8777-777777777777";
    await db.execute(`INSERT INTO practice_sessions (id, owner_user_id, play_id, play_model_id, play_model_version,
      scene_id, role_id, retention_choice) VALUES ('${id}', '${ownerUserId}', '${playId}', '${modelId}', 1,
      'scene', 'alex', 'retain')`);
    return id;
  }

  async function transcript() {
    const id = "88888888-8888-4888-8888-888888888888";
    await db.execute(`INSERT INTO take_transcripts (id, owner_user_id, take_id, audio_sha256, transcriber_version,
      provider, model_name, language, text, timing_source) VALUES ('${id}', '${ownerUserId}', '${takeId}',
      '${"b".repeat(64)}', 'test', 'fake', 'fake', 'en', 'private', 'whisper_word_timestamps')`);
    return id;
  }
});

function request(password: string) {
  return new Request("http://localhost/api/account/delete", { method: "DELETE",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
}

function future() { return new Date("2026-08-24T12:00:00Z"); }

function playModel() {
  return { id: "model", title: "Private Play", language: "en" as const,
    characters: [{ id: "alex", name: "Alex", aliases: [] }], acts: [{ id: "act", ordinal: 1,
      title: "Act I", scenes: [{ id: "scene", ordinal: 1, title: "Scene", characterIds: ["alex"],
        elements: [] }] }] };
}
