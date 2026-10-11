import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { jobs, normalizedAudioArtifacts, takeStageJobChains, takeTranscripts } from "@drama/db/schema";

import { claimNextJob } from "./claim";

const migrations = ["0001_foundation.sql", "0002_play_processing_status.sql", "0002_practice_sessions.sql",
  "0003_reviewable_parse_jobs.sql", "0004_job_lease_fencing.sql", "0005_grounded_study.sql",
  "0006_current_artifact_uniqueness.sql", "0007_take_transcripts.sql", "0008_ordered_transcript_evidence.sql",
  "0009_take_metrics.sql", "0010_normalized_audio_artifacts.sql", "0011_stale_attempt_cleanup.sql",
  "0012_cleanup_attempt_history.sql", "0013_immutable_normalized_audio_keys.sql",
  "0015_take_audio_retention.sql", "0017_rehearsal_sessions.sql", "0018_rehearsal_events.sql",
  "0019_account_deletion.sql", "0020_rehearsal_linked_coaching.sql"];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const playId = "22222222-2222-4222-8222-222222222222";
const modelId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const takeId = "55555555-5555-4555-8555-555555555555";
const transcriptId = "66666666-6666-4666-8666-666666666666";
const measureJobId = "77777777-7777-4777-8777-777777777777";
const artifactId = "88888888-8888-4888-8888-888888888888";

describe("measure_take claiming", () => {
  let client: PGlite;

  afterEach(async () => client?.close());

  it("claims measurement only when its payload matches the exact current stage and artifact chain", async () => {
    // Break caught: a measurement job with no exact stage/artifact proof could process stale or unrelated audio.
    const db = await setup();

    const claimed = await claimNextJob({ db, ownerUserId, now: new Date("2026-08-12T12:00:00Z") });

    expect(claimed).toMatchObject({ id: measureJobId, kind: "measure_take", status: "running", attemptCount: 1 });
  });

  it("leaves a measurement job queued when its artifact proof is removed", async () => {
    // Break caught: dropping the artifact predicate makes a job claimable after its exact input has been invalidated.
    const db = await setup();
    await db.delete(normalizedAudioArtifacts).where(eq(normalizedAudioArtifacts.id, artifactId));

    await expect(claimNextJob({ db, ownerUserId, now: new Date("2026-08-12T12:00:00Z") })).resolves.toBeNull();
    const [stored] = await db.select().from(jobs).where(eq(jobs.id, measureJobId));
    expect(stored?.status).toBe("queued");
  });

  async function setup() {
    client = new PGlite();
    for (const name of migrations) {
      await client.exec(await readFile(new URL(`../../../../packages/db/migrations/${name}`, import.meta.url), "utf8"));
    }
    const db = drizzle(client, { schema });
    await db.insert(schema.users).values({ id: ownerUserId, email: "actor@example.com", passwordHash: "hash" });
    await db.insert(schema.plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(schema.playModels).values({ id: modelId, ownerUserId, playId, version: 1,
      status: "approved", issues: [], model: { id: "model", title: "Private Play", language: "en",
        characters: [], acts: [] } });
    await db.insert(schema.practiceSessions).values({ id: sessionId, ownerUserId, playId, playModelId: modelId,
      playModelVersion: 1, sceneId: "scene", roleId: "role", retentionChoice: "retain" });
    await db.insert(schema.takes).values({ id: takeId, ownerUserId, practiceSessionId: sessionId, playId,
      playModelId: modelId, playModelVersion: 1, sceneId: "scene", roleId: "role", retentionChoice: "retain",
      durationMs: 1_000, mediaType: "audio/wav", objectKey: "users/x/take.wav", state: "completed" });
    await db.insert(takeTranscripts).values({ id: transcriptId, ownerUserId, takeId, audioSha256: "a".repeat(64),
      transcriberVersion: "v1", provider: "fake", modelName: "fake", language: "en", text: "Line",
      timingSource: "whisper_word_timestamps", status: "current" });
    await db.insert(normalizedAudioArtifacts).values({ id: artifactId, ownerUserId, playId, takeId, transcriptId,
      transcriptStatus: "current", contentSha256: "b".repeat(64), storageVersionToken: "memory:1",
      canonicalObjectKey: `users/${ownerUserId}/plays/${playId}/takes/${takeId}/transcripts/${transcriptId}/normalized/attempt.wav` });
    await db.insert(jobs).values({ id: measureJobId, ownerUserId, playId, kind: "measure_take", status: "queued",
      dedupeKey: "measure_take:exact", availableAt: new Date("2026-08-12T11:59:00Z"),
      payload: { takeId, transcriptId, normalizedAudioArtifactId: artifactId } });
    await db.insert(takeStageJobChains).values({ jobId: measureJobId, ownerUserId, playId, takeId, transcriptId,
      transcriptStatus: "current", stageKind: "measure_take" });
    return db;
  }
});
