import { createHash } from "node:crypto";

import * as schema from "@drama/db/schema";
import { publishMeasurementCurrent } from "@drama/db/repositories/measurements";
import { cueResponseEvidence, jobs, lineAlignments, normalizedAudioArtifacts, playModels, rehearsalEvents,
  rehearsalSessions, takeEvents, takeStageJobChains, takeTranscripts, takes, transcriptWords } from "@drama/db/schema";
import { createRehearsalState } from "@drama/domain/rehearsal/controller";
import { CUE_RESPONSE_VERSION, measureCueResponse, type CueResponseEvidence,
  type CueResponseTimelineEvent } from "@drama/domain/rehearsal/cue-response";
import { reduceRehearsal } from "@drama/domain/rehearsal/reducer";
import type { TakeMetrics } from "@drama/domain/audio-metrics";
import { decodeWav, WavDecodeError } from "@drama/media/audio/decode-wav";
import { measureTake } from "@drama/media/audio/metrics";
import type { ObjectStorage } from "@drama/storage/port";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { assertActiveJobLease, failJob, type JobLease, StaleJobLeaseError } from "./claim";

type JobDatabase<TQueryResult extends PgQueryResultHKT> = PgDatabase<TQueryResult, typeof schema>;

type RunMeasureTakeJobOptions<TQueryResult extends PgQueryResultHKT> = {
  db: JobDatabase<TQueryResult>;
  ownerUserId: string;
  jobId: string;
  leaseToken: string;
  attemptCount: number;
  normalizedAudioStorage: ObjectStorage;
  measurementVersion?: string;
  afterAudioLoad?: (db: JobDatabase<TQueryResult>) => Promise<void>;
  now?: Date;
};

export class InvalidMeasurementChainError extends Error {
  readonly code = "INVALID_MEASUREMENT_CHAIN";

  constructor() {
    super("Measurement job no longer proves one current owner/take/transcript/artifact chain");
    this.name = "InvalidMeasurementChainError";
  }
}

export class NormalizedAudioIntegrityError extends Error {
  readonly code = "NORMALIZED_AUDIO_INTEGRITY_FAILURE";

  constructor() {
    super("Registered normalized audio does not match its immutable content hash");
    this.name = "NormalizedAudioIntegrityError";
  }
}

export class MalformedNormalizedWavError extends Error {
  readonly code = "MALFORMED_NORMALIZED_WAV";

  constructor(cause: unknown) {
    super("Registered normalized audio is not a supported WAV", { cause });
    this.name = "MalformedNormalizedWavError";
  }
}

