import { randomUUID } from "node:crypto";

import * as schema from "@drama/db/schema";
import { jobs } from "@drama/db/schema";
import { and, asc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type JobDatabase<TQueryResult extends PgQueryResultHKT> = PgDatabase<TQueryResult, typeof schema>;
export const SUPPORTED_JOB_KINDS = ["extract_script", "parse_play", "generate_study", "process_take",
  "measure_take", "review_audio", "synthesize_coaching", "purge_take_audio", "purge_play_audio",
  "delete_account"] as const;

export type JobLease = {
  leaseToken: string;
  attemptCount: number;
};

export class StaleJobLeaseError extends Error {
  readonly code = "STALE_JOB_LEASE";

  constructor() {
    super("Stale job lease");
    this.name = "StaleJobLeaseError";
  }
}

export class TerminalJobOutcomeError extends Error {
  readonly code = "JOB_TERMINAL";

  constructor(message: string) {
    super(message);
    this.name = "TerminalJobOutcomeError";
  }
}

type ClaimJobOptions<TQueryResult extends PgQueryResultHKT> = {
  db: JobDatabase<TQueryResult>;
  ownerUserId: string;
  now?: Date;
};

export async function claimNextJob<TQueryResult extends PgQueryResultHKT>(
  options: ClaimJobOptions<TQueryResult>,
) {
  const now = options.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + 10 * 60 * 1000);
  const leaseToken = randomUUID();

  return options.db.transaction(async (transaction) => {
    await transaction.update(jobs).set({
      status: "action_required",
      errorCode: "LEASE_EXPIRED",
      leaseExpiresAt: null,
      leaseToken: null,
      updatedAt: now,
    }).where(and(
      eq(jobs.ownerUserId, options.ownerUserId),
      inArray(jobs.kind, SUPPORTED_JOB_KINDS),
      eq(jobs.status, "running"),
      lte(jobs.leaseExpiresAt, now),
      sql`${jobs.attemptCount} >= 3`,
    ));
    const [candidate] = await transaction.select({ id: jobs.id }).from(jobs).where(and(
      eq(jobs.ownerUserId, options.ownerUserId),
      inArray(jobs.kind, SUPPORTED_JOB_KINDS),
      lte(jobs.availableAt, now),
      lt(jobs.attemptCount, 3),
      sql`EXISTS (SELECT 1 FROM users WHERE users.id = ${jobs.ownerUserId}
        AND (users.account_status = 'active' OR ${jobs.kind} = 'delete_account'))`,
      hasExactTakeStageChain(),
      or(
        eq(jobs.status, "queued"),
        and(eq(jobs.status, "running"), lte(jobs.leaseExpiresAt, now)),
      ),
    )).orderBy(asc(jobs.availableAt), asc(jobs.createdAt)).limit(1).for("update", { skipLocked: true });
    if (!candidate) return null;
    const [job] = await transaction.update(jobs).set({
      status: "running",
      leaseExpiresAt,
      leaseToken,
      attemptCount: sql`${jobs.attemptCount} + 1`,
      updatedAt: now,
    }).where(and(
      eq(jobs.id, candidate.id),
      eq(jobs.ownerUserId, options.ownerUserId),
    )).returning();
    return job ?? null;
  });
}

function hasExactTakeStageChain() {
  return sql`(
    ${jobs.kind} NOT IN ('measure_take', 'review_audio', 'synthesize_coaching') OR EXISTS (
      SELECT 1
      FROM take_stage_job_chains AS stage
      JOIN normalized_audio_artifacts AS artifact
        ON artifact.owner_user_id = stage.owner_user_id
        AND artifact.play_id = stage.play_id
        AND artifact.take_id = stage.take_id
        AND artifact.transcript_id = stage.transcript_id
        AND artifact.transcript_status = 'current'
      JOIN take_transcripts AS transcript
        ON transcript.id = stage.transcript_id
        AND transcript.owner_user_id = stage.owner_user_id
        AND transcript.take_id = stage.take_id
        AND transcript.status = 'current'
      WHERE stage.job_id = ${jobs.id}
        AND stage.owner_user_id = ${jobs.ownerUserId}
        AND stage.play_id = ${jobs.playId}
        AND stage.stage_kind = ${jobs.kind}
        AND stage.transcript_status = 'current'
        AND ${jobs.payload} ->> 'takeId' = stage.take_id::text
        AND ${jobs.payload} ->> 'transcriptId' = stage.transcript_id::text
        AND (
          ${jobs.kind} = 'synthesize_coaching'
          OR ${jobs.payload} ->> 'normalizedAudioArtifactId' = artifact.id::text
        )
        AND (
          ${jobs.kind} = 'measure_take'
          OR EXISTS (
            SELECT 1 FROM take_metrics AS measurement
            WHERE measurement.id::text = ${jobs.payload} ->> 'measurementId'
              AND measurement.owner_user_id = stage.owner_user_id
              AND measurement.take_id = stage.take_id
              AND measurement.transcript_id = stage.transcript_id
              AND measurement.transcript_status = 'current'
          )
        )
    )
  )`;
}

type FailJobOptions<TQueryResult extends PgQueryResultHKT> = {
  db: JobDatabase<TQueryResult>;
  ownerUserId: string;
  jobId: string;
  leaseToken: string;
  attemptCount: number;
  code: string;
  now?: Date;
};

export async function failJob<TQueryResult extends PgQueryResultHKT>(
  options: FailJobOptions<TQueryResult>,
) {
  const now = options.now ?? new Date();
  const [job] = await options.db.update(jobs).set({
    status: sql`CASE WHEN ${jobs.attemptCount} >= 3 THEN 'action_required' ELSE 'queued' END`,
    availableAt: now,
    leaseExpiresAt: null,
    leaseToken: null,
    errorCode: options.code,
    updatedAt: now,
  }).where(and(
    eq(jobs.id, options.jobId),
    eq(jobs.ownerUserId, options.ownerUserId),
    eq(jobs.status, "running"),
    sql`EXISTS (SELECT 1 FROM users WHERE users.id = ${jobs.ownerUserId}
      AND (users.account_status = 'active' OR ${jobs.kind} = 'delete_account'))`,
    eq(jobs.attemptCount, options.attemptCount),
    eq(jobs.leaseToken, options.leaseToken),
  )).returning();
  if (!job) throw new StaleJobLeaseError();
  return job;
}

export async function assertActiveJobLease<TQueryResult extends PgQueryResultHKT>(
  db: JobDatabase<TQueryResult>,
  ownerUserId: string,
  jobId: string,
  lease: JobLease,
): Promise<void> {
  const [active] = await db.select({ id: jobs.id }).from(jobs).where(and(
    eq(jobs.id, jobId),
    eq(jobs.ownerUserId, ownerUserId),
    eq(jobs.status, "running"),
    eq(jobs.attemptCount, lease.attemptCount),
    eq(jobs.leaseToken, lease.leaseToken),
  )).for("update").limit(1);
  if (!active) throw new StaleJobLeaseError();
}
