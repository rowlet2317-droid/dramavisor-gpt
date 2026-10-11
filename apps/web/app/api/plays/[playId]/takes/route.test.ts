import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import type { PgliteQueryResultHKT } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@drama/db/schema";
import { AuthRepository } from "@drama/db/repositories/auth";
import { accountDeletions, jobs, playModels, plays, practiceSessions, rehearsalSessions, takeEvents, takes,
  takeStageJobChains, users } from "@drama/db/schema";
import type { ObjectStorage } from "@drama/storage/port";
import { createTakeUploadHandler } from "./handler";

const migrationNames = ["0001_foundation.sql", "0002_play_processing_status.sql",
  "0002_practice_sessions.sql", "0003_reviewable_parse_jobs.sql", "0004_job_lease_fencing.sql",
  "0005_grounded_study.sql", "0006_current_artifact_uniqueness.sql", "0007_take_transcripts.sql",
  "0008_ordered_transcript_evidence.sql", "0009_take_metrics.sql",
  "0010_normalized_audio_artifacts.sql", "0015_take_audio_retention.sql",
  "0017_rehearsal_sessions.sql", "0018_rehearsal_events.sql", "0019_account_deletion.sql",
  "0020_rehearsal_linked_coaching.sql"];
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const otherOwnerUserId = "22222222-2222-4222-8222-222222222222";
const playId = "33333333-3333-4333-8333-333333333333";
const modelId = "44444444-4444-4444-8444-444444444444";
const sceneId = "scene-1";
const roleId = "role-1";
const rehearsalSessionId = "55555555-5555-4555-8555-555555555555";

