import { randomUUID } from "node:crypto";

import { InactiveAccountError, PracticeRepository } from "@drama/db/repositories/practice";
import { lockActiveOwner } from "@drama/db/repositories/auth";
import { StudyRepository } from "@drama/db/repositories/study";
import type * as schema from "@drama/db/schema";
import { jobs, rehearsalSessions } from "@drama/db/schema";
import type { PracticeMode, RetentionChoice } from "@drama/domain/practice";
import type { ObjectStorage } from "@drama/storage/port";
import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_DURATION_MS = 20 * 60 * 1_000;
const RETENTION_CHOICES = new Set<RetentionChoice>(["retain", "delete_after_analysis"]);
const PRACTICE_MODES = new Set<PracticeMode>(["complete_take", "guided_exercise"]);

type RouteContext = { params: Promise<{ playId: string }> };
type Dependencies<TQueryResult extends PgQueryResultHKT> = {
  authenticate: () => Promise<{ id: string }>;
  db: PgDatabase<TQueryResult, typeof schema>;
  storage: ObjectStorage;
  createId?: () => string;
  maxMultipartBytes?: number;
};

export function createTakeUploadHandler<TQueryResult extends PgQueryResultHKT>(
  dependencies: Dependencies<TQueryResult>,
) {
  return async function POST(request: Request, context: RouteContext): Promise<Response> {
    let user: { id: string };
    try {
      user = await dependencies.authenticate();
    } catch (error) {
      if (error instanceof Error && error.name === "UnauthorizedError") {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      return Response.json({ error: "Unable to authenticate" }, { status: 500 });
    }

    const { playId } = await context.params;
    const study = new StudyRepository(dependencies.db);
    if (!await study.getOwnedPlay(user.id, playId)) {
      return Response.json({ error: "Play not found" }, { status: 404 });
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.startsWith("multipart/form-data")) {
      return Response.json({ error: "A valid audio take is required" }, { status: 422 });
    }
    const form = await readLimitedMultipartForm(request,
      dependencies.maxMultipartBytes ?? MAX_AUDIO_BYTES + MAX_MULTIPART_OVERHEAD_BYTES);
    const parsed = form ? await parseUpload(form) : null;
    if (!parsed) return Response.json({ error: "A valid audio take is required" }, { status: 422 });

    const approved = await study.getApprovedModel(user.id, playId, parsed.playModelVersion);
    if (!approved) return Response.json({ error: "Approved Play Model version not found" }, { status: 422 });
    const scene = approved.model.acts.flatMap((act) => act.scenes)
      .find((candidate) => candidate.id === parsed.sceneId);
    if (!scene || !scene.characterIds.includes(parsed.roleId)) {
      return Response.json({ error: "Scene and role must belong to the approved Play Model" }, { status: 422 });
    }

    const takeId = (dependencies.createId ?? randomUUID)();
    const sessionId = (dependencies.createId ?? randomUUID)();
    const extension = parsed.mediaType === "audio/wav" ? "wav" : "webm";
    const objectKey = `users/${user.id}/plays/${playId}/takes/${takeId}.${extension}`;
    const cleanupDedupeKey = `delete_private_object:${takeId}`;
    const reserved = await reserveUploadIdentity(dependencies.db, {
      ownerUserId: user.id, playId, objectKey, dedupeKey: cleanupDedupeKey,
    });
    if (!reserved) return Response.json({ error: "Play not found" }, { status: 404 });
    let writeAttempted = false;
    try {
      const result = await dependencies.db.transaction(async (transaction) => {
        if (!await lockActiveOwner(transaction, user.id)) throw new InactiveAccountError();
        if (parsed.rehearsalSessionId) {
          const [rehearsal] = await transaction.select({ id: rehearsalSessions.id }).from(rehearsalSessions)
            .where(and(eq(rehearsalSessions.id, parsed.rehearsalSessionId),
              eq(rehearsalSessions.ownerUserId, user.id), eq(rehearsalSessions.playId, playId),
              eq(rehearsalSessions.playModelId, approved.id),
              eq(rehearsalSessions.playModelVersion, approved.version),
              eq(rehearsalSessions.sceneId, parsed.sceneId), eq(rehearsalSessions.actorRoleId, parsed.roleId)))
            .limit(1);
          if (!rehearsal) throw new RehearsalLinkNotFoundError();
        }
        writeAttempted = true;
        await dependencies.storage.putPrivate(objectKey, parsed.bytes, parsed.mediaType);
        const repository = new PracticeRepository(transaction);
        const queued = await repository.createQueuedTakeInTransaction(transaction, { ownerUserId: user.id, playId,
          playModelId: approved.id, playModelVersion: approved.version, sceneId: parsed.sceneId,
          roleId: parsed.roleId, selectedInterpretation: parsed.selectedInterpretation,
          retentionChoice: parsed.retentionChoice, durationMs: parsed.durationMs,
          mediaType: parsed.mediaType, objectKey, practiceMode: parsed.practiceMode,
          rehearsalSessionId: parsed.rehearsalSessionId, sessionId, takeId });
        await transaction.delete(jobs).where(and(eq(jobs.ownerUserId, user.id), eq(jobs.kind, "delete_private_object"),
          eq(jobs.dedupeKey, cleanupDedupeKey)));
        return queued;
      });
      return Response.json({ take: { id: result.take.id, state: result.take.state,
        durationMs: result.take.durationMs, mediaType: result.take.mediaType } }, { status: 202 });
    } catch (error) {
      if (writeAttempted) {
        try {
          await dependencies.storage.purgePrivate(objectKey);
          await releaseUploadIdentity(dependencies.db, user.id, cleanupDedupeKey);
        } catch {
          await markUploadIdentityCleanupRequired(dependencies.db, user.id, cleanupDedupeKey);
        }
      } else {
        await releaseUploadIdentity(dependencies.db, user.id, cleanupDedupeKey);
      }
      if (error instanceof InactiveAccountError) return Response.json({ error: "Play not found" }, { status: 404 });
      if (error instanceof RehearsalLinkNotFoundError) {
        return Response.json({ error: "Rehearsal session not found" }, { status: 404 });
      }
      return Response.json({ error: "Unable to store take" }, { status: 500 });
    }
  };
}

type UploadIdentity = { ownerUserId: string; playId: string; objectKey: string; dedupeKey: string };

async function reserveUploadIdentity<TQueryResult extends PgQueryResultHKT>(
  db: PgDatabase<TQueryResult, typeof schema>, input: UploadIdentity,
): Promise<boolean> {
  return db.transaction(async (transaction) => {
    if (!await lockActiveOwner(transaction, input.ownerUserId)) return false;
    await transaction.insert(jobs).values({ ownerUserId: input.ownerUserId, playId: input.playId,
      kind: "delete_private_object", status: "action_required", errorCode: "PRIVATE_OBJECT_WRITE_RESERVED",
      dedupeKey: input.dedupeKey,
      payload: { objectKey: input.objectKey, reason: "take_upload_compensation" } }).onConflictDoNothing();
    return true;
  });
}

async function releaseUploadIdentity<TQueryResult extends PgQueryResultHKT>(
  db: PgDatabase<TQueryResult, typeof schema>, ownerUserId: string, dedupeKey: string,
): Promise<void> {
  await db.transaction(async (transaction) => {
    if (!await lockActiveOwner(transaction, ownerUserId)) return;
    await transaction.delete(jobs).where(and(eq(jobs.ownerUserId, ownerUserId),
      eq(jobs.kind, "delete_private_object"), eq(jobs.dedupeKey, dedupeKey)));
  });
}

async function markUploadIdentityCleanupRequired<TQueryResult extends PgQueryResultHKT>(
  db: PgDatabase<TQueryResult, typeof schema>, ownerUserId: string, dedupeKey: string,
): Promise<void> {
  await db.transaction(async (transaction) => {
    if (!await lockActiveOwner(transaction, ownerUserId)) return;
    await transaction.update(jobs).set({ errorCode: "PRIVATE_OBJECT_DELETE_FAILED" }).where(and(
      eq(jobs.ownerUserId, ownerUserId), eq(jobs.kind, "delete_private_object"), eq(jobs.dedupeKey, dedupeKey),
    ));
  });
}

async function readLimitedMultipartForm(request: Request, maxBytes: number): Promise<FormData | null> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;
  if (!request.body) return request.formData().catch(() => null);
  let receivedBytes = 0;
  const limitedBody = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > maxBytes) {
        controller.error(new Error("Multipart body exceeds the private take limit"));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  const limitedRequest = new Request(request.url, { method: request.method, headers: request.headers,
    body: limitedBody, duplex: "half" } as RequestInit & { duplex: "half" });
  return limitedRequest.formData().catch(() => null);
}

