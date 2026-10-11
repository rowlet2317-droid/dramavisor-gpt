import type * as schema from "@drama/db/schema";
import { coachingReports, jobs, lineAlignments, playModels, takes } from "@drama/db/schema";
import { compareTakes, selectPreviousComparableTake, type CompletedCoachingTake }
  from "@drama/domain/take-comparison";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type RouteContext = { params: Promise<{ playId: string; takeId: string }> };
type Dependencies<TQueryResult extends PgQueryResultHKT> = {
  authenticate: () => Promise<{ id: string }>;
  db: PgDatabase<TQueryResult, typeof schema>;
};

export function createTakeReportHandler<TQueryResult extends PgQueryResultHKT>(
  dependencies: Dependencies<TQueryResult>,
) {
  return async function GET(_request: Request, context: RouteContext): Promise<Response> {
    let user: { id: string };
    try {
      user = await dependencies.authenticate();
    } catch (error) {
      if (error instanceof Error && error.name === "UnauthorizedError") {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      return Response.json({ error: "Unable to authenticate" }, { status: 500 });
    }

    const { playId, takeId } = await context.params;
    const [take] = await dependencies.db.select().from(takes).where(and(eq(takes.id, takeId),
      eq(takes.playId, playId), eq(takes.ownerUserId, user.id))).limit(1);
    if (!take) return Response.json({ error: "Take not found" }, { status: 404 });

    const [coaching] = await dependencies.db.select().from(coachingReports).where(and(
      eq(coachingReports.ownerUserId, user.id), eq(coachingReports.playId, playId),
      eq(coachingReports.takeId, take.id), eq(coachingReports.transcriptStatus, "current"))).limit(1);
    const [latestPipelineFailure] = await dependencies.db.select({ errorCode: jobs.errorCode })
      .from(jobs).where(and(eq(jobs.ownerUserId, user.id), eq(jobs.playId, playId),
        sql`${jobs.kind} IN ('process_take', 'measure_take', 'review_audio', 'synthesize_coaching')`,
        sql`${jobs.payload} ->> 'takeId' = ${take.id}::text`,
        sql`${jobs.errorCode} IS NOT NULL`,
      )).orderBy(desc(jobs.updatedAt)).limit(1);
    const [model] = await dependencies.db.select({ model: playModels.model }).from(playModels).where(and(
      eq(playModels.id, take.playModelId), eq(playModels.ownerUserId, user.id),
      eq(playModels.version, take.playModelVersion))).limit(1);
    const scene = model?.model.acts.flatMap((act) => act.scenes).find(({ id }) => id === take.sceneId);
    const alignments = coaching ? await dependencies.db.select().from(lineAlignments).where(and(
      eq(lineAlignments.ownerUserId, user.id), eq(lineAlignments.transcriptId, coaching.transcriptId),
    )) : [];
    const scriptLines = scene?.elements.filter((element) => element.kind === "dialogue"
      && element.characterId === take.roleId).sort((left, right) => left.ordinal - right.ordinal)
      .map(({ id, text }) => {
        const alignment = alignments.find(({ elementId }) => elementId === id);
        return { elementId: id, text, startMs: alignment?.transcriptStartMs ?? null,
          endMs: alignment?.transcriptEndMs ?? null };
      }) ?? [];
    const comparison = coaching?.report && isCompletedState(take.state)
      ? await previousComparison(dependencies.db, take, coaching.report)
      : null;

    return Response.json({
      take: { id: take.id, state: take.state, durationMs: take.durationMs, mediaType: take.mediaType,
        createdAt: take.createdAt, audioDeletedAt: take.audioDeletedAt },
      coaching: coaching ? { status: coaching.status, audioReviewStatus: coaching.audioReviewStatus,
        evidence: alignEvidenceForReplay(coaching.evidence, alignments), report: coaching.report,
        synthesisErrorCode: coaching.synthesisErrorCode ?? latestPipelineFailure?.errorCode ?? null }
        : latestPipelineFailure ? { status: "action_required", audioReviewStatus: "pending", evidence: [],
          report: null, synthesisErrorCode: latestPipelineFailure.errorCode } : null,
      comparison,
      scriptLines,
      audioUrl: take.audioDeletedAt ? null : `/api/plays/${playId}/takes/${take.id}/audio`,
    }, { headers: { "cache-control": "private, no-store" } });
  };
}

export function alignEvidenceForReplay(evidence: (typeof coachingReports.$inferSelect)["evidence"],
  alignments: Array<typeof lineAlignments.$inferSelect>) {
  return evidence.map((item) => {
    if (item.kind !== "audio_observation") return item;
    const cited = alignments.filter((alignment) => item.elementIds.includes(alignment.elementId)
      && alignment.transcriptStartMs !== null && alignment.transcriptEndMs !== null);
    return cited.length === 0 ? item : { ...item,
      startMs: Math.min(...cited.map(({ transcriptStartMs }) => transcriptStartMs!)),
      endMs: Math.max(...cited.map(({ transcriptEndMs }) => transcriptEndMs!)) };
  });
}

async function previousComparison<TQueryResult extends PgQueryResultHKT>(
  db: PgDatabase<TQueryResult, typeof schema>, current: typeof takes.$inferSelect,
  currentReport: NonNullable<(typeof coachingReports.$inferSelect)["report"]>,
) {
  const rows = await db.select({ take: takes, report: coachingReports.report }).from(takes)
    .innerJoin(coachingReports, and(eq(coachingReports.takeId, takes.id),
      eq(coachingReports.ownerUserId, takes.ownerUserId), eq(coachingReports.transcriptStatus, "current")))
    .where(and(eq(takes.ownerUserId, current.ownerUserId), eq(takes.playId, current.playId),
      inArray(takes.state, ["completed", "completed_with_limitations"]),
      inArray(coachingReports.status, ["completed", "completed_with_limitations"])));
  const currentComparable = comparableTake(current, currentReport);
  const previous = selectPreviousComparableTake(currentComparable, rows.flatMap(({ take, report }) =>
    report && isCompletedState(take.state) ? [comparableTake(take, report)] : []));
  return previous ? { previousTakeId: previous.id, scores: compareTakes(currentComparable, previous) } : null;
}

function comparableTake(take: typeof takes.$inferSelect,
  coachingReport: NonNullable<(typeof coachingReports.$inferSelect)["report"]>): CompletedCoachingTake {
  if (!isCompletedState(take.state)) throw new Error("Take is not complete");
  return { id: take.id, playModelId: take.playModelId, playModelVersion: take.playModelVersion,
    sceneId: take.sceneId, roleId: take.roleId, practiceMode: take.practiceMode, state: take.state,
    createdAt: take.createdAt, coachingReport };
}

function isCompletedState(state: string): state is "completed" | "completed_with_limitations" {
  return state === "completed" || state === "completed_with_limitations";
}