export async function runMeasureTakeJob<TQueryResult extends PgQueryResultHKT>(
  options: RunMeasureTakeJobOptions<TQueryResult>,
): Promise<{ measurementId: string; deduplicated: boolean }> {
  const beforeLoad = await options.db.transaction((transaction) => assertMeasurementChain(transaction, options));
  const bytes = options.normalizedAudioStorage.getPrivateVersion
    ? await options.normalizedAudioStorage.getPrivateVersion(beforeLoad.artifact.canonicalObjectKey,
      beforeLoad.artifact.storageVersionToken)
    : await options.normalizedAudioStorage.getPrivate(beforeLoad.artifact.canonicalObjectKey);
  if (createHash("sha256").update(bytes).digest("hex") !== beforeLoad.artifact.contentSha256) {
    throw new NormalizedAudioIntegrityError();
  }
  let wav: ReturnType<typeof decodeWav>;
  try {
    wav = decodeWav(bytes);
  } catch (error) {
    if (error instanceof WavDecodeError) throw new MalformedNormalizedWavError(error);
    throw error;
  }
  await options.afterAudioLoad?.(options.db);
  const metrics = measureTake(wav.samples, {
    sampleRate: wav.sampleRate,
    alignments: beforeLoad.alignments,
    wordCount: beforeLoad.wordCount,
  });

  return options.db.transaction(async (transaction) => {
    const chain = await assertMeasurementChain(transaction, options);
    if (chain.artifact.id !== beforeLoad.artifact.id
      || chain.artifact.storageVersionToken !== beforeLoad.artifact.storageVersionToken
      || chain.artifact.contentSha256 !== beforeLoad.artifact.contentSha256
      || chain.take.rehearsalSessionId !== beforeLoad.take.rehearsalSessionId) {
      throw new InvalidMeasurementChainError();
    }
    const publication = await publishMeasurementCurrent(transaction, {
      ownerUserId: options.ownerUserId,
      takeId: chain.takeId,
      transcriptId: chain.transcriptId,
      measurementVersion: options.measurementVersion ?? "measure-v1",
      metrics,
    });
    if (chain.take.rehearsalSessionId) {
      const rehearsalSessionId = chain.take.rehearsalSessionId;
      // Cue timing is supplementary coaching evidence. Isolate it behind a
      // savepoint so malformed legacy rehearsal timelines cannot prevent the
      // valid audio measurement and coaching pipeline from completing.
      await transaction.transaction(async (cueTransaction) => {
        const cueDb = cueTransaction as JobDatabase<TQueryResult>;
        const cueEvidence = await loadCueResponseEvidence(cueDb, chain.take);
        await cueDb.insert(cueResponseEvidence).values({ ownerUserId: options.ownerUserId,
          takeId: chain.take.id, rehearsalSessionId,
          measurementVersion: cueEvidence.version, cueEventId: cueEvidence.cueEventId,
          actorEventId: cueEvidence.actorEventId, clockId: cueEvidence.clockId,
          delayMs: cueEvidence.delayMs, confidence: cueEvidence.confidence, score: cueEvidence.score,
        }).onConflictDoUpdate({ target: [cueResponseEvidence.ownerUserId, cueResponseEvidence.takeId,
          cueResponseEvidence.measurementVersion], set: { cueEventId: cueEvidence.cueEventId,
          actorEventId: cueEvidence.actorEventId, clockId: cueEvidence.clockId,
          delayMs: cueEvidence.delayMs, confidence: cueEvidence.confidence, score: cueEvidence.score,
          updatedAt: options.now ?? new Date() } });
      }).catch(() => undefined);
    }
    const reviewDedupeKey = `review_audio:${chain.transcriptId}:${publication.measurement.measurementVersion}`;
    const [insertedReview] = await transaction.insert(jobs).values({
      ownerUserId: options.ownerUserId,
      playId: chain.artifact.playId,
      kind: "review_audio",
      dedupeKey: reviewDedupeKey,
      availableAt: options.now ?? new Date(),
      payload: { takeId: chain.takeId, transcriptId: chain.transcriptId,
        measurementId: publication.measurement.id, normalizedAudioArtifactId: chain.artifact.id },
    }).onConflictDoNothing().returning({ id: jobs.id });
    const [reviewJob] = insertedReview ? [insertedReview]
      : await transaction.select({ id: jobs.id }).from(jobs).where(and(
        eq(jobs.ownerUserId, options.ownerUserId), eq(jobs.dedupeKey, reviewDedupeKey),
        eq(jobs.kind, "review_audio"),
      )).limit(1);
    if (!reviewJob) throw new Error("AUDIO_REVIEW_HANDOFF_FAILED");
    await transaction.insert(takeStageJobChains).values({ jobId: reviewJob.id,
      ownerUserId: options.ownerUserId, playId: chain.artifact.playId, takeId: chain.takeId,
      transcriptId: chain.transcriptId, transcriptStatus: "current", stageKind: "review_audio",
    }).onConflictDoNothing();
    const [completed] = await transaction.update(jobs).set({
      status: "completed",
      errorCode: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: options.now ?? new Date(),
    }).where(and(
      eq(jobs.id, options.jobId),
      eq(jobs.ownerUserId, options.ownerUserId),
      eq(jobs.status, "running"),
      eq(jobs.attemptCount, options.attemptCount),
      eq(jobs.leaseToken, options.leaseToken),
    )).returning({ id: jobs.id });
    if (!completed) throw new StaleJobLeaseError();
    return { measurementId: publication.measurement.id, deduplicated: publication.deduplicated };
  });
}

export async function failMeasureTakeJob<TQueryResult extends PgQueryResultHKT>(options: {
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
    if (typeof takeId !== "string") throw new InvalidMeasurementChainError();
    const changed = await transaction.update(takes).set({ state: "action_required",
      updatedAt: options.now ?? new Date() }).where(and(
      eq(takes.id, takeId), eq(takes.ownerUserId, options.ownerUserId), ne(takes.state, "action_required"),
    )).returning({ id: takes.id });
    if (changed.length > 0) await transaction.insert(takeEvents).values({
      ownerUserId: options.ownerUserId, takeId, state: "action_required", details: { code: options.code },
    });
  });
}

