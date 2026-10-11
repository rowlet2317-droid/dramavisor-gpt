import { createHash, randomUUID } from "node:crypto";

import type { Transcriber } from "@drama/ai/transcription/port";
import { lockActiveOwner } from "@drama/db/repositories/auth";
import * as schema from "@drama/db/schema";
import { jobs, lineAlignments, normalizedAudioArtifacts, playModels, privateObjectCleanupTasks, takeEvents,
  takeStageJobChains, takeTranscripts, takes, transcriptUncertaintyRegions, transcriptWords } from "@drama/db/schema";
import type { TakeState } from "@drama/domain/practice";
import type { Transcript, UncertaintyRegion } from "@drama/domain/transcript";
import { alignScript } from "@drama/media/audio/align-script";
import { normalizeAudio } from "@drama/media/audio/normalize";
import type { ObjectStorage } from "@drama/storage/port";
import { and, eq, ne } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { assertActiveJobLease, failJob } from "./claim";

type JobDatabase<TQueryResult extends PgQueryResultHKT> = PgDatabase<TQueryResult, typeof schema>;

type RunTranscribeTakeJobOptions<TQueryResult extends PgQueryResultHKT> = {
  db: JobDatabase<TQueryResult>;
  ownerUserId: string;
  jobId: string;
  leaseToken: string;
  attemptCount: number;
  transcriber: Transcriber;
  loadPrivateObject: (objectKey: string) => Promise<Uint8Array>;
  normalize?: (audio: Uint8Array) => Promise<Uint8Array>;
  normalizedAudioStorage?: ObjectStorage;
  afterNormalizedAudioWrite?: (db: JobDatabase<TQueryResult>) => Promise<void>;
  createId?: () => string;
  now?: Date;
};

class ExactVersionCleanupRequiredError extends Error {
  constructor(readonly transcriptId: string, readonly objectKey: string, readonly storageVersionToken: string, cause: unknown) {
    super("Exact normalized-audio cleanup is required", { cause });
    this.name = "ExactVersionCleanupRequiredError";
  }
}

class ExactVersionCompensatedError extends Error {
  constructor(readonly originalError: unknown) {
    super("Exact normalized-audio compensation completed", { cause: originalError });
    this.name = "ExactVersionCompensatedError";
  }
}

class NormalizedAudioReservationMismatchError extends Error {
  constructor(readonly transcriptId: string) {
    super("Normalized-audio reservation must match the winning transcript");
    this.name = "NormalizedAudioReservationMismatchError";
  }
}