type ParsedUpload = {
  bytes: Uint8Array;
  mediaType: "audio/webm" | "audio/wav";
  durationMs: number;
  playModelVersion: number;
  sceneId: string;
  roleId: string;
  selectedInterpretation: string | null;
  retentionChoice: RetentionChoice;
  practiceMode: PracticeMode;
  rehearsalSessionId: string | null;
};

async function parseUpload(form: FormData): Promise<ParsedUpload | null> {
  const files = form.getAll("audio");
  if (files.length !== 1 || !(files[0] instanceof File) || files[0].size === 0 ||
    files[0].size > MAX_AUDIO_BYTES) return null;
  const version = numberField(form, "playModelVersion");
  const sceneId = stringField(form, "sceneId");
  const roleId = stringField(form, "roleId");
  const retention = stringField(form, "retentionChoice") as RetentionChoice | null;
  const practiceMode = (optionalStringField(form, "practiceMode") ?? "complete_take") as PracticeMode;
  const selectedInterpretation = optionalStringField(form, "selectedInterpretation");
  const rehearsalSessionId = optionalStringField(form, "rehearsalSessionId");
  if (!version || !Number.isInteger(version) || !sceneId || !roleId || !retention ||
    !RETENTION_CHOICES.has(retention) || !PRACTICE_MODES.has(practiceMode) ||
    (rehearsalSessionId !== null && !UUID_PATTERN.test(rehearsalSessionId))) return null;
  const bytes = new Uint8Array(await files[0].arrayBuffer());
  const inspected = inspectAudio(bytes);
  if (!inspected || inspected.durationMs <= 0 || inspected.durationMs > MAX_DURATION_MS) return null;
  const recordedDurationMs = decimalField(form, "durationMs");
  if (recordedDurationMs !== null && (recordedDurationMs <= 0 || recordedDurationMs > MAX_DURATION_MS)) return null;
  // Browser MediaRecorder output is not guaranteed to carry a duration for the
  // complete capture. In particular, some implementations leave the final
  // WebM timeline at the last emitted cluster (commonly 30 seconds). The
  // monotonic elapsed time captured alongside the Blob is therefore the best
  // available duration when it is longer than the container timeline.
  const durationMs = inspected.mediaType === "audio/webm" && recordedDurationMs !== null
    ? Math.max(inspected.durationMs, recordedDurationMs)
    : inspected.durationMs;
  return { bytes, ...inspected, durationMs: Math.max(1, Math.round(durationMs)),
    playModelVersion: version, sceneId, roleId, selectedInterpretation, retentionChoice: retention, practiceMode,
    rehearsalSessionId };
}

