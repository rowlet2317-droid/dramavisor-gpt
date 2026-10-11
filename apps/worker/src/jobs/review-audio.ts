import { createHash } from "node:crypto";

import type { AudioReviewer, AudioReviewRequest } from "@drama/ai/audio-review/port";
import * as schema from "@drama/db/schema";
import { analysisArtifacts, coachingReports, jobs, lineAlignments, normalizedAudioArtifacts, playModels,
  takeMetrics, takeStageJobChains, takeTranscripts, takes } from "@drama/db/schema";
import { transcriptWords } from "@drama/db/schema";
import { calculateLineAccuracy, CoachingEvidenceSchema, type CoachingEvidence, type CoachingConfidence }
  from "@drama/domain/coaching";
import { decodeWav } from "@drama/media/audio/decode-wav";
import { RoleWorkbookSchema } from "@drama/domain/study";
import type { ObjectStorage } from "@drama/storage/port";
import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { assertActiveJobLease, failJob, type JobLease, StaleJobLeaseError } from "./claim";

type JobDatabase<TQueryResult extends PgQueryResultHKT> = PgDatabase<TQueryResult, typeof schema>;

type ReviewOptions<TQueryResult extends PgQueryResultHKT> = JobLease & {
  db: JobDatabase<TQueryResult>;
  ownerUserId: string;
  jobId: string;
  reviewer: AudioReviewer;
  normalizedAudioStorage: ObjectStorage;
  now?: Date;
};

type FailureOptions<TQueryResult extends PgQueryResultHKT> = JobLease & {
  db: JobDatabase<TQueryResult>;
  ownerUserId: string;
  jobId: string;
  code: string;
  now?: Date;
};

export async function runReviewAudioJob<TQueryResult extends PgQueryResultHKT>(
  options: ReviewOptions<TQueryResult>,
): Promise<{ coachingReportId: string }> {
  const chain = await options.db.transaction((transaction) => loadReviewChain(transaction, options));
  const audio = chain.artifact && options.normalizedAudioStorage.getPrivateVersion
    ? await options.normalizedAudioStorage.getPrivateVersion(chain.artifact.canonicalObjectKey,
      chain.artifact.storageVersionToken)
    : await options.normalizedAudioStorage.getPrivate(chain.artifact.canonicalObjectKey);
  if (createHash("sha256").update(audio).digest("hex") !== chain.artifact.contentSha256) {
    throw new Error("NORMALIZED_AUDIO_INTEGRITY_FAILURE");
  }

  const decoded = decodeWav(audio);
  const audioDurationMs = Math.round(decoded.samples.length / decoded.sampleRate * 1_000);
  const request = audioRequest(chain, audioDurationMs);
  const baseEvidence = deterministicEvidence(chain, request.lines);
  const [record] = await options.db.insert(coachingReports).values({
    ownerUserId: options.ownerUserId,
    playId: chain.playId,
    takeId: chain.take.id,
    transcriptId: chain.transcript.id,
    transcriptStatus: "current",
    measurementId: chain.measurement.id,
    status: "processing",
    audioReviewStatus: "pending",
    evidence: baseEvidence,
    report: null,
    updatedAt: options.now ?? new Date(),
  }).onConflictDoUpdate({ target: [coachingReports.ownerUserId, coachingReports.takeId,
    coachingReports.transcriptId], set: { measurementId: chain.measurement.id, status: "processing",
    audioReviewStatus: "pending", evidence: baseEvidence, report: null, synthesisErrorCode: null,
    updatedAt: options.now ?? new Date() } }).returning();
  if (!record) throw new Error("COACHING_EVIDENCE_PUBLICATION_FAILED");

  const observations = validateAudioEvidence(
    await options.reviewer.review({ ...request, audio }), request, chain.alignments,
  );
  await options.db.transaction(async (transaction) => {
    await assertActiveJobLease(transaction, options.ownerUserId, options.jobId, options);
    await assertCurrentTranscript(transaction, options.ownerUserId, chain.take.id, chain.transcript.id);
    await transaction.update(coachingReports).set({ evidence: [...baseEvidence, ...observations],
      audioReviewStatus: "completed", updatedAt: options.now ?? new Date() }).where(and(
      eq(coachingReports.id, record.id), eq(coachingReports.ownerUserId, options.ownerUserId),
      eq(coachingReports.transcriptStatus, "current"),
    ));
    await enqueueSynthesis(transaction, chain, options.now);
    const [completed] = await transaction.update(jobs).set({ status: "completed", errorCode: null,
      leaseToken: null, leaseExpiresAt: null, updatedAt: options.now ?? new Date() }).where(and(
      eq(jobs.id, options.jobId), eq(jobs.ownerUserId, options.ownerUserId), eq(jobs.status, "running"),
      eq(jobs.attemptCount, options.attemptCount), eq(jobs.leaseToken, options.leaseToken),
    )).returning({ id: jobs.id });
    if (!completed) throw new StaleJobLeaseError();
  });
  return { coachingReportId: record.id };
}