export async function runTranscribeTakeJob<TQueryResult extends PgQueryResultHKT>(
  options: RunTranscribeTakeJobOptions<TQueryResult>,
): Promise<{ transcriptId: string; deduplicated: boolean }> {
  const [job] = await options.db.select().from(jobs).where(and(
    eq(jobs.id, options.jobId),
    eq(jobs.ownerUserId, options.ownerUserId),
    eq(jobs.kind, "process_take"),
  )).limit(1);
  const takeId = job?.payload.takeId;
  if (!job || typeof takeId !== "string") throw new Error("Process-take job not found");
  const [take] = await options.db.select().from(takes).where(and(
    eq(takes.id, takeId),
    eq(takes.ownerUserId, options.ownerUserId),
  )).limit(1);
  if (!take) throw new Error("Take not found");

  await markProcessing(options.db, options.ownerUserId, take.id, options);
  const originalAudio = await options.loadPrivateObject(take.objectKey);
  const audioSha256 = createHash("sha256").update(originalAudio).digest("hex");
  const existing = await findDedupe(options.db, options.ownerUserId, take.id, audioSha256,
    options.transcriber.version);
  if (existing) {
    const normalized = options.normalizedAudioStorage && isSupportedLanguage(existing.language)
      ? await (options.normalize ?? normalizeAudio)(originalAudio)
      : null;
    const reservation = normalized ? await reserveNormalizedAudioIdentity(options.db, options, take, existing.id) : null;
    try {
      await options.db.transaction(async (transaction) => {
        await assertActiveJobLease(transaction, options.ownerUserId, job.id, options);
        await promoteTranscript(transaction, options.ownerUserId, take.id, existing.id, options.now);
        if (normalized) await publishMeasurementHandoff(transaction, options, take, existing.id, normalized,
          reservation!);
        await finalize(transaction, options.ownerUserId, job.id, take.id, existing.language,
          existing.timingSource, options.now);
      });
    } catch (error) {
      if (error instanceof ExactVersionCompensatedError && reservation) {
        await releaseNormalizedAudioIdentity(options.db, options.ownerUserId, reservation.dedupeKey);
        throw error.originalError;
      }
      if (error instanceof ExactVersionCleanupRequiredError) {
        await recordNormalizedAudioCleanup(options.db, options, take, error);
      }
      throw error;
    }
    return { transcriptId: existing.id, deduplicated: true };
  }

  const normalized = await (options.normalize ?? normalizeAudio)(originalAudio);
  const transcript = await options.transcriber.transcribe({ audio: normalized, filename: `${take.id}.wav` });
  const [model] = await options.db.select().from(playModels).where(and(
    eq(playModels.id, take.playModelId),
    eq(playModels.ownerUserId, options.ownerUserId),
    eq(playModels.version, take.playModelVersion),
  )).limit(1);
  if (!model) throw new Error("Pinned play model not found");
  const scene = model.model.acts.flatMap((act) => act.scenes).find(({ id }) => id === take.sceneId);
  if (!scene) throw new Error("Pinned scene not found");
  const roleLines = scene.elements
    .filter((element) => element.kind === "dialogue" && element.characterId === take.roleId)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((element) => ({ elementId: element.id, ordinal: element.ordinal, text: element.text }));
  const alignments = alignScript(roleLines, transcript.words);
  const uncertaintyRegions: UncertaintyRegion[] = alignments
    .filter((alignment) => transcript.timingSource === "unavailable" || alignment.status === "uncertain")
    .map((alignment) => ({
      elementId: alignment.elementId,
      startMs: alignment.transcriptStartMs,
      endMs: alignment.transcriptEndMs,
      reason: transcript.timingSource !== "whisper_word_timestamps"
        && alignment.transcriptStartMs === null ? "missing_timing" : "low_similarity",
    }));
  const transcriptId = (options.createId ?? randomUUID)();
  let normalizedReservation = options.normalizedAudioStorage && isSupportedLanguage(transcript.language)
    ? await reserveNormalizedAudioIdentity(options.db, options, take, transcriptId)
    : null;
  let reboundReservation = false;

  for (;;) {
    try {
      return await options.db.transaction(async (transaction) => {
    await assertActiveJobLease(transaction, options.ownerUserId, job.id, options);
    const concurrent = await findDedupe(transaction, options.ownerUserId, take.id, audioSha256,
      options.transcriber.version);
    if (concurrent) {
      await promoteTranscript(transaction, options.ownerUserId, take.id, concurrent.id, options.now);
      if (options.normalizedAudioStorage && isSupportedLanguage(concurrent.language)) {
        if (!normalizedReservation || normalizedReservation.transcriptId !== concurrent.id) {
          throw new NormalizedAudioReservationMismatchError(concurrent.id);
        }
        await publishMeasurementHandoff(transaction, options, take, concurrent.id, normalized,
          normalizedReservation);
      }
      await finalize(transaction, options.ownerUserId, job.id, take.id, concurrent.language,
        concurrent.timingSource, options.now);
      return { transcriptId: concurrent.id, deduplicated: true };
    }
    await transaction.update(takeTranscripts).set({ status: "stale", updatedAt: options.now ?? new Date() })
      .where(and(eq(takeTranscripts.ownerUserId, options.ownerUserId), eq(takeTranscripts.takeId, take.id),
        eq(takeTranscripts.status, "current")));
    await transaction.insert(takeTranscripts).values({
      id: transcriptId,
      ownerUserId: options.ownerUserId,
      takeId: take.id,
      audioSha256,
      transcriberVersion: options.transcriber.version,
      provider: transcript.provider,
      modelName: transcript.modelName,
      language: transcript.language,
      text: transcript.text,
      timingSource: transcript.timingSource,
      status: "current",
    });
    if (transcript.words.length > 0) await transaction.insert(transcriptWords).values(
      transcript.words.map((word, index) => ({ ownerUserId: options.ownerUserId, transcriptId,
        ordinal: index + 1, text: word.text, startMs: word.startMs, endMs: word.endMs,
        confidence: word.confidence })),
    );
    if (alignments.length > 0) await transaction.insert(lineAlignments).values(alignments.map((alignment) => ({
      ownerUserId: options.ownerUserId, transcriptId, ...alignment,
    })));
    if (uncertaintyRegions.length > 0) await transaction.insert(transcriptUncertaintyRegions).values(
      uncertaintyRegions.map((region, index) => ({ ownerUserId: options.ownerUserId, transcriptId,
        ordinal: index + 1, elementId: region.elementId, startMs: region.startMs, endMs: region.endMs,
        reason: region.reason })),
    );
    if (options.normalizedAudioStorage && isSupportedLanguage(transcript.language)) {
      await publishMeasurementHandoff(transaction, options, take, transcriptId, normalized,
        normalizedReservation!);
    }
    await finalize(transaction, options.ownerUserId, job.id, take.id, transcript.language,
      transcript.timingSource, options.now);
    return { transcriptId, deduplicated: false };
      });
    } catch (error) {
      if (error instanceof NormalizedAudioReservationMismatchError && options.normalizedAudioStorage
        && !reboundReservation) {
        if (normalizedReservation) {
          await releaseNormalizedAudioIdentity(options.db, options.ownerUserId, normalizedReservation.dedupeKey);
        }
        normalizedReservation = await reserveNormalizedAudioIdentity(options.db, options, take, error.transcriptId);
        reboundReservation = true;
        continue;
      }
      if (error instanceof ExactVersionCompensatedError && normalizedReservation) {
        await releaseNormalizedAudioIdentity(options.db, options.ownerUserId, normalizedReservation.dedupeKey);
        throw error.originalError;
      }
      if (error instanceof ExactVersionCleanupRequiredError) {
        await recordNormalizedAudioCleanup(options.db, options, take, error);
      }
      throw error;
    }
  }
}