/** Publishes conservative, explicitly insufficient metrics when optional signal analysis fails unexpectedly. */
export async function runLimitedMeasureTakeJob<TQueryResult extends PgQueryResultHKT>(
  options: RunMeasureTakeJobOptions<TQueryResult>,
): Promise<{ measurementId: string }> {
  return options.db.transaction(async (transaction) => {
    const chain = await assertMeasurementChain(transaction, options);
    const metrics: TakeMetrics = { durationMs: chain.take.durationMs, speechDurationMs: 0,
      silenceDurationMs: chain.take.durationMs, pauses: [], alignmentCoverage: 0, clippingRatio: 0,
      technicalWarnings: ["LOW_ALIGNMENT_COVERAGE"], wordsPerMinute: null,
      pace: { wordsPerMinute: null, wordCount: chain.wordCount, confidence: "insufficient_data", score: null },
      loudness: { rmsDb: -120, rangeDb: 0, confidence: "insufficient_data", score: null },
      pitch: { medianHz: null, rangeHz: null, voicedFrames: 0, confidence: "insufficient_data", score: null },
      lines: [] };
    const publication = await publishMeasurementCurrent(transaction, { ownerUserId: options.ownerUserId,
      takeId: chain.takeId, transcriptId: chain.transcriptId, measurementVersion: "measure-v1-limited", metrics });
    const dedupeKey = `review_audio:${chain.transcriptId}:${publication.measurement.measurementVersion}`;
    const [inserted] = await transaction.insert(jobs).values({ ownerUserId: options.ownerUserId,
      playId: chain.artifact.playId, kind: "review_audio", dedupeKey, availableAt: options.now ?? new Date(),
      payload: { takeId: chain.takeId, transcriptId: chain.transcriptId,
        measurementId: publication.measurement.id, normalizedAudioArtifactId: chain.artifact.id },
    }).onConflictDoNothing().returning({ id: jobs.id });
    const [review] = inserted ? [inserted] : await transaction.select({ id: jobs.id }).from(jobs).where(and(
      eq(jobs.ownerUserId, options.ownerUserId), eq(jobs.kind, "review_audio"), eq(jobs.dedupeKey, dedupeKey),
    )).limit(1);
    if (!review) throw new Error("AUDIO_REVIEW_HANDOFF_FAILED");
    await transaction.insert(takeStageJobChains).values({ jobId: review.id, ownerUserId: options.ownerUserId,
      playId: chain.artifact.playId, takeId: chain.takeId, transcriptId: chain.transcriptId,
      transcriptStatus: "current", stageKind: "review_audio" }).onConflictDoNothing();
    const [completed] = await transaction.update(jobs).set({ status: "completed_with_limitations",
      errorCode: null, leaseToken: null, leaseExpiresAt: null, updatedAt: options.now ?? new Date() }).where(and(
      eq(jobs.id, options.jobId), eq(jobs.ownerUserId, options.ownerUserId), eq(jobs.status, "running"),
      eq(jobs.attemptCount, options.attemptCount), eq(jobs.leaseToken, options.leaseToken),
    )).returning({ id: jobs.id });
    if (!completed) throw new StaleJobLeaseError();
    return { measurementId: publication.measurement.id };
  });
}