export async function failReviewAudioJob<TQueryResult extends PgQueryResultHKT>(
  options: FailureOptions<TQueryResult>,
) {
  if (options.attemptCount < 2) return failJob(options);
  return options.db.transaction(async (transaction) => {
    const chain = await loadReviewChain(transaction, options);
    const [record] = await transaction.update(coachingReports).set({ audioReviewStatus: "failed",
      updatedAt: options.now ?? new Date() }).where(and(eq(coachingReports.ownerUserId, options.ownerUserId),
      eq(coachingReports.takeId, chain.take.id), eq(coachingReports.transcriptId, chain.transcript.id),
      eq(coachingReports.transcriptStatus, "current"))).returning();
    if (!record) throw new Error("COACHING_EVIDENCE_NOT_FOUND");
    await enqueueSynthesis(transaction, chain, options.now);
    const [completed] = await transaction.update(jobs).set({ status: "completed_with_limitations",
      errorCode: options.code, leaseToken: null, leaseExpiresAt: null,
      updatedAt: options.now ?? new Date() }).where(and(
      eq(jobs.id, options.jobId), eq(jobs.ownerUserId, options.ownerUserId), eq(jobs.status, "running"),
      eq(jobs.attemptCount, options.attemptCount), eq(jobs.leaseToken, options.leaseToken),
    )).returning();
    if (!completed) throw new StaleJobLeaseError();
    return completed;
  });
}

async function loadReviewChain<TQueryResult extends PgQueryResultHKT>(
  db: JobDatabase<TQueryResult>,
  options: Pick<ReviewOptions<TQueryResult>, "ownerUserId" | "jobId" | "leaseToken" | "attemptCount">,
) {
  await assertActiveJobLease(db, options.ownerUserId, options.jobId, options);
  const [job] = await db.select().from(jobs).where(and(eq(jobs.id, options.jobId),
    eq(jobs.ownerUserId, options.ownerUserId), eq(jobs.kind, "review_audio"))).limit(1);
  if (!job?.playId || !isReviewPayload(job.payload)) throw new Error("INVALID_AUDIO_REVIEW_CHAIN");
  const payload = job.payload;
  const [stage] = await db.select().from(takeStageJobChains).where(and(eq(takeStageJobChains.jobId, job.id),
    eq(takeStageJobChains.ownerUserId, options.ownerUserId), eq(takeStageJobChains.takeId, payload.takeId),
    eq(takeStageJobChains.transcriptId, payload.transcriptId), eq(takeStageJobChains.stageKind, "review_audio"),
    eq(takeStageJobChains.transcriptStatus, "current"))).limit(1);
  const [take] = await db.select().from(takes).where(and(eq(takes.id, payload.takeId),
    eq(takes.ownerUserId, options.ownerUserId), eq(takes.playId, job.playId))).limit(1);
  const [transcript] = await db.select().from(takeTranscripts).where(and(eq(takeTranscripts.id, payload.transcriptId),
    eq(takeTranscripts.ownerUserId, options.ownerUserId), eq(takeTranscripts.takeId, payload.takeId),
    eq(takeTranscripts.status, "current"))).for("update").limit(1);
  const [measurement] = await db.select().from(takeMetrics).where(and(eq(takeMetrics.id, payload.measurementId),
    eq(takeMetrics.ownerUserId, options.ownerUserId), eq(takeMetrics.takeId, payload.takeId),
    eq(takeMetrics.transcriptId, payload.transcriptId), eq(takeMetrics.transcriptStatus, "current"))).limit(1);
  const [artifact] = await db.select().from(normalizedAudioArtifacts).where(and(
    eq(normalizedAudioArtifacts.id, payload.normalizedAudioArtifactId),
    eq(normalizedAudioArtifacts.ownerUserId, options.ownerUserId), eq(normalizedAudioArtifacts.takeId, payload.takeId),
    eq(normalizedAudioArtifacts.transcriptId, payload.transcriptId),
    eq(normalizedAudioArtifacts.transcriptStatus, "current"))).limit(1);
  if (!stage || !take || !transcript || !measurement || !artifact) throw new Error("INVALID_AUDIO_REVIEW_CHAIN");
  const [model] = await db.select().from(playModels).where(and(eq(playModels.id, take.playModelId),
    eq(playModels.ownerUserId, options.ownerUserId), eq(playModels.version, take.playModelVersion))).limit(1);
  if (!model) throw new Error("PINNED_PLAY_MODEL_NOT_FOUND");
  const alignments = await db.select().from(lineAlignments).where(and(
    eq(lineAlignments.ownerUserId, options.ownerUserId), eq(lineAlignments.transcriptId, transcript.id)));
  const words = await db.select().from(transcriptWords).where(and(
    eq(transcriptWords.ownerUserId, options.ownerUserId), eq(transcriptWords.transcriptId, transcript.id)))
    .orderBy(transcriptWords.ordinal);
  const [workbook] = await db.select({ content: analysisArtifacts.content }).from(analysisArtifacts).where(and(
    eq(analysisArtifacts.ownerUserId, options.ownerUserId), eq(analysisArtifacts.playId, job.playId),
    eq(analysisArtifacts.kind, `role_workbook:${take.roleId}`), eq(analysisArtifacts.status, "current"))).limit(1);
  return { playId: job.playId, take, transcript, measurement, artifact, model: model.model, alignments, words,
    workbook: workbook?.content };
}