async function publishMeasurementHandoff<TQueryResult extends PgQueryResultHKT>(
  db: JobDatabase<TQueryResult>,
  options: RunTranscribeTakeJobOptions<TQueryResult>,
  take: typeof takes.$inferSelect,
  transcriptId: string,
  normalizedAudio: Uint8Array,
  reservation: NormalizedAudioIdentity,
): Promise<void> {
  const storage = options.normalizedAudioStorage!;
  const canonicalObjectKey = reservation.objectKey;
  await assertCurrentProcessTakeChain(db, options, take, transcriptId);
  const [existing] = await db.select().from(normalizedAudioArtifacts).where(and(
    eq(normalizedAudioArtifacts.ownerUserId, options.ownerUserId),
    eq(normalizedAudioArtifacts.takeId, take.id),
    eq(normalizedAudioArtifacts.transcriptId, transcriptId),
    eq(normalizedAudioArtifacts.transcriptStatus, "current"),
  )).limit(1);
  const registration = existing ? { artifact: existing, uploaded: null }
    : await writeAndRegisterNormalizedAudio(db, options, take, transcriptId, canonicalObjectKey,
      normalizedAudio, storage);
  try {
    await assertCurrentProcessTakeChain(db, options, take, transcriptId);
    const [insertedJob] = await db.insert(jobs).values({
      ownerUserId: options.ownerUserId,
      playId: take.playId,
      kind: "measure_take",
      dedupeKey: `measure_take:${transcriptId}`,
      payload: { takeId: take.id, transcriptId, normalizedAudioArtifactId: registration.artifact.id },
    }).onConflictDoNothing().returning({ id: jobs.id });
    const [measurementJob] = insertedJob ? [insertedJob] : await db.select({ id: jobs.id }).from(jobs).where(and(
      eq(jobs.ownerUserId, options.ownerUserId),
      eq(jobs.dedupeKey, `measure_take:${transcriptId}`),
      eq(jobs.kind, "measure_take"),
    )).limit(1);
    if (!measurementJob) throw new Error("Measurement job publication failed");
    await db.insert(takeStageJobChains).values({
      jobId: measurementJob.id,
      ownerUserId: options.ownerUserId,
      playId: take.playId,
      takeId: take.id,
      transcriptId,
      transcriptStatus: "current",
      stageKind: "measure_take",
    }).onConflictDoNothing();
    await db.delete(jobs).where(and(eq(jobs.ownerUserId, options.ownerUserId),
      eq(jobs.kind, "delete_private_object"), eq(jobs.dedupeKey, reservation.dedupeKey)));
  } catch (error) {
    if (registration.uploaded) {
      await compensateNormalizedAudio(storage, transcriptId, registration.uploaded, error);
      throw new ExactVersionCompensatedError(error);
    }
    throw error;
  }
}