describe("POST /api/plays/:playId/takes", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let storage: RecordingStorage;

  beforeEach(async () => {
    client = new PGlite();
    for (const name of migrationNames) {
      await client.exec(await readFile(new URL(`../../../../../../../packages/db/migrations/${name}`, import.meta.url), "utf8"));
    }
    db = drizzle(client, { schema });
    storage = new RecordingStorage();
    await db.insert(users).values([
      { id: ownerUserId, email: "actor@example.com", passwordHash: "hash" },
      { id: otherOwnerUserId, email: "other@example.com", passwordHash: "hash" },
    ]);
    await db.insert(plays).values({ id: playId, ownerUserId, title: "Private Play" });
    await db.insert(playModels).values({ id: modelId, ownerUserId, playId, version: 2,
      status: "approved", model: playModel(), issues: [] });
    await db.insert(rehearsalSessions).values({ id: rehearsalSessionId, ownerUserId, playId,
      playModelId: modelId, playModelVersion: 2, sceneId, actorRoleId: roleId, model: "realtime",
      grantExpiresAt: new Date("2026-08-25T12:10:00.000Z"), state: "completed" });
  });

  afterEach(async () => client.close());

  it("derives WAV duration, stores audio privately, and queues a take without exposing its key", async () => {
    const response = await handler()(takeRequest(wav(2_000), {
      selectedInterpretation: "Play the silence as a challenge",
      retentionChoice: "retain",
      durationMs: "999999",
    }, "take.webm", "audio/webm"), context());

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toEqual({ take: { id: expect.any(String), state: "queued", durationMs: 2_000,
      mediaType: "audio/wav" } });
    expect(JSON.stringify(body)).not.toContain("objectKey");
    expect(storage.objects).toEqual([expect.objectContaining({ contentType: "audio/wav" })]);
    expect(storage.objects[0]!.key).toMatch(new RegExp(`^users/${ownerUserId}/plays/${playId}/takes/`));
    expect(await db.select().from(practiceSessions)).toEqual([expect.objectContaining({
      ownerUserId, playId, playModelVersion: 2, sceneId, roleId,
      selectedInterpretation: "Play the silence as a challenge", retentionChoice: "retain",
    })]);
    expect(await db.select().from(takes)).toEqual([expect.objectContaining({
      ownerUserId, rehearsalSessionId: null, durationMs: 2_000, mediaType: "audio/wav", state: "queued",
    })]);
    expect(await db.select().from(takeEvents)).toEqual([expect.objectContaining({ state: "queued" })]);
    expect(await db.select().from(jobs)).toEqual([expect.objectContaining({ kind: "process_take", status: "queued" })]);
    expect(await db.select().from(takeStageJobChains)).toEqual([expect.objectContaining({
      ownerUserId,
      playId,
      takeId: body.take.id,
      transcriptId: null,
      transcriptStatus: null,
      stageKind: "process_take",
    })]);
  });

  it("links a take to the matching owned rehearsal before writing private audio", async () => {
    // Break caught: ignoring rehearsalSessionId creates an ungrounded coaching take with no timing provenance.
    const response = await handler()(takeRequest(wav(1_000), {
      retentionChoice: "retain", rehearsalSessionId,
    }), context());

    expect(response.status).toBe(202);
    expect(await db.select().from(takes)).toEqual([expect.objectContaining({ rehearsalSessionId })]);
    expect(storage.objects).toHaveLength(1);
  });

  it("rejects a malformed rehearsal session id before writing private audio", async () => {
    // Break caught: passing arbitrary text into the UUID lookup turns invalid multipart input into a server error.
    const response = await handler()(takeRequest(wav(1_000), {
      retentionChoice: "retain", rehearsalSessionId: "not-a-uuid",
    }), context());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "A valid audio take is required" });
    expect(storage.objects).toEqual([]);
    expect(await db.select().from(takes)).toEqual([]);
  });

  it.each([
    { name: "another owner", patch: { ownerUserId: otherOwnerUserId } },
    { name: "another play", patch: { playId: "66666666-6666-4666-8666-666666666666" } },
    { name: "another Play Model", patch: { playModelId: "77777777-7777-4777-8777-777777777777" } },
    { name: "another Play Model version", patch: { playModelVersion: 1 } },
    { name: "another scene", patch: { sceneId: "scene-private" } },
    { name: "another actor role", patch: { actorRoleId: "role-private" } },
  ])("returns the same nonleaking miss for a rehearsal from $name before storage write", async ({ patch }) => {
    // Break caught: validating only the session id lets an owner splice timing evidence from a different rehearsal.
    const mismatchedId = "88888888-8888-4888-8888-888888888888";
    const row = { id: mismatchedId, ownerUserId, playId, playModelId: modelId, playModelVersion: 2,
      sceneId, actorRoleId: roleId, model: "realtime", grantExpiresAt: new Date("2026-08-25T12:10:00Z"),
      state: "completed" as const, ...patch };
    if (patch.ownerUserId === otherOwnerUserId) {
      await db.insert(plays).values({ id: "99999999-9999-4999-8999-999999999999",
        ownerUserId: otherOwnerUserId, title: "Other private play" });
      await db.insert(playModels).values({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ownerUserId: otherOwnerUserId, playId: "99999999-9999-4999-8999-999999999999", version: 2,
        status: "approved", model: playModel(), issues: [] });
      row.playId = "99999999-9999-4999-8999-999999999999";
      row.playModelId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    } else if (patch.playId) {
      await db.insert(plays).values({ id: row.playId, ownerUserId, title: "Other private play" });
      await db.insert(playModels).values({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ownerUserId,
        playId: row.playId, version: 2, status: "approved", model: playModel(), issues: [] });
      row.playModelId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    } else if (patch.playModelId) {
      await db.insert(playModels).values({ id: row.playModelId, ownerUserId, playId, version: 3,
        status: "approved", model: playModel(), issues: [] });
      row.playModelVersion = 3;
    }
    await db.insert(rehearsalSessions).values(row);

    const response = await handler()(takeRequest(wav(1_000), {
      retentionChoice: "retain", rehearsalSessionId: mismatchedId,
    }), context());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Rehearsal session not found" });
    expect(storage.objects).toEqual([]);
    expect(await db.select().from(takes)).toEqual([]);
    expect((await db.select().from(jobs)).filter(({ kind }) => kind === "delete_private_object")).toEqual([]);
  });

  it("derives WebM duration from an audio block timestamp and Opus frame instead of declared metadata", async () => {
    const response = await handler()(takeRequest(webm(3_250, { declaredDurationMs: 1 }), {
      retentionChoice: "delete_after_analysis", durationMs: "1",
    }, "actually.wav", "audio/wav"), context());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ take: { durationMs: 3_250, mediaType: "audio/webm" } });
    expect((await db.select().from(takes))[0]).toMatchObject({
      durationMs: 3_250, retentionChoice: "delete_after_analysis", mediaType: "audio/webm",
    });
  });

  it("accepts a streaming WebM Segment with the valid 8-byte unknown-size VINT", async () => {
    const response = await handler()(takeRequest(webm(1_000, { unknownSegmentSize: true }), {
      retentionChoice: "retain",
    }), context());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ take: { durationMs: 1_000, mediaType: "audio/webm" } });
  });

  it("derives the complete duration across streaming MediaRecorder clusters", async () => {
    const response = await handler()(takeRequest(webm(360_000, { streamingClusters: true }), {
      retentionChoice: "retain", durationMs: "30_000",
    }), context());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ take: { durationMs: 360_000, mediaType: "audio/webm" } });
    expect((await db.select().from(takes))[0]).toMatchObject({ durationMs: 360_000 });
  });

  it("uses the browser elapsed time when a WebM container timeline is stuck at 30 seconds", async () => {
    const response = await handler()(takeRequest(webm(30_000), {
      retentionChoice: "retain", durationMs: "360000.4",
    }), context());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ take: { durationMs: 360_000, mediaType: "audio/webm" } });
    expect((await db.select().from(takes))[0]).toMatchObject({ durationMs: 360_000 });
  });

  it.each([
    { name: "metadata-only WebM", upload: () => webm(1_000, { trackTypes: [], includeBlocks: false }) },
    { name: "audio track without media blocks", upload: () => webm(1_000, { includeBlocks: false }) },
    { name: "video-only WebM", upload: () => webm(1_000, { trackTypes: [1] }) },
    { name: "mixed audio/video WebM", upload: () => webm(1_000, { trackTypes: [2, 1] }) },
  ])("rejects $name because complete takes are voice-only audio media", async ({ upload }) => {
    const response = await handler()(takeRequest(upload(), { retentionChoice: "retain" }), context());

    expect(response.status).toBe(422);
    expect(storage.objects).toEqual([]);
    expect(await db.select().from(takes)).toEqual([]);
  });

  it.each([
    { name: "exactly twenty minutes", durationMs: 1_200_000, expected: 202 },
    { name: "one millisecond over twenty minutes", durationMs: 1_200_001, expected: 422 },
    { name: "zero duration", durationMs: 0, expected: 422 },
  ])("enforces the duration boundary for $name", async ({ durationMs, expected }) => {
    const response = await handler()(takeRequest(wav(durationMs), { retentionChoice: "retain" }), context());

    expect(response.status).toBe(expected);
  });

  it("rejects a derived duration slightly over twenty minutes before rounding for persistence", async () => {
    const response = await handler()(takeRequest(wavBytes(3_000_001, 2_500), {
      retentionChoice: "retain",
    }), context());

    expect(response.status).toBe(422);
    expect(storage.objects).toEqual([]);
  });

  it("accepts exactly 100 MiB and rejects anything larger before reading it", async () => {
    const exact = wav(1_000);
    Object.defineProperty(exact, "size", { value: 100 * 1024 * 1024 });
    const accepted = await handler()(directTakeRequest(exact, { retentionChoice: "retain" }), context());
    const tooLarge = wav(1_000);
    Object.defineProperty(tooLarge, "size", { value: 100 * 1024 * 1024 + 1 });
    let read = false;
    Object.defineProperty(tooLarge, "arrayBuffer", { value: async () => { read = true; return new ArrayBuffer(0); } });
    const rejected = await handler()(directTakeRequest(tooLarge, { retentionChoice: "retain" }), context());

    expect(accepted.status).toBe(202);
    expect(rejected.status).toBe(422);
    expect(read).toBe(false);
  });

  it("stops consuming a chunked multipart request as soon as its body exceeds the pre-buffer limit", async () => {
    const streamed = streamingMultipartRequest(16, 512);
    const response = await createTakeUploadHandler<PgliteQueryResultHKT>({
      authenticate: async () => ({ id: ownerUserId }), db, storage, maxMultipartBytes: 64,
    })(streamed.request, context());

    expect(response.status).toBe(422);
    expect(streamed.pulledChunks()).toBeLessThan(streamed.totalChunks);
    expect(storage.objects).toEqual([]);
  });

  it.each([
    { name: "arbitrary bytes labeled WAV", file: () => file(new Uint8Array([1, 2, 3]), "take.wav", "audio/wav") },
    { name: "truncated RIFF", file: () => file(new TextEncoder().encode("RIFF0000WAVE"), "take.wav", "audio/wav") },
    { name: "truncated EBML", file: () => file(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), "take.webm", "audio/webm") },
    { name: "WAV with a forged RIFF length", file: () => {
      const forged = wav(1_000);
      return forged.arrayBuffer().then((buffer) => {
        new DataView(buffer).setUint32(4, 44, true);
        return file(new Uint8Array(buffer), "take.wav", "audio/wav");
      });
    } },
    { name: "EBML-shaped bytes without the WebM document type", file: () => file(webmBytes(1_000, false),
      "take.webm", "audio/webm") },
  ])("rejects malformed/spoofed media: $name", async ({ file: upload }) => {
    const response = await handler()(takeRequest(await upload(), { retentionChoice: "retain" }), context());

    expect(response.status).toBe(422);
    expect(storage.objects).toEqual([]);
    expect(await db.select().from(takes)).toEqual([]);
  });

  it("requires authentication before reading or storing audio", async () => {
    let read = false;
    const audio = wav(1_000);
    Object.defineProperty(audio, "arrayBuffer", { value: async () => { read = true; return new ArrayBuffer(0); } });
    const response = await createTakeUploadHandler({ authenticate: async () => {
      throw Object.assign(new Error("Authentication required"), { name: "UnauthorizedError" });
    }, db, storage })(takeRequest(audio, { retentionChoice: "retain" }), context());

    expect(response.status).toBe(401);
    expect(read).toBe(false);
    expect(storage.objects).toEqual([]);
  });

  it("returns 404 for another actor's play without creating private data", async () => {
    const response = await handler(otherOwnerUserId)(takeRequest(wav(1_000), {
      retentionChoice: "retain",
    }), context());

    expect(response.status).toBe(404);
    expect(storage.objects).toEqual([]);
    expect(await db.select().from(takes)).toEqual([]);
  });

  it.each([
    { name: "scene outside the model", fields: { sceneId: "missing-scene" } },
    { name: "role outside the scene", fields: { roleId: "missing-role" } },
    { name: "unapproved model version", fields: { playModelVersion: "1" } },
    { name: "unknown retention choice", fields: { retentionChoice: "forever" } },
  ])("rejects $name", async ({ fields }) => {
    const response = await handler()(takeRequest(wav(1_000), {
      retentionChoice: "retain", ...fields,
    }), context());

    expect(response.status).toBe(422);
    expect(storage.objects).toEqual([]);
    expect(await db.select().from(takes)).toEqual([]);
  });

  it("deletes the private object and leaves no partial rows when the database transaction fails", async () => {
    await client.exec("ALTER TABLE jobs ADD CONSTRAINT reject_process_take CHECK (kind <> 'process_take')");

    const response = await handler()(takeRequest(wav(1_000), { retentionChoice: "retain" }), context());

    expect(response.status).toBe(500);
    expect(storage.objects).toEqual([]);
    expect(storage.deletedKeys).toHaveLength(1);
    expect(await db.select().from(practiceSessions)).toEqual([]);
    expect(await db.select().from(takes)).toEqual([]);
    expect(await db.select().from(takeEvents)).toEqual([]);
    expect(await db.select().from(jobs)).toEqual([]);
  });

  it("durably records an action-required cleanup when compensation deletion fails", async () => {
    await client.exec("ALTER TABLE jobs ADD CONSTRAINT reject_process_take CHECK (kind <> 'process_take')");
    storage.failDeletion = true;

    const response = await handler()(takeRequest(wav(1_000), { retentionChoice: "delete_after_analysis" }), context());

    expect(response.status).toBe(500);
    expect(storage.objects).toHaveLength(1);
    expect(await db.select().from(practiceSessions)).toEqual([]);
    expect(await db.select().from(takes)).toEqual([]);
    expect(await db.select().from(jobs)).toEqual([expect.objectContaining({
      ownerUserId, playId, kind: "delete_private_object", status: "action_required",
      errorCode: "PRIVATE_OBJECT_DELETE_FAILED",
      payload: { objectKey: storage.objects[0]!.key, reason: "take_upload_compensation" },
    })]);
  });

  it("purges an ambiguous upload that stores bytes before reporting failure", async () => {
    storage.failAfterWrite = true;

    const response = await handler()(takeRequest(wav(1_000), { retentionChoice: "retain" }), context());

    expect(response.status).toBe(500);
    expect(storage.objects).toEqual([]);
    expect(storage.deletedKeys).toHaveLength(1);
    expect(await db.select().from(takes)).toEqual([]);
    expect(await db.select().from(jobs)).toEqual([]);
  });

  it("keeps the uploaded object in deletion inventory when deletion wins before failed compensation", async () => {
    // Break caught: removing the committed pre-write identity lets deletion snapshot and cascade past leaked audio.
    await client.exec("ALTER TABLE jobs ADD CONSTRAINT reject_process_take CHECK (kind <> 'process_take')");
    storage.failDeletion = true;
    let deletionError: unknown;
    storage.beforePurge = async () => {
      try {
        await new AuthRepository(db).requestAccountDeletion({ ownerUserId,
          now: new Date("2026-08-23T12:00:00Z") });
      } catch (error) {
        deletionError = error;
      }
    };

    const response = await handler()(takeRequest(wav(1_000), { retentionChoice: "retain" }), context());

    expect(response.status).toBe(500);
    expect(deletionError).toBeUndefined();
    const leakedObjectKey = storage.objects[0]!.key;
    expect((await db.select().from(accountDeletions))[0]!.objectInventory.objectKeys)
      .toContain(leakedObjectKey);
    expect((await db.select().from(users).where(eq(users.id, ownerUserId)))[0]!.accountStatus).toBe("deleting");
  });

  it("does not upload a take after the owner enters deletion", async () => {
    await db.update(users).set({ accountStatus: "deleting" }).where(eq(users.id, ownerUserId));

    const response = await handler()(takeRequest(wav(1_000), { retentionChoice: "retain" }), context());

    expect(response.status).toBe(404);
    expect(storage.objects).toEqual([]);
    expect(await db.select().from(takes)).toEqual([]);
  });

  function handler(ownerId = ownerUserId) {
    return createTakeUploadHandler<PgliteQueryResultHKT>({ authenticate: async () => ({ id: ownerId }), db, storage });
  }
});