function audioRequest(chain: Awaited<ReturnType<typeof loadReviewChain>>, audioDurationMs: number):
  Omit<AudioReviewRequest, "audio"> {
  const scene = chain.model.acts.flatMap((act) => act.scenes).find(({ id }) => id === chain.take.sceneId);
  if (!scene) throw new Error("PINNED_SCENE_NOT_FOUND");
  const lines = scene.elements.filter((element) => element.kind === "dialogue"
    && element.characterId === chain.take.roleId).sort((a, b) => a.ordinal - b.ordinal)
    .map(({ id, text }) => {
      const alignment = chain.alignments.find(({ elementId }) => elementId === id);
      return { elementId: id, text, startMs: alignment?.transcriptStartMs ?? null,
        endMs: alignment?.transcriptEndMs ?? null };
    });
  const workbook = RoleWorkbookSchema.safeParse(chain.workbook);
  const elementIds = new Set(scene.elements.map(({ id }) => id));
  const objective = workbook.success ? workbook.data.sceneObjectives.find((claim) =>
    claim.reference?.elementIds.some((id) => elementIds.has(id)))?.text ?? null : null;
  return { durationMs: audioDurationMs, sceneObjective: objective,
    selectedInterpretation: chain.take.selectedInterpretation, lines };
}

function deterministicEvidence(chain: Awaited<ReturnType<typeof loadReviewChain>>,
  lines: Array<{ elementId: string; text: string }>) {
  const alignmentConfidence: CoachingConfidence = chain.alignments.length === 0
    || chain.alignments.some(({ status }) => status === "uncertain") ? "low"
    : chain.alignments.every(({ status }) => status === "matched") ? "high" : "medium";
  const accuracy = chain.alignments.length === 0 ? null : calculateLineAccuracy(chain.alignments.map((alignment) => {
    const line = lines.find(({ elementId }) => elementId === alignment.elementId);
    const performed = alignment.transcriptStartMs === null || alignment.transcriptEndMs === null ? ""
      : chain.words.filter((word) => word.startMs !== null && word.endMs !== null
        && word.startMs >= alignment.transcriptStartMs! && word.endMs <= alignment.transcriptEndMs!)
        .map(({ text }) => text).join(" ");
    return { expected: line?.text ?? "", performed };
  }));
  const elementIds = lines.map(({ elementId }) => elementId);
  const metricEvidence = (["pace", "loudness", "pitch"] as const).map((name): CoachingEvidence => {
    const metric = chain.measurement.metrics[name];
    const confidence: CoachingConfidence = metric.confidence === "insufficient_data" ? "low" : metric.confidence;
    return { id: `metric-${name}`, kind: "deterministic_metric", confidence,
      description: `${name} measurement: ${JSON.stringify(metric)}`, startMs: null, endMs: null, elementIds };
  });
  return [{ id: "line-accuracy", kind: "transcript_alignment" as const, confidence: alignmentConfidence,
    description: `Aligned token edit distance score: ${accuracy ?? "unavailable"}.`, startMs: null, endMs: null,
    elementIds }, ...metricEvidence];
}