async function writeAndRegisterNormalizedAudio<TQueryResult extends PgQueryResultHKT>(
  db: JobDatabase<TQueryResult>, options: RunTranscribeTakeJobOptions<TQueryResult>,
  take: typeof takes.$inferSelect, transcriptId: string, canonicalObjectKey: string,
  normalizedAudio: Uint8Array, storage: ObjectStorage,
) {
  const write = await storage.putPrivateVersioned(canonicalObjectKey, normalizedAudio, "audio/wav");
  try {
    await options.afterNormalizedAudioWrite?.(db);
    await assertCurrentProcessTakeChain(db, options, take, transcriptId);
    const [artifact] = await db.insert(normalizedAudioArtifacts).values({
      ownerUserId: options.ownerUserId,
      playId: take.playId,
      takeId: take.id,
      transcriptId,
      transcriptStatus: "current",
      canonicalObjectKey,
      contentSha256: createHash("sha256").update(normalizedAudio).digest("hex"),
      storageVersionToken: write.versionToken,
    }).onConflictDoNothing({ target: [normalizedAudioArtifacts.ownerUserId,
      normalizedAudioArtifacts.takeId, normalizedAudioArtifacts.transcriptId] }).returning();
    if (artifact) return { artifact, uploaded: { objectKey: canonicalObjectKey, storageVersionToken: write.versionToken } };
    const [existing] = await db.select().from(normalizedAudioArtifacts).where(and(
      eq(normalizedAudioArtifacts.ownerUserId, options.ownerUserId),
      eq(normalizedAudioArtifacts.takeId, take.id),
      eq(normalizedAudioArtifacts.transcriptId, transcriptId),
      eq(normalizedAudioArtifacts.transcriptStatus, "current"),
    )).limit(1);
    if (!existing) throw new Error("Normalized audio publication failed");
    await compensateNormalizedAudio(storage, transcriptId,
      { objectKey: canonicalObjectKey, storageVersionToken: write.versionToken });
    return { artifact: existing, uploaded: null };
  } catch (error) {
    await compensateNormalizedAudio(storage, transcriptId,
      { objectKey: canonicalObjectKey, storageVersionToken: write.versionToken }, error);
    throw new ExactVersionCompensatedError(error);
  }
}

async function compensateNormalizedAudio(storage: ObjectStorage, transcriptId: string,
  uploaded: { objectKey: string; storageVersionToken: string }, cause?: unknown): Promise<void> {
  try {
    if (await storage.deletePrivateVersion(uploaded.objectKey, uploaded.storageVersionToken)) return;
  } catch (error) {
    throw new ExactVersionCleanupRequiredError(transcriptId, uploaded.objectKey, uploaded.storageVersionToken, error);
  }
  throw new ExactVersionCleanupRequiredError(transcriptId, uploaded.objectKey, uploaded.storageVersionToken,
    cause ?? new Error("Exact version was not deleted"));
}

async function recordNormalizedAudioCleanup<TQueryResult extends PgQueryResultHKT>(
  db: JobDatabase<TQueryResult>, options: RunTranscribeTakeJobOptions<TQueryResult>,
  take: typeof takes.$inferSelect, cleanup: ExactVersionCleanupRequiredError,
): Promise<void> {
  await db.transaction(async (transaction) => {
    if (!await lockActiveOwner(transaction, options.ownerUserId)) return;
    await transaction.insert(privateObjectCleanupTasks).values({
      ownerUserId: options.ownerUserId,
      playId: take.playId,
      takeId: take.id,
      transcriptId: cleanup.transcriptId,
      transcriptStatus: "attempted",
      sourceJobId: options.jobId,
      sourceAttemptCount: options.attemptCount,
      sourceLeaseToken: options.leaseToken,
      objectKey: cleanup.objectKey,
      storageVersionToken: cleanup.storageVersionToken,
      failureCode: "DB_PUBLICATION_FAILED",
    }).onConflictDoNothing();
  });
}

