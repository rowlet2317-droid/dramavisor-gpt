import type { Coach } from "@drama/ai/coaching/port";
import * as schema from "@drama/db/schema";
import { analysisArtifacts, coachingReports, cueResponseEvidence, jobs, lineAlignments, playModels,
  takeStageJobChains, takeTranscripts, takes, transcriptWords }
  from "@drama/db/schema";
import { calculateLineAccuracy, CoachingValidationError, validateCoachingReport, type CoachingConfidence,
  type CoachingEvidence, type CoachingReport }
  from "@drama/domain/coaching";
import { RoleWorkbookSchema } from "@drama/domain/study";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { assertActiveJobLease, failJob, type JobLease, StaleJobLeaseError } from "./claim";

type JobDatabase<TQueryResult extends PgQueryResultHKT> = PgDatabase<TQueryResult, typeof schema>;

type SynthesisOptions<TQueryResult extends PgQueryResultHKT> = JobLease & {
  db: JobDatabase<TQueryResult>;
  ownerUserId: string;
  jobId: string;
  coach: Coach;
  now?: Date;
};

type FailureOptions<TQueryResult extends PgQueryResultHKT> = JobLease & {
  db: JobDatabase<TQueryResult>;
  ownerUserId: string;
  jobId: string;
  code: string;
  now?: Date;
};

export class InvalidCoachingSynthesisError extends Error {
  readonly code = "INVALID_COACHING_SYNTHESIS";