function validateAudioEvidence(evidence: CoachingEvidence[], request: Omit<AudioReviewRequest, "audio">,
  alignments: Array<typeof lineAlignments.$inferSelect>) {
  const known = new Set(request.lines.map(({ elementId }) => elementId));
  return evidence.map((item) => {
    const parsed = CoachingEvidenceSchema.parse(item);
    if (parsed.elementIds.some((id) => !known.has(id))) throw new Error("UNKNOWN_OBSERVATION_ELEMENT");
    const citedAlignments = alignments.filter((alignment) => parsed.elementIds.includes(alignment.elementId)
      && alignment.transcriptStartMs !== null && alignment.transcriptEndMs !== null);
    const grounded = citedAlignments.length === 0 ? parsed : { ...parsed,
      startMs: Math.max(0, Math.min(request.durationMs,
        Math.min(...citedAlignments.map(({ transcriptStartMs }) => transcriptStartMs!)))),
      endMs: Math.max(0, Math.min(request.durationMs,
        Math.max(...citedAlignments.map(({ transcriptEndMs }) => transcriptEndMs!)))) };
    if (grounded.kind !== "audio_observation" || grounded.startMs === null || grounded.endMs === null
      || grounded.startMs > grounded.endMs || grounded.endMs > request.durationMs) {
      throw new Error("OBSERVATION_OUT_OF_BOUNDS");
    }
    return grounded;
  });
}

async function enqueueSynthesis<TQueryResult extends PgQueryResultHKT>(
  db: JobDatabase<TQueryResult>, chain: Awaited<ReturnType<typeof loadReviewChain>>, now?: Date,
) {
  const dedupeKey = `synthesize_coaching:${chain.transcript.id}:${chain.measurement.measurementVersion}`;
  const [inserted] = await db.insert(jobs).values({ ownerUserId: chain.take.ownerUserId, playId: chain.playId,
    kind: "synthesize_coaching", dedupeKey, availableAt: now ?? new Date(),
    payload: { takeId: chain.take.id, transcriptId: chain.transcript.id, measurementId: chain.measurement.id },
  }).onConflictDoNothing().returning({ id: jobs.id });
  const [job] = inserted ? [inserted] : await db.select({ id: jobs.id }).from(jobs).where(and(
    eq(jobs.ownerUserId, chain.take.ownerUserId), eq(jobs.dedupeKey, dedupeKey),
    eq(jobs.kind, "synthesize_coaching"))).limit(1);
  if (!job) throw new Error("SYNTHESIS_HANDOFF_FAILED");
  if (!inserted) await db.update(jobs).set({ status: "queued", attemptCount: 0, errorCode: null,
    availableAt: now ?? new Date(), leaseToken: null, leaseExpiresAt: null, updatedAt: now ?? new Date() })
    .where(and(eq(jobs.id, job.id), inArray(jobs.status,
      ["completed", "completed_with_limitations", "action_required"])));
  await db.insert(takeStageJobChains).values({ jobId: job.id, ownerUserId: chain.take.ownerUserId,
    playId: chain.playId, takeId: chain.take.id, transcriptId: chain.transcript.id,
    transcriptStatus: "current", stageKind: "synthesize_coaching" }).onConflictDoNothing();
}

async function assertCurrentTranscript<TQueryResult extends PgQueryResultHKT>(db: JobDatabase<TQueryResult>,
  ownerUserId: string, takeId: string, transcriptId: string) {
  const [current] = await db.select({ id: takeTranscripts.id }).from(takeTranscripts).where(and(
    eq(takeTranscripts.id, transcriptId), eq(takeTranscripts.ownerUserId, ownerUserId),
    eq(takeTranscripts.takeId, takeId), eq(takeTranscripts.status, "current"))).for("update").limit(1);
  if (!current) throw new Error("STALE_TRANSCRIPT");
}

function isReviewPayload(value: unknown): value is { takeId: string; transcriptId: string;
  measurementId: string; normalizedAudioArtifactId: string } {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.takeId === "string" && typeof payload.transcriptId === "string"
    && typeof payload.measurementId === "string" && typeof payload.normalizedAudioArtifactId === "string";
}