type NormalizedAudioIdentity = { transcriptId: string; objectKey: string; dedupeKey: string };

async function reserveNormalizedAudioIdentity<TQueryResult extends PgQueryResultHKT>(
  db: JobDatabase<TQueryResult>, options: RunTranscribeTakeJobOptions<TQueryResult>,
  take: typeof takes.$inferSelect, transcriptId: string,
): Promise<NormalizedAudioIdentity> {
  const objectKey = `users/${options.ownerUserId}/plays/${take.playId}/takes/${take.id}`
    + `/transcripts/${transcriptId}/normalized/${options.leaseToken}.wav`;
  const dedupeKey = `delete_private_object:normalized:${options.jobId}:${options.leaseToken}:${transcriptId}`;
  const reserved = await db.transaction(async (transaction) => {
    if (!await lockActiveOwner(transaction, options.ownerUserId)) return false;
    await transaction.insert(jobs).values({ ownerUserId: options.ownerUserId, playId: take.playId,
      kind: "delete_private_object", status: "action_required", errorCode: "PRIVATE_OBJECT_WRITE_RESERVED",
      dedupeKey, payload: { objectKey, reason: "normalized_audio_compensation" } }).onConflictDoNothing();
    return true;
  });
  if (!reserved) throw new Error("ACCOUNT_NOT_ACTIVE");
  return { transcriptId, objectKey, dedupeKey };
}

async function releaseNormalizedAudioIdentity<TQueryResult extends PgQueryResultHKT>(
  db: JobDatabase<TQueryResult>, ownerUserId: string, dedupeKey: string,
): Promise<void> {
  await db.transaction(async (transaction) => {
    if (!await lockActiveOwner(transaction, ownerUserId)) return;
    await transaction.delete(jobs).where(and(eq(jobs.ownerUserId, ownerUserId),
      eq(jobs.kind, "delete_private_object"), eq(jobs.dedupeKey, dedupeKey)));
  });
}

async function assertCurrentProcessTakeChain<TQueryResult extends PgQueryResultHKT>(
  db: JobDatabase<TQueryResult>, options: RunTranscribeTakeJobOptions<TQueryResult>,
  take: typeof takes.$inferSelect, transcriptId: string,
): Promise<void> {
  await assertActiveJobLease(db, options.ownerUserId, options.jobId, options);
  const [stage] = await db.select({ jobId: takeStageJobChains.jobId }).from(takeStageJobChains).where(and(
    eq(takeStageJobChains.jobId, options.jobId),
    eq(takeStageJobChains.ownerUserId, options.ownerUserId),
    eq(takeStageJobChains.playId, take.playId),
    eq(takeStageJobChains.takeId, take.id),
    eq(takeStageJobChains.stageKind, "process_take"),
  )).limit(1);
  if (!stage) throw new Error("Process-take stage chain not found");
  const [current] = await db.select({ id: takeTranscripts.id }).from(takeTranscripts).where(and(
    eq(takeTranscripts.id, transcriptId),
    eq(takeTranscripts.ownerUserId, options.ownerUserId),
    eq(takeTranscripts.takeId, take.id),
    eq(takeTranscripts.status, "current"),
  )).for("update").limit(1);
  if (!current) throw new Error("Transcript is no longer current");
}

async function promoteTranscript<TQueryResult extends PgQueryResultHKT>(
  db: JobDatabase<TQueryResult>,
  ownerUserId: string,
  takeId: string,
  transcriptId: string,
  now = new Date(),
): Promise<void> {
  await db.update(takeTranscripts).set({ status: "stale", updatedAt: now }).where(and(
    eq(takeTranscripts.ownerUserId, ownerUserId),
    eq(takeTranscripts.takeId, takeId),
    eq(takeTranscripts.status, "current"),
    ne(takeTranscripts.id, transcriptId),
  ));
  await db.update(takeTranscripts).set({ status: "current", updatedAt: now }).where(and(
    eq(takeTranscripts.ownerUserId, ownerUserId),
    eq(takeTranscripts.takeId, takeId),
    eq(takeTranscripts.id, transcriptId),
  ));
}