class RecordingStorage implements ObjectStorage {
  readonly objects: Array<{ key: string; bytes: Uint8Array; contentType: string }> = [];
  readonly deletedKeys: string[] = [];
  failAfterWrite = false;
  failDeletion = false;
  beforePurge?: () => Promise<void>;

  async putPrivate(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.push({ key, bytes: bytes.slice(), contentType });
    if (this.failAfterWrite) throw new Error("ambiguous write result");
  }

  async putPrivateVersioned(key: string, bytes: Uint8Array, contentType: string) {
    await this.putPrivate(key, bytes, contentType);
    return { versionToken: `recording:${this.objects.length}` };
  }

  async getPrivate(): Promise<Uint8Array> {
    throw new Error("not implemented");
  }

  async deletePrivate(key: string): Promise<void> {
    this.deletedKeys.push(key);
    if (this.failDeletion) throw new Error("delete failed");
    const index = this.objects.findIndex((object) => object.key === key);
    if (index >= 0) this.objects.splice(index, 1);
  }

  async purgePrivate(key: string): Promise<void> {
    this.deletedKeys.push(key);
    await this.beforePurge?.();
    if (this.failDeletion) throw new Error("delete failed");
    for (let index = this.objects.length - 1; index >= 0; index -= 1) {
      if (this.objects[index]!.key === key) this.objects.splice(index, 1);
    }
  }


