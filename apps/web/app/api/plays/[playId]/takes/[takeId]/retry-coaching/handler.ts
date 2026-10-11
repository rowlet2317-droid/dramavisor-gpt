import { lockActiveOwner } from "@drama/db/repositories/auth";
import type * as schema from "@drama/db/schema";
import { coachingReports, jobs, normalizedAudioArtifacts, takeStageJobChains, takes } from "@drama/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type RouteContext = { params: Promise<{ playId: string; takeId: string }> };
type Dependencies<TQueryResult extends PgQueryResultHKT> = {
  authenticate: () => Promise<{ id: string }>;
  db: PgDatabase<TQueryResult, typeof schema>;
  now?: () => Date;
};

export function createRetryCoachingHandler<TQueryResult extends PgQueryResultHKT>(
  dependencies: Dependencies<TQueryResult>,
) {
  return async function POST(_request: Request, context: RouteContext): Promise<Response> {
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
    const result = await dependencies.db.transaction(async (transaction) => {
      if (!await lockActiveOwner(transaction, user.id)) return { kind: "not_found" as const };
      const [take] = await transaction.select().from(takes).where(and(
        eq(takes.id, takeId), eq(takes.playId, playId), eq(takes.ownerUserId, user.id),
      )).for("update").limit(1);
      if (!take) return { kind: "not_found" as const };

      const now = dependencies.now?.() ?? new Date();
      const [failedJob] = await transaction.select({ id: jobs.id, kind: jobs.kind }).from(jobs).where(and(
        eq(jobs.ownerUserId, user.id), eq(jobs.playId, playId), eq(jobs.status, "action_required"),
        inArray(jobs.kind, ["process_take", "measure_take", "review_audio", "synthesize_coaching"]),
        sql`${jobs.payload} ->> 'takeId' = ${take.id}::text`,
      )).orderBy(desc(jobs.updatedAt)).for("update").limit(1);
      if (failedJob) {
        if (failedJob.kind === "synthesize_coaching") {
          const [report] = await transaction.select({ transcriptId: coachingReports.transcriptId })
            .from(coachingReports).where(and(eq(coachingReports.ownerUserId, user.id),
              eq(coachingReports.takeId, take.id), eq(coachingReports.transcriptStatus, "current")))
            .for("update").limit(1);
          if (!report) return { kind: "not_retryable" as const };
          await transaction.insert(takeStageJobChains).values({ jobId: failedJob.id, ownerUserId: user.id,
            playId, takeId: take.id, transcriptId: report.transcriptId, transcriptStatus: "current",
            stageKind: "synthesize_coaching" }).onConflictDoNothing();
          await transaction.update(coachingReports).set({ status: "processing", synthesisErrorCode: null,
            updatedAt: now }).where(and(eq(coachingReports.ownerUserId, user.id),
            eq(coachingReports.takeId, take.id), eq(coachingReports.transcriptStatus, "current")));
        }
        await transaction.update(jobs).set({ status: "queued", attemptCount: 0, errorCode: null,
          availableAt: now, leaseToken: null, leaseExpiresAt: null, updatedAt: now })
          .where(eq(jobs.id, failedJob.id));
        await transaction.update(takes).set({ state: "processing", updatedAt: now })
          .where(eq(takes.id, take.id));
        return { kind: "queued" as const };
      }

      const [report] = await transaction.select().from(coachingReports).where(and(
        eq(coachingReports.ownerUserId, user.id), eq(coachingReports.playId, playId),
        eq(coachingReports.takeId, take.id), eq(coachingReports.transcriptStatus, "current"),
      )).for("update").limit(1);
      const isRedoable = ["completed", "completed_with_limitations"].includes(take.state)
        && report?.report !== null;
      if (!report || (take.state !== "action_required" && !isRedoable)
        || (take.state === "action_required" && report.report !== null)) {
        return { kind: "not_retryable" as const };
      }

      if (isRedoable && take.audioDeletedAt === null) {
        const [artifact] = await transaction.select({ id: normalizedAudioArtifacts.id })
          .from(normalizedAudioArtifacts).where(and(eq(normalizedAudioArtifacts.ownerUserId, user.id),
            eq(normalizedAudioArtifacts.takeId, take.id), eq(normalizedAudioArtifacts.transcriptId, report.transcriptId),
            eq(normalizedAudioArtifacts.transcriptStatus, "current"))).limit(1);
        const [reviewJob] = artifact ? await transaction.select({ id: jobs.id }).from(jobs).where(and(
          eq(jobs.ownerUserId, user.id), eq(jobs.playId, playId), eq(jobs.kind, "review_audio"),
          sql`${jobs.payload} ->> 'takeId' = ${take.id}::text`,
          sql`${jobs.payload} ->> 'transcriptId' = ${report.transcriptId}::text`,
          sql`${jobs.payload} ->> 'normalizedAudioArtifactId' = ${artifact.id}::text`,
        )).for("update").limit(1) : [];
        if (reviewJob) {
          await transaction.update(jobs).set({ status: "queued", attemptCount: 0, errorCode: null,
            availableAt: now, leaseToken: null, leaseExpiresAt: null, updatedAt: now })
            .where(eq(jobs.id, reviewJob.id));
          await transaction.update(coachingReports).set({ status: "processing", audioReviewStatus: "pending",
            report: null, synthesisErrorCode: null, updatedAt: now }).where(eq(coachingReports.id, report.id));
          await transaction.update(takes).set({ state: "processing", updatedAt: now }).where(eq(takes.id, take.id));
          return { kind: "queued" as const };
        }
      }

      const [existing] = await transaction.select({ id: jobs.id, status: jobs.status }).from(jobs).where(and(
        eq(jobs.ownerUserId, user.id), eq(jobs.playId, playId), eq(jobs.kind, "synthesize_coaching"),
        sql`${jobs.payload} ->> 'takeId' = ${take.id}::text`,
        sql`${jobs.payload} ->> 'transcriptId' = ${report.transcriptId}::text`,
        sql`${jobs.payload} ->> 'measurementId' = ${report.measurementId}::text`,
      )).for("update").limit(1);
      if (existing && !["completed", "completed_with_limitations"].includes(existing.status)) {
        return { kind: "not_retryable" as const };
      }

      const job = existing ?? (await transaction.insert(jobs).values({ ownerUserId: user.id, playId,
        kind: "synthesize_coaching",
        dedupeKey: `synthesize_coaching_retry:${report.transcriptId}:${report.measurementId}`,
        availableAt: now,
        payload: { takeId: take.id, transcriptId: report.transcriptId, measurementId: report.measurementId },
      }).returning({ id: jobs.id }))[0];
      if (!job) return { kind: "not_retryable" as const };

      await transaction.insert(takeStageJobChains).values({ jobId: job.id, ownerUserId: user.id,
        playId, takeId: take.id, transcriptId: report.transcriptId, transcriptStatus: "current",
        stageKind: "synthesize_coaching" }).onConflictDoNothing();

      await transaction.update(jobs).set({ status: "queued", attemptCount: 0, errorCode: null,
        availableAt: now, leaseToken: null, leaseExpiresAt: null, updatedAt: now }).where(eq(jobs.id, job.id));
      await transaction.update(coachingReports).set({ status: "processing", synthesisErrorCode: null,
        updatedAt: now }).where(eq(coachingReports.id, report.id));
      await transaction.update(takes).set({ state: "processing", updatedAt: now })
        .where(eq(takes.id, take.id));
      return { kind: "queued" as const };
    });

    if (result.kind === "not_found") return Response.json({ error: "Take not found" }, { status: 404 });
    if (result.kind === "not_retryable") {
      return Response.json({ error: "Coaching retry is not available for this take" }, { status: 409 });
    }
    return Response.json({ take: { id: takeId, state: "processing" } }, { status: 202 });
  };
}