export async function failTranscribeTakeJob<TQueryResult extends PgQueryResultHKT>(options: {
  db: JobDatabase<TQueryResult>;
  ownerUserId: string;
  jobId: string;
  leaseToken: string;
  attemptCount: number;
  code: string;
  now?: Date;
}): Promise<void> {
  await options.db.transaction(async (transaction) => {
    const failed = await failJob({ ...options, db: transaction });
    if (failed.status !== "action_required") return;
    const takeId = failed.payload.takeId;
    if (typeof takeId !== "string") throw new Error("Process-take job has no take");
    const changed = await transaction.update(takes).set({ state: "action_required",
      updatedAt: options.now ?? new Date() }).where(and(
      eq(takes.id, takeId), eq(takes.ownerUserId, options.ownerUserId), ne(takes.state, "action_required"),
    )).returning({ id: takes.id });
    if (changed.length > 0) await transaction.insert(takeEvents).values({
      ownerUserId: options.ownerUserId,
      takeId,
      state: "action_required",
      details: { code: options.code },
    });
  });
}

async function markProcessing<TQueryResult extends PgQueryResultHKT>(
  db: JobDatabase<TQueryResult>, ownerUserId: string, takeId: string,
  lease: { jobId: string; leaseToken: string; attemptCount: number },
): Promise<void> {
  await db.transaction(async (transaction) => {
    await assertActiveJobLease(transaction, ownerUserId, lease.jobId, lease);
    const updated = await transaction.update(takes).set({ state: "processing", updatedAt: new Date() }).where(and(
      eq(takes.id, takeId), eq(takes.ownerUserId, ownerUserId), eq(takes.state, "queued"),
    )).returning({ id: takes.id });
    if (updated.length > 0) await transaction.insert(takeEvents).values({
      ownerUserId, takeId, state: "processing", details: {},
    });
  });
}

async function findDedupe<TQueryResult extends PgQueryResultHKT>(
  db: JobDatabase<TQueryResult>, ownerUserId: string, takeId: string, audioSha256: string,
  transcriberVersion: string,
) {
  const [transcript] = await db.select().from(takeTranscripts).where(and(
    eq(takeTranscripts.ownerUserId, ownerUserId),
    eq(takeTranscripts.takeId, takeId),
    eq(takeTranscripts.audioSha256, audioSha256),
    eq(takeTranscripts.transcriberVersion, transcriberVersion),
  )).limit(1);
  return transcript ?? null;
}

async function finalize<TQueryResult extends PgQueryResultHKT>(
  db: JobDatabase<TQueryResult>, ownerUserId: string, jobId: string, takeId: string,
  language: string, timingSource: Transcript["timingSource"], now = new Date(),
): Promise<void> {
  const supportedLanguage = isSupportedLanguage(language);
  const takeState: TakeState = !supportedLanguage
    ? "action_required"
    : timingSource !== "whisper_word_timestamps" ? "completed_with_limitations" : "completed";
  const details = supportedLanguage ? {} : { code: "UNSUPPORTED_LANGUAGE" };
  const changed = await db.update(takes).set({ state: takeState, updatedAt: now }).where(and(
    eq(takes.id, takeId), eq(takes.ownerUserId, ownerUserId), ne(takes.state, takeState),
  )).returning({ id: takes.id });
  if (changed.length > 0) await db.insert(takeEvents).values({ ownerUserId, takeId, state: takeState, details });
  await db.update(jobs).set({
    status: supportedLanguage ? "completed" : "action_required",
    errorCode: supportedLanguage ? null : "UNSUPPORTED_LANGUAGE",
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: now,
  }).where(and(eq(jobs.id, jobId), eq(jobs.ownerUserId, ownerUserId)));
}

function isSupportedLanguage(language: string): boolean {
  return language.toLowerCase() === "english" || language.toLowerCase() === "en"
    || language.toLowerCase().startsWith("en-");
}