  async deletePrivateVersion(key: string): Promise<boolean> {
    this.deletedKeys.push(key);
    if (this.failDeletion) throw new Error("delete failed");
    const index = this.objects.findIndex((object) => object.key === key);
    if (index < 0) return false;
    this.objects.splice(index, 1);
    return true;
  }
}

function streamingMultipartRequest(chunkSize: number, paddingSize: number) {
  const boundary = "drama-test-boundary";
  const bytes = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="padding"\r\n\r\n${
    "x".repeat(paddingSize)}\r\n--${boundary}--\r\n`);
  const chunks = Array.from({ length: Math.ceil(bytes.length / chunkSize) }, (_, index) =>
    bytes.slice(index * chunkSize, Math.min(bytes.length, (index + 1) * chunkSize)));
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulled];
      pulled += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
  const request = new Request(`http://localhost/api/plays/${playId}/takes`, {
    method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { request, totalChunks: chunks.length, pulledChunks: () => pulled };
}

function context() { return { params: Promise.resolve({ playId }) }; }

function takeRequest(audio: File, overrides: Record<string, string | undefined> = {}, filename?: string,
  contentType?: string) {
  const form = new FormData();
  const upload = filename || contentType
    ? new File([audio], filename ?? audio.name, { type: contentType ?? audio.type })
    : audio;
  form.set("audio", upload);
  form.set("playModelVersion", overrides.playModelVersion ?? "2");
  form.set("sceneId", overrides.sceneId ?? sceneId);
  form.set("roleId", overrides.roleId ?? roleId);
  form.set("retentionChoice", overrides.retentionChoice ?? "retain");
  if (overrides.selectedInterpretation) form.set("selectedInterpretation", overrides.selectedInterpretation);
  if (overrides.durationMs) form.set("durationMs", overrides.durationMs);
  if (overrides.rehearsalSessionId) form.set("rehearsalSessionId", overrides.rehearsalSessionId);
  return new Request(`http://localhost/api/plays/${playId}/takes`, { method: "POST", body: form });
}