async function assertMeasurementChain<TQueryResult extends PgQueryResultHKT>(
  db: JobDatabase<TQueryResult>, options: RunMeasureTakeJobOptions<TQueryResult>,
) {
  const lease: JobLease = { leaseToken: options.leaseToken, attemptCount: options.attemptCount };
  await assertActiveJobLease(db, options.ownerUserId, options.jobId, lease);
  const [job] = await db.select({ playId: jobs.playId, payload: jobs.payload }).from(jobs).where(and(
    eq(jobs.id, options.jobId), eq(jobs.ownerUserId, options.ownerUserId), eq(jobs.kind, "measure_take"),
  )).limit(1);
  const payload = job?.payload;
  if (!job || typeof job.playId !== "string" || !isMeasurePayload(payload)) throw new InvalidMeasurementChainError();
  const [stage] = await db.select().from(takeStageJobChains).where(and(
    eq(takeStageJobChains.jobId, options.jobId),
    eq(takeStageJobChains.ownerUserId, options.ownerUserId),
    eq(takeStageJobChains.playId, job.playId),
    eq(takeStageJobChains.takeId, payload.takeId),
    eq(takeStageJobChains.transcriptId, payload.transcriptId),
    eq(takeStageJobChains.transcriptStatus, "current"),
    eq(takeStageJobChains.stageKind, "measure_take"),
  )).limit(1);
  const [transcript] = await db.select({ id: takeTranscripts.id }).from(takeTranscripts).where(and(
    eq(takeTranscripts.id, payload.transcriptId), eq(takeTranscripts.ownerUserId, options.ownerUserId),
    eq(takeTranscripts.takeId, payload.takeId), eq(takeTranscripts.status, "current"),
  )).for("update").limit(1);
  const [artifact] = await db.select().from(normalizedAudioArtifacts).where(and(
    eq(normalizedAudioArtifacts.id, payload.normalizedAudioArtifactId),
    eq(normalizedAudioArtifacts.ownerUserId, options.ownerUserId), eq(normalizedAudioArtifacts.playId, job.playId),
    eq(normalizedAudioArtifacts.takeId, payload.takeId), eq(normalizedAudioArtifacts.transcriptId, payload.transcriptId),
    eq(normalizedAudioArtifacts.transcriptStatus, "current"),
  )).for("update").limit(1);
  const [take] = await db.select().from(takes).where(and(eq(takes.id, payload.takeId),
    eq(takes.ownerUserId, options.ownerUserId), eq(takes.playId, job.playId))).limit(1);
  if (!stage || !transcript || !artifact || !take) throw new InvalidMeasurementChainError();
  if (take.rehearsalSessionId) {
    const [matching] = await db.select({ id: rehearsalSessions.id }).from(rehearsalSessions).where(and(
      eq(rehearsalSessions.id, take.rehearsalSessionId), eq(rehearsalSessions.ownerUserId, options.ownerUserId),
      eq(rehearsalSessions.playId, take.playId), eq(rehearsalSessions.playModelId, take.playModelId),
      eq(rehearsalSessions.playModelVersion, take.playModelVersion), eq(rehearsalSessions.sceneId, take.sceneId),
      eq(rehearsalSessions.actorRoleId, take.roleId), inArray(rehearsalSessions.state, ["completed", "stopped"]),
    )).limit(1);
    if (!matching) throw new InvalidMeasurementChainError();
  }
  const alignments = await db.select({ elementId: lineAlignments.elementId, scriptOrdinal: lineAlignments.scriptOrdinal,
    transcriptStartMs: lineAlignments.transcriptStartMs, transcriptEndMs: lineAlignments.transcriptEndMs,
    similarity: lineAlignments.similarity, status: lineAlignments.status }).from(lineAlignments).where(and(
    eq(lineAlignments.ownerUserId, options.ownerUserId), eq(lineAlignments.transcriptId, payload.transcriptId),
  )).orderBy(lineAlignments.scriptOrdinal);
  const words = await db.select({ id: transcriptWords.id }).from(transcriptWords).where(and(
    eq(transcriptWords.ownerUserId, options.ownerUserId), eq(transcriptWords.transcriptId, payload.transcriptId),
  ));
  return { takeId: payload.takeId, transcriptId: payload.transcriptId, take, artifact, alignments,
    wordCount: words.length };
}