class RehearsalLinkNotFoundError extends Error {
  constructor() { super("REHEARSAL_LINK_NOT_FOUND"); this.name = "RehearsalLinkNotFoundError"; }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stringField(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalStringField(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberField(form: FormData, name: string): number | null {
  const value = stringField(form, name);
  if (!value || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function decimalField(form: FormData, name: string): number | null {
  const value = stringField(form, name);
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function inspectAudio(bytes: Uint8Array): Pick<ParsedUpload, "mediaType" | "durationMs"> | null {
  return inspectWav(bytes) ?? inspectWebm(bytes);
}

function inspectWav(bytes: Uint8Array): Pick<ParsedUpload, "mediaType" | "durationMs"> | null {
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== bytes.length - 8) return null;
  let offset = 12;
  let byteRate: number | undefined;
  let dataSize: number | undefined;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const contentStart = offset + 8;
    const contentEnd = contentStart + size;
    if (contentEnd > bytes.length) return null;
    if (id === "fmt ") {
      if (size < 16 || view.getUint16(contentStart, true) !== 1) return null;
      const channels = view.getUint16(contentStart + 2, true);
      const sampleRate = view.getUint32(contentStart + 4, true);
      byteRate = view.getUint32(contentStart + 8, true);
      const blockAlign = view.getUint16(contentStart + 12, true);
      const bits = view.getUint16(contentStart + 14, true);
      if (!channels || !sampleRate || !byteRate || !blockAlign || !bits ||
        byteRate !== sampleRate * blockAlign || blockAlign !== channels * bits / 8) return null;
    } else if (id === "data") dataSize = size;
    offset = contentEnd + (size % 2);
  }
  if (!byteRate || dataSize === undefined) return null;
  return { mediaType: "audio/wav", durationMs: dataSize / byteRate * 1_000 };
}

function inspectWebm(bytes: Uint8Array): Pick<ParsedUpload, "mediaType" | "durationMs"> | null {
  const header = readEbmlElement(bytes, 0, bytes.length);
  if (!header || header.id !== 0x1a45dfa3 || header.unknownSize) return null;
  const headerChildren = readEbmlChildren(bytes, header.dataOffset, header.end);
  const docType = headerChildren?.find(({ id }) => id === 0x4282);
  if (!docType || ascii(bytes, docType.dataOffset, docType.end - docType.dataOffset) !== "webm") return null;
  const segment = readEbmlElement(bytes, header.end, bytes.length);
  if (!segment || segment.id !== 0x18538067 || segment.end !== bytes.length) return null;
  const segmentChildren = readEbmlChildren(bytes, segment.dataOffset, segment.end);
  if (!segmentChildren) return null;
  const info = segmentChildren.find(({ id }) => id === 0x1549a966);
  const tracks = segmentChildren.find(({ id }) => id === 0x1654ae6b);
  const clusters = segmentChildren.filter(({ id }) => id === 0x1f43b675);
  if (!info || !tracks || clusters.length === 0) return null;
  const infoChildren = readEbmlChildren(bytes, info.dataOffset, info.end);
  const scaleElement = infoChildren?.find(({ id }) => id === 0x2ad7b1);
  const timecodeScale = scaleElement ? readUnsigned(bytes, scaleElement) : 1_000_000;
  if (!timecodeScale || timecodeScale <= 0) return null;
  const audioTracks = inspectAudioTracks(bytes, tracks);
  if (!audioTracks) return null;

  let blockCount = 0;
  let durationMs = 0;
  const pendingClusters = [...clusters];
  for (let clusterIndex = 0; clusterIndex < pendingClusters.length; clusterIndex += 1) {
    const cluster = pendingClusters[clusterIndex]!;
    const children = readEbmlChildren(bytes, cluster.dataOffset, cluster.end);
    if (!children) return null;
    const timestampElement = children.find(({ id }) => id === 0xe7);
    const clusterTimestamp = timestampElement ? readUnsigned(bytes, timestampElement) : 0;
    if (clusterTimestamp === null) return null;
    for (const child of children) {
      if (child.id === 0x1f43b675) {
        // MediaRecorder writes streaming Clusters with unknown sizes. The generic
        // EBML reader necessarily sees each following Cluster as nested inside
        // the previous one, so explicitly continue through that chain.
        pendingClusters.push(child);
      } else if (child.id === 0xa3) {
        const inspected = inspectWebmBlock(bytes, child, clusterTimestamp, timecodeScale, audioTracks, null);
        if (!inspected) return null;
        durationMs = Math.max(durationMs, inspected);
        blockCount += 1;
      } else if (child.id === 0xa0) {
        const group = readEbmlChildren(bytes, child.dataOffset, child.end);
        const block = group?.find(({ id }) => id === 0xa1);
        const blockDuration = group?.find(({ id }) => id === 0x9b);
        const durationTicks = blockDuration ? readUnsigned(bytes, blockDuration) : null;
        if (!block || durationTicks === null) return null;
        const inspected = inspectWebmBlock(bytes, block, clusterTimestamp, timecodeScale, audioTracks,
          durationTicks * timecodeScale / 1_000_000);
        if (!inspected) return null;
        durationMs = Math.max(durationMs, inspected);
        blockCount += 1;
      }
    }
  }
  if (blockCount === 0 || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  return { mediaType: "audio/webm", durationMs };
}

type EbmlElement = { id: number; dataOffset: number; end: number; unknownSize: boolean };
type AudioTrack = { codecId: string; defaultDurationMs: number | null };

function inspectAudioTracks(bytes: Uint8Array, tracks: EbmlElement): Map<number, AudioTrack> | null {
  const children = readEbmlChildren(bytes, tracks.dataOffset, tracks.end);
  const entries = children?.filter(({ id }) => id === 0xae);
  if (!entries?.length) return null;
  const result = new Map<number, AudioTrack>();
  for (const entry of entries) {
    const fields = readEbmlChildren(bytes, entry.dataOffset, entry.end);
    const numberElement = fields?.find(({ id }) => id === 0xd7);
    const typeElement = fields?.find(({ id }) => id === 0x83);
    const codecElement = fields?.find(({ id }) => id === 0x86);
    const defaultDurationElement = fields?.find(({ id }) => id === 0x23e383);
    const hasAudioSettings = fields?.some(({ id }) => id === 0xe1);
    const trackNumber = numberElement ? readUnsigned(bytes, numberElement) : null;
    const trackType = typeElement ? readUnsigned(bytes, typeElement) : null;
    if (!trackNumber || trackType !== 2 || !codecElement || !hasAudioSettings || result.has(trackNumber)) return null;
    const codecId = ascii(bytes, codecElement.dataOffset, codecElement.end - codecElement.dataOffset);
    if (!codecId.startsWith("A_")) return null;
    const defaultDurationNs = defaultDurationElement ? readUnsigned(bytes, defaultDurationElement) : null;
    result.set(trackNumber, { codecId,
      defaultDurationMs: defaultDurationNs === null ? null : defaultDurationNs / 1_000_000 });
  }
  return result;
}

function inspectWebmBlock(bytes: Uint8Array, block: EbmlElement, clusterTimestamp: number,
  timecodeScale: number, tracks: Map<number, AudioTrack>, explicitDurationMs: number | null): number | null {
  const trackNumber = readVint(bytes, block.dataOffset);
  if (!trackNumber || trackNumber.value === null || !tracks.has(trackNumber.value) ||
    trackNumber.next + 3 > block.end) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + trackNumber.next, 2);
  const relativeTimestamp = view.getInt16(0, false);
  const flags = bytes[trackNumber.next + 2]!;
  if ((flags & 0x06) !== 0) return null;
  const payloadOffset = trackNumber.next + 3;
  if (payloadOffset >= block.end) return null;
  const timestampMs = (clusterTimestamp + relativeTimestamp) * timecodeScale / 1_000_000;
  if (!Number.isFinite(timestampMs) || timestampMs < 0) return null;
  const track = tracks.get(trackNumber.value)!;
  const frameDurationMs = explicitDurationMs ?? track.defaultDurationMs ??
    (track.codecId === "A_OPUS" ? inspectOpusPacketDuration(bytes.subarray(payloadOffset, block.end)) : null);
  if (!frameDurationMs || !Number.isFinite(frameDurationMs) || frameDurationMs <= 0) return null;
  return timestampMs + frameDurationMs;
}

function inspectOpusPacketDuration(packet: Uint8Array): number | null {
  const toc = packet[0];
  if (toc === undefined) return null;
  const configuration = toc >> 3;
  const frameDurationMs = configuration >= 16
    ? 2.5 * 2 ** (configuration & 3)
    : configuration >= 12
      ? 10 * 2 ** (configuration & 1)
      : [10, 20, 40, 60][configuration & 3]!;
  const frameCode = toc & 3;
  const frameCount = frameCode === 0 ? 1 : frameCode < 3 ? 2 : (packet[1] ?? 0) & 0x3f;
  const durationMs = frameDurationMs * frameCount;
  return frameCount > 0 && durationMs <= 120 ? durationMs : null;
}

function readEbmlChildren(bytes: Uint8Array, start: number, end: number): EbmlElement[] | null {
  const elements: EbmlElement[] = [];
  let offset = start;
  while (offset < end) {
    const element = readEbmlElement(bytes, offset, end);
    if (!element || element.end <= offset) return null;
    elements.push(element);
    offset = element.end;
  }
  return offset === end ? elements : null;
}

function readEbmlElement(bytes: Uint8Array, offset: number, parentEnd: number): EbmlElement | null {
  const identifier = readEbmlIdentifier(bytes, offset);
  if (!identifier) return null;
  const size = readVint(bytes, identifier.next);
  if (!size) return null;
  const end = size.value === null ? parentEnd : size.next + size.value;
  if (end > parentEnd || end > bytes.length) return null;
  return { id: identifier.value, dataOffset: size.next, end, unknownSize: size.value === null };
}

function readEbmlIdentifier(bytes: Uint8Array, offset: number): { value: number; next: number } | null {
  const first = bytes[offset];
  if (!first) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 4 && (first & mask) === 0) { length += 1; mask >>= 1; }
  if (length > 4 || offset + length > bytes.length) return null;
  let value = 0;
  for (let index = 0; index < length; index += 1) value = value * 256 + bytes[offset + index]!;
  return { value, next: offset + length };
}

function readVint(bytes: Uint8Array, offset: number): { value: number | null; next: number } | null {
  const first = bytes[offset];
  if (!first) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) { length += 1; mask >>= 1; }
  if (length > 8 || offset + length > bytes.length) return null;
  let value = first & (mask - 1);
  let unknownValue = value === mask - 1;
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + bytes[offset + index]!;
    unknownValue = unknownValue && bytes[offset + index] === 0xff;
  }
  if (!unknownValue && !Number.isSafeInteger(value)) return null;
  return { value: unknownValue ? null : value, next: offset + length };
}

function readUnsigned(bytes: Uint8Array, element: EbmlElement): number | null {
  const length = element.end - element.dataOffset;
  if (length < 1 || length > 8) return null;
  let value = 0;
  for (let index = element.dataOffset; index < element.end; index += 1) value = value * 256 + bytes[index]!;
  return Number.isSafeInteger(value) ? value : null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