function directTakeRequest(audio: File, overrides: Record<string, string | undefined> = {}): Request {
  const form = takeForm(audio, overrides);
  return { headers: new Headers({ "content-type": "multipart/form-data; boundary=test" }),
    formData: async () => form } as Request;
}

function takeForm(audio: File, overrides: Record<string, string | undefined>): FormData {
  const form = new FormData();
  form.set("audio", audio);
  form.set("playModelVersion", overrides.playModelVersion ?? "2");
  form.set("sceneId", overrides.sceneId ?? sceneId);
  form.set("roleId", overrides.roleId ?? roleId);
  form.set("retentionChoice", overrides.retentionChoice ?? "retain");
  return form;
}

function file(bytes: Uint8Array, name: string, type: string): File {
  return new File([bytes.slice().buffer as ArrayBuffer], name, { type });
}

function wav(durationMs: number): File {
  const sampleRate = 1_000;
  const dataSize = Math.max(0, Math.ceil(durationMs));
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  ascii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  ascii(bytes, 8, "WAVE");
  ascii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(bytes, 36, "data");
  view.setUint32(40, dataSize, true);
  return file(bytes, "take.wav", "audio/wav");
}

function webm(durationMs: number, options: {
  declaredDurationMs?: number;
  trackTypes?: number[];
  includeBlocks?: boolean;
  unknownSegmentSize?: boolean;
  streamingClusters?: boolean;
} = {}): File {
  return file(webmBytes(durationMs, true, options), "take.webm", "audio/webm");
}