async function loadCueResponseEvidence<TQueryResult extends PgQueryResultHKT>(
  db: JobDatabase<TQueryResult>, take: typeof takes.$inferSelect,
): Promise<CueResponseEvidence> {
  const low = (): CueResponseEvidence => ({ version: CUE_RESPONSE_VERSION, cueEventId: null,
    actorEventId: null, clockId: null, delayMs: null, confidence: "low", score: null });
  if (!take.rehearsalSessionId) return low();
  const [session] = await db.select().from(rehearsalSessions).where(and(
    eq(rehearsalSessions.id, take.rehearsalSessionId), eq(rehearsalSessions.ownerUserId, take.ownerUserId),
    eq(rehearsalSessions.playId, take.playId), eq(rehearsalSessions.playModelId, take.playModelId),
    eq(rehearsalSessions.playModelVersion, take.playModelVersion), eq(rehearsalSessions.sceneId, take.sceneId),
    eq(rehearsalSessions.actorRoleId, take.roleId), inArray(rehearsalSessions.state, ["completed", "stopped"]),
  )).for("update").limit(1);
  if (!session) throw new InvalidMeasurementChainError();
  const [modelRow] = await db.select({ model: playModels.model }).from(playModels).where(and(
    eq(playModels.id, take.playModelId), eq(playModels.ownerUserId, take.ownerUserId),
    eq(playModels.version, take.playModelVersion))).limit(1);
  const scene = modelRow?.model.acts.flatMap(({ scenes }) => scenes).find(({ id }) => id === take.sceneId);
  if (!scene) throw new InvalidMeasurementChainError();
  const lines = scene.elements.filter((element) => element.kind === "dialogue")
    .sort((left, right) => left.ordinal - right.ordinal);
  const stateLines = lines.map((element) => ({ elementId: element.id, ordinal: element.ordinal,
    characterId: element.characterId, text: element.text }));
  const rows = await db.select({ id: rehearsalEvents.id, sequence: rehearsalEvents.sequence,
    event: rehearsalEvents.event, timingSource: rehearsalEvents.timingSource,
    timingAtMs: rehearsalEvents.timingAtMs, timingClockId: rehearsalEvents.timingClockId })
    .from(rehearsalEvents).where(and(
    eq(rehearsalEvents.ownerUserId, take.ownerUserId),
    eq(rehearsalEvents.rehearsalSessionId, take.rehearsalSessionId),
  )).orderBy(asc(rehearsalEvents.sequence));
  let state = createRehearsalState({ sessionId: take.rehearsalSessionId,
    actorRoleId: take.roleId, lines: stateLines });
  const timeline: CueResponseTimelineEvent[] = [];
  try {
    for (const row of rows) {
      const event = row.event;
      if (event.type === "ai_speech_finished") timeline.push({ id: row.id, sequence: row.sequence,
        type: "ai_speech_finished", elementId: event.elementId,
        timestamp: eventTimestamp(row) });
      if (event.type === "actor_line_final" && state.cursorElementId) {
        timeline.push({ id: row.id, sequence: row.sequence, type: "actor_line_completed",
          elementId: state.cursorElementId,
          timestamp: eventTimestamp(row) });
      }
      if (event.type === "manual_actor_line_completed") timeline.push({ id: row.id, sequence: row.sequence,
        type: "actor_line_completed", elementId: event.elementId,
        timestamp: eventTimestamp(row) });
      state = reduceRehearsal(state, event);
    }
  } catch {
    return low();
  }
  let fallback: CueResponseEvidence | null = null;
  for (const cue of timeline.filter((event) => event.type === "ai_speech_finished")) {
    const cueIndex = lines.findIndex(({ id }) => id === cue.elementId);
    const actor = cueIndex < 0 ? undefined : lines.slice(cueIndex + 1)
      .find(({ characterId }) => characterId === take.roleId);
    if (!actor) continue;
    const measured = measureCueResponse({ cueElementId: cue.elementId, actorElementId: actor.id,
      events: timeline });
    if (measured.confidence !== "low") return measured;
    fallback ??= measured;
  }
  return fallback ?? low();
}

function eventTimestamp(row: { timingSource: "provider-derived" | "server-receipt" | null;
  timingAtMs: number | null; timingClockId: string | null }) {
  if (!row.timingSource || row.timingAtMs === null || !Number.isFinite(row.timingAtMs)
    || !row.timingClockId) return null;
  return { atMs: row.timingAtMs, source: row.timingSource, clockId: row.timingClockId };
}

function isMeasurePayload(payload: unknown): payload is {
  takeId: string;
  transcriptId: string;
  normalizedAudioArtifactId: string;
} {
  if (!payload || typeof payload !== "object") return false;
  const value = payload as Record<string, unknown>;
  return typeof value.takeId === "string" && typeof value.transcriptId === "string"
    && typeof value.normalizedAudioArtifactId === "string";
}