  constructor(cause: unknown) {
    super(`INVALID_COACHING_SYNTHESIS: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "InvalidCoachingSynthesisError";
  }
}

export async function runSynthesizeCoachingJob<TQueryResult extends PgQueryResultHKT>(
  options: SynthesisOptions<TQueryResult>,
): Promise<{ status: "completed" | "completed_with_limitations" }> {
  const chain = await options.db.transaction((transaction) => loadSynthesisChain(transaction, options));
  const scene = chain.model.acts.flatMap((act) => act.scenes).find(({ id }) => id === chain.take.sceneId);
  if (!scene) throw new Error("PINNED_SCENE_NOT_FOUND");
  const lines = scene.elements.filter((element) => element.kind === "dialogue"
    && element.characterId === chain.take.roleId).sort((left, right) => left.ordinal - right.ordinal)
    .map(({ id, text }) => ({ elementId: id, text }));
  const lineAccuracy = fixedLineAccuracy(chain.alignments, chain.words, lines, chain.record.evidence);
  const cueResponse = fixedCueResponse(chain.cueResponse);
  const synthesisEvidence = cueResponse.evidence
    ? [...chain.record.evidence, cueResponse.evidence] : chain.record.evidence;
  const previousComparableTakeSummary = await comparableTakeSummary(options.db, chain.take);
  const workbook = RoleWorkbookSchema.safeParse(chain.workbook);
  const sceneElementIds = new Set(scene.elements.map(({ id }) => id));
  const sceneObjective = workbook.success ? workbook.data.sceneObjectives.find((claim) =>
    claim.reference?.elementIds.some((id) => sceneElementIds.has(id)))?.text ?? null : null;
  let candidate: CoachingReport;
  let synthesisLimited = false;
  try {
    candidate = await options.coach.synthesize({ sceneObjective,
      selectedInterpretation: chain.take.selectedInterpretation, lines, evidence: synthesisEvidence,
      lineAccuracy, previousComparableTakeSummary,
      soloCompleteTake: chain.take.rehearsalSessionId === null });
    candidate = enforceFixedRatings(candidate, lineAccuracy, cueResponse.rating);
    candidate = validateCoachingReport(candidate, synthesisEvidence,
      { soloCompleteTake: chain.take.rehearsalSessionId === null });
  } catch (error) {
    if (isInvalidSynthesis(error)) {
      // Provider output is optional interpretation, not durable evidence. If it
      // is malformed or cites evidence it was not given, preserve the fixed
      // ratings and complete with a transparent, evidence-only fallback.
      synthesisLimited = true;
      candidate = validateCoachingReport(limitedCoachingReport(lineAccuracy, cueResponse.rating), synthesisEvidence,
        { soloCompleteTake: chain.take.rehearsalSessionId === null });
    } else {
      throw error;
    }
  }

  const status = chain.record.audioReviewStatus === "failed" || synthesisLimited
    ? "completed_with_limitations" : "completed";
  await options.db.transaction(async (transaction) => {
    const fresh = await loadSynthesisChain(transaction, options);
    if (fresh.record.id !== chain.record.id || !sameCueResponseSnapshot(fresh.cueResponse, chain.cueResponse)) {
      throw new Error("INVALID_COACHING_CHAIN");
    }
    await transaction.update(coachingReports).set({ status, report: candidate, synthesisErrorCode: null,
      evidence: synthesisEvidence, updatedAt: options.now ?? new Date() }).where(and(eq(coachingReports.id, chain.record.id),
      eq(coachingReports.ownerUserId, options.ownerUserId), eq(coachingReports.transcriptStatus, "current")));
    await transaction.update(takes).set({ state: status, updatedAt: options.now ?? new Date() }).where(and(
      eq(takes.id, chain.take.id), eq(takes.ownerUserId, options.ownerUserId)));
    if (chain.take.retentionChoice === "delete_after_analysis") {
      await transaction.insert(jobs).values({ ownerUserId: options.ownerUserId, playId: chain.take.playId,
        kind: "purge_take_audio", dedupeKey: `purge_take_audio:${chain.take.id}`,
        payload: { takeId: chain.take.id } }).onConflictDoNothing();
    }
    const [completed] = await transaction.update(jobs).set({ status: "completed", errorCode: null,
      leaseToken: null, leaseExpiresAt: null, updatedAt: options.now ?? new Date() }).where(and(
      eq(jobs.id, options.jobId), eq(jobs.ownerUserId, options.ownerUserId), eq(jobs.status, "running"),
      eq(jobs.attemptCount, options.attemptCount), eq(jobs.leaseToken, options.leaseToken),
    )).returning();
    if (!completed) throw new StaleJobLeaseError();
  });
  return { status };
}

function isInvalidSynthesis(error: unknown): boolean {
  return error instanceof CoachingValidationError || error instanceof InvalidCoachingSynthesisError
    || error instanceof Error && (error.name === "ZodError"
      || "code" in error && error.code === "INVALID_COACHING_SYNTHESIS");
}

function limitedCoachingReport(lineAccuracy: ReturnType<typeof fixedLineAccuracy>,
  cueResponse: ReturnType<typeof fixedCueResponse>["rating"]): CoachingReport {
  return {
    ratings: [
      { category: "line_accuracy", ...lineAccuracy },
      { category: "clarity", score: null, confidence: "low", evidenceIds: [] },
      { category: "pacing", score: null, confidence: "low", evidenceIds: [] },
      { category: "cue_responsiveness", ...cueResponse },
      { category: "vocal_variation", score: null, confidence: "low", evidenceIds: [] },
    ],
    strengths: [],
    priorities: [],
    exercise: { title: "Rehearse once more", targetCategory: "line_accuracy", evidenceIds: [],
      instructions: "Repeat the scene once at a comfortable pace, keeping the scripted words exact." },
    interpretationNotes: [],
  };
}

export async function failSynthesizeCoachingJob<TQueryResult extends PgQueryResultHKT>(
  options: FailureOptions<TQueryResult>,
) {
  if (options.attemptCount < 2) return failJob(options);
  return options.db.transaction(async (transaction) => {
    const chain = await loadSynthesisChain(transaction, options);
    await transaction.update(coachingReports).set({ status: "action_required", report: null,
      synthesisErrorCode: options.code, updatedAt: options.now ?? new Date() }).where(and(
      eq(coachingReports.id, chain.record.id), eq(coachingReports.ownerUserId, options.ownerUserId)));
    await transaction.update(takes).set({ state: "action_required", updatedAt: options.now ?? new Date() }).where(and(
      eq(takes.id, chain.take.id), eq(takes.ownerUserId, options.ownerUserId)));
    const [failed] = await transaction.update(jobs).set({ status: "action_required", errorCode: options.code,
      leaseToken: null, leaseExpiresAt: null, updatedAt: options.now ?? new Date() }).where(and(
      eq(jobs.id, options.jobId), eq(jobs.ownerUserId, options.ownerUserId), eq(jobs.status, "running"),
      eq(jobs.attemptCount, options.attemptCount), eq(jobs.leaseToken, options.leaseToken),
    )).returning();
    if (!failed) throw new StaleJobLeaseError();
    return failed;
  });
}

async function loadSynthesisChain<TQueryResult extends PgQueryResultHKT>(
  db: JobDatabase<TQueryResult>,
  options: Pick<SynthesisOptions<TQueryResult>, "ownerUserId" | "jobId" | "leaseToken" | "attemptCount">,
) {
  await assertActiveJobLease(db, options.ownerUserId, options.jobId, options);
  const [job] = await db.select().from(jobs).where(and(eq(jobs.id, options.jobId),
    eq(jobs.ownerUserId, options.ownerUserId), eq(jobs.kind, "synthesize_coaching"))).limit(1);
  if (!job?.playId || !isSynthesisPayload(job.payload)) throw new Error("INVALID_COACHING_CHAIN");
  const payload = job.payload;
  const [stage] = await db.select().from(takeStageJobChains).where(and(eq(takeStageJobChains.jobId, job.id),
    eq(takeStageJobChains.ownerUserId, options.ownerUserId), eq(takeStageJobChains.takeId, payload.takeId),
    eq(takeStageJobChains.transcriptId, payload.transcriptId),
    eq(takeStageJobChains.stageKind, "synthesize_coaching"), eq(takeStageJobChains.transcriptStatus, "current")))
    .limit(1);
  const [take] = await db.select().from(takes).where(and(eq(takes.id, payload.takeId),
    eq(takes.ownerUserId, options.ownerUserId), eq(takes.playId, job.playId))).for("update").limit(1);
  const [transcript] = await db.select().from(takeTranscripts).where(and(eq(takeTranscripts.id, payload.transcriptId),
    eq(takeTranscripts.ownerUserId, options.ownerUserId), eq(takeTranscripts.takeId, payload.takeId),
    eq(takeTranscripts.status, "current"))).for("update").limit(1);
  const [record] = await db.select().from(coachingReports).where(and(
    eq(coachingReports.ownerUserId, options.ownerUserId), eq(coachingReports.takeId, payload.takeId),
    eq(coachingReports.transcriptId, payload.transcriptId), eq(coachingReports.measurementId, payload.measurementId),
    eq(coachingReports.transcriptStatus, "current"))).for("update").limit(1);
  if (!stage || !take || !transcript || !record) throw new Error("INVALID_COACHING_CHAIN");
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
  const [cueResponse] = take.rehearsalSessionId ? await db.select().from(cueResponseEvidence).where(and(
    eq(cueResponseEvidence.ownerUserId, options.ownerUserId), eq(cueResponseEvidence.takeId, take.id),
    eq(cueResponseEvidence.rehearsalSessionId, take.rehearsalSessionId),
    eq(cueResponseEvidence.measurementVersion, "cue-response-v1"))).for("update").limit(1) : [];
  return { take, transcript, record, model: model.model, alignments, words,
    workbook: workbook?.content, cueResponse };
}

function fixedLineAccuracy(alignments: Array<typeof lineAlignments.$inferSelect>,
  words: Array<typeof transcriptWords.$inferSelect>, lines: Array<{ elementId: string; text: string }>,
  evidence: (typeof coachingReports.$inferSelect)["evidence"]) {
  const source = evidence.find(({ id }) => id === "line-accuracy");
  const confidence: CoachingConfidence = source?.confidence ?? "low";
  const score = alignments.length > 0 && confidence !== "low" ? calculateLineAccuracy(alignments.map((alignment) => {
    const expected = lines.find(({ elementId }) => elementId === alignment.elementId)?.text ?? "";
    const performed = alignment.transcriptStartMs === null || alignment.transcriptEndMs === null ? ""
      : words.filter((word) => word.startMs !== null && word.endMs !== null
        && word.startMs >= alignment.transcriptStartMs! && word.endMs <= alignment.transcriptEndMs!)
        .map(({ text }) => text).join(" ");
    return { expected, performed };
  })) : null;
  return { score, confidence, evidenceIds: source ? [source.id] : [] };
}

function fixedCueResponse(source: typeof cueResponseEvidence.$inferSelect | undefined): {
  evidence: CoachingEvidence | null;
  rating: { score: number | null; confidence: CoachingConfidence; evidenceIds: string[] };
} {
  if (!source || source.score === null || source.delayMs === null
    || !["high", "medium"].includes(source.confidence)) {
    return { evidence: null, rating: { score: null, confidence: "low", evidenceIds: [] } };
  }
  const evidenceId = `cue-response:${source.id}`;
  return { evidence: { id: evidenceId, kind: "deterministic_metric", confidence: source.confidence,
    description: `Acknowledged rehearsal cue response delay: ${source.delayMs} ms.`,
    startMs: null, endMs: null, elementIds: [] },
  rating: { score: source.score, confidence: source.confidence, evidenceIds: [evidenceId] } };
}

function sameCueResponseSnapshot(left: typeof cueResponseEvidence.$inferSelect | undefined,
  right: typeof cueResponseEvidence.$inferSelect | undefined): boolean {
  if (!left || !right) return left === right;
  return left.id === right.id && left.ownerUserId === right.ownerUserId && left.takeId === right.takeId
    && left.rehearsalSessionId === right.rehearsalSessionId
    && left.measurementVersion === right.measurementVersion && left.cueEventId === right.cueEventId
    && left.actorEventId === right.actorEventId && left.clockId === right.clockId
    && left.delayMs === right.delayMs && left.confidence === right.confidence && left.score === right.score
    && left.createdAt.getTime() === right.createdAt.getTime()
    && left.updatedAt.getTime() === right.updatedAt.getTime();
}

function enforceFixedRatings(report: CoachingReport, lineAccuracy: ReturnType<typeof fixedLineAccuracy>,
  cueResponse: ReturnType<typeof fixedCueResponse>["rating"]): CoachingReport {
  return { ...report, ratings: report.ratings.map((rating) => rating.category === "line_accuracy"
    ? { category: "line_accuracy", ...lineAccuracy }
    : rating.category === "cue_responsiveness"
      ? { category: "cue_responsiveness", ...cueResponse }
      : rating) };
}

async function comparableTakeSummary<TQueryResult extends PgQueryResultHKT>(
  db: JobDatabase<TQueryResult>, current: typeof takes.$inferSelect,
) {
  const rows = await db.select({ take: takes, report: coachingReports.report,
    createdAt: coachingReports.createdAt }).from(coachingReports).innerJoin(takes, and(
    eq(takes.id, coachingReports.takeId), eq(takes.ownerUserId, coachingReports.ownerUserId),
  )).where(and(eq(coachingReports.ownerUserId, current.ownerUserId),
    inArray(coachingReports.status, ["completed", "completed_with_limitations"])))
    .orderBy(desc(coachingReports.createdAt));
  const previous = rows.find(({ take, report }) => take.id !== current.id && report
    && take.playModelId === current.playModelId && take.playModelVersion === current.playModelVersion
    && take.sceneId === current.sceneId && take.roleId === current.roleId);
  return previous?.report ? JSON.stringify({ ratings: previous.report.ratings,
    strengths: previous.report.strengths, priorities: previous.report.priorities }) : null;
}

function isSynthesisPayload(value: unknown): value is { takeId: string; transcriptId: string;
  measurementId: string } {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.takeId === "string" && typeof payload.transcriptId === "string"
    && typeof payload.measurementId === "string";
}