function webmBytes(durationMs: number, includeDocType: boolean, options: {
  declaredDurationMs?: number;
  trackTypes?: number[];
  includeBlocks?: boolean;
  unknownSegmentSize?: boolean;
  streamingClusters?: boolean;
} = {}): Uint8Array {
  const timecodeScale = element([0x2a, 0xd7, 0xb1], uintBytes(1_000_000));
  const duration = new Uint8Array(8);
  new DataView(duration.buffer).setFloat64(0, options.declaredDurationMs ?? durationMs, false);
  const info = element([0x15, 0x49, 0xa9, 0x66], concat(timecodeScale, element([0x44, 0x89], duration)));
  const trackTypes = options.trackTypes ?? [2];
  const tracks = trackTypes.length ? element([0x16, 0x54, 0xae, 0x6b], concat(...trackTypes.map((type, index) =>
    element([0xae], concat(
      element([0xd7], new Uint8Array([index + 1])),
      element([0x83], new Uint8Array([type])),
      element([0x86], new TextEncoder().encode(type === 2 ? "A_OPUS" : "V_VP8")),
      element(type === 2 ? [0xe1] : [0xe0], new Uint8Array()),
    )),
  ))) : new Uint8Array();
  const includeBlocks = options.includeBlocks ?? true;
  const finalTimestamp = Math.max(0, durationMs - 20);
  const clusterTimestamps = options.streamingClusters
    ? [...new Set([...Array.from({ length: Math.floor(finalTimestamp / 30_000) + 1 },
      (_, index) => index * 30_000), finalTimestamp])]
    : [finalTimestamp];
  const clusters = includeBlocks ? concat(...clusterTimestamps.map((clusterTimestamp) => {
    const payload = concat(element([0xe7], uintBytes(clusterTimestamp)),
      element([0xa3], new Uint8Array([0x81, 0, 0, 0, 0x98, 0])));
    return options.streamingClusters
      ? unknownSizedElement([0x1f, 0x43, 0xb6, 0x75], payload)
      : element([0x1f, 0x43, 0xb6, 0x75], payload);
  })) : new Uint8Array();
  const segmentPayload = concat(info, tracks, clusters);
  const segment = options.unknownSegmentSize || options.streamingClusters
    ? unknownSizedElement([0x18, 0x53, 0x80, 0x67], segmentPayload)
    : element([0x18, 0x53, 0x80, 0x67], segmentPayload);
  const headerPayload = includeDocType
    ? concat(element([0x42, 0x86], new Uint8Array([1])), element([0x42, 0x82], new TextEncoder().encode("webm")))
    : element([0x42, 0x86], new Uint8Array([1]));
  const header = element([0x1a, 0x45, 0xdf, 0xa3], headerPayload);
  return concat(header, segment);
}

function unknownSizedElement(id: number[], payload: Uint8Array): Uint8Array {
  return concat(new Uint8Array(id), new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), payload);
}

function wavBytes(dataSize: number, byteRate: number): File {
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  ascii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  ascii(bytes, 8, "WAVE");
  ascii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, byteRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(bytes, 36, "data");
  view.setUint32(40, dataSize, true);
  return file(bytes, "take.wav", "audio/wav");
}

function element(id: number[], payload: Uint8Array): Uint8Array {
  if (payload.length > 126) throw new Error("test element is too large");
  return concat(new Uint8Array(id), new Uint8Array([0x80 | payload.length]), payload);
}

function uintBytes(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0));
  let offset = 0;
  for (const array of arrays) { result.set(array, offset); offset += array.length; }
  return result;
}

function ascii(bytes: Uint8Array, offset: number, text: string): void {
  bytes.set(new TextEncoder().encode(text), offset);
}

function playModel() {
  return { id: "model", title: "Private Play", language: "en" as const,
    characters: [{ id: roleId, name: "Alex", aliases: [] }, { id: "role-2", name: "Morgan", aliases: [] }],
    acts: [{ id: "act-1", ordinal: 1, title: "Act I", scenes: [{ id: sceneId, ordinal: 1,
      title: "Scene One", characterIds: [roleId], elements: [] }] }] };
}
