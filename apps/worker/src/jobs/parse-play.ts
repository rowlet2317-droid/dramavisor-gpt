import { randomUUID } from "node:crypto";

import { ModelSchemaFailure } from "@drama/ai/play-parser/openai-parser";
import type { PlayParser } from "@drama/ai/play-parser/port";
import * as schema from "@drama/db/schema";
import { jobs, playModels, plays } from "@drama/db/schema";
import { normalizeParseProposal } from "@drama/domain/parse-review";
import type { ExtractedScript } from "@drama/media/scripts/extract";
import { isNonEnglishScript } from "@drama/media/scripts/language";
import { and, desc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { assertActiveJobLease, type JobLease, TerminalJobOutcomeError } from "./claim";

type RunParseJobOptions<TQueryResult extends PgQueryResultHKT> = {
  db: PgDatabase<TQueryResult, typeof schema>;
  ownerUserId: string;
  jobId: string;
  parser: PlayParser;
  leaseToken: string;
  attemptCount: number;
  createId?: () => string;
};

export async function runParseJob<TQueryResult extends PgQueryResultHKT>(
  options: RunParseJobOptions<TQueryResult>,
): Promise<{ playModelVersionId: string }> {
  const [job] = await options.db
    .select()
    .from(jobs)
    .where(and(
      eq(jobs.id, options.jobId),
      eq(jobs.ownerUserId, options.ownerUserId),
      eq(jobs.kind, "parse_play"),
    ))
    .limit(1);
  if (!job?.playId) throw new Error("Parse job not found");
  if (job.status === "completed" && job.resultPlayModelVersionId) {
    return { playModelVersionId: job.resultPlayModelVersionId };
  }

  const [play] = await options.db
    .select({ id: plays.id })
    .from(plays)
    .where(and(eq(plays.id, job.playId), eq(plays.ownerUserId, options.ownerUserId)))
    .limit(1);
  if (!play) throw new Error("Play not found");

  const [latest] = await options.db
    .select({ version: playModels.version })
    .from(playModels)
    .where(and(eq(playModels.playId, play.id), eq(playModels.ownerUserId, options.ownerUserId)))
    .orderBy(desc(playModels.version))
    .limit(1);
  const version = (latest?.version ?? 0) + 1;
  const extracted = extractedFromPayload(job.payload);
  if (isNonEnglishScript(extracted.pages.map((page) => page.text).join("\n"))) {
    await markActionRequired(options, job.id, "NON_ENGLISH_SOURCE");
    throw new TerminalJobOutcomeError("English scripts only");
  }
  let parsed;
  try {
    parsed = await options.parser.parse(extracted);
  } catch (error) {
    if (error instanceof ModelSchemaFailure) {
      await markActionRequired(options, job.id, error.code);
    }
    throw error;
  }
  let proposal;
  try {
    proposal = normalizeParseProposal(parsed, play.id, version);
  } catch (error) {
    const failure = new ModelSchemaFailure(error instanceof Error ? error.message : String(error));
    await markActionRequired(options, job.id, failure.code);
    throw failure;
  }
  const playModelVersionId = (options.createId ?? randomUUID)();

  await options.db.transaction(async (transaction) => {
    await assertActiveJobLease(transaction, options.ownerUserId, job.id, lease(options));
    await transaction.insert(playModels).values({
      id: playModelVersionId,
      ownerUserId: options.ownerUserId,
      playId: play.id,
      version,
      status: "review_required",
      model: proposal.playModel,
      issues: proposal.issues,
      sourceJobDedupeKey: job.dedupeKey,
    });
    await transaction.update(jobs).set({
      status: "completed",
      resultPlayModelVersionId: playModelVersionId,
      leaseExpiresAt: null,
      leaseToken: null,
      errorCode: null,
      updatedAt: new Date(),
    }).where(and(
      eq(jobs.id, job.id),
      eq(jobs.ownerUserId, options.ownerUserId),
      eq(jobs.attemptCount, options.attemptCount),
      eq(jobs.leaseToken, options.leaseToken),
      eq(jobs.status, "running"),
    ));
    await transaction.update(plays).set({ status: "review", updatedAt: new Date() })
      .where(and(eq(plays.id, play.id), eq(plays.ownerUserId, options.ownerUserId)));
  });

  return { playModelVersionId };
}

function lease(options: { leaseToken: string; attemptCount: number }): JobLease {
  return { leaseToken: options.leaseToken, attemptCount: options.attemptCount };
}

async function markActionRequired<TQueryResult extends PgQueryResultHKT>(
  options: RunParseJobOptions<TQueryResult>,
  jobId: string,
  errorCode: string,
): Promise<void> {
  await options.db.transaction(async (transaction) => {
    await assertActiveJobLease(transaction, options.ownerUserId, jobId, lease(options));
    const failed = await transaction.update(jobs).set({
      status: "action_required",
      errorCode,
      leaseExpiresAt: null,
      leaseToken: null,
      updatedAt: new Date(),
    }).where(and(
      eq(jobs.id, jobId),
      eq(jobs.ownerUserId, options.ownerUserId),
      eq(jobs.attemptCount, options.attemptCount),
      eq(jobs.leaseToken, options.leaseToken),
      eq(jobs.status, "running"),
    )).returning({ id: jobs.id });
    if (!failed[0]) throw new Error("Stale job lease");
  });
}

function extractedFromPayload(payload: Record<string, unknown>): ExtractedScript {
  const extracted = payload.extracted;
  if (!extracted || typeof extracted !== "object") throw new Error("Parse job has no extracted script");
  return extracted as ExtractedScript;
}
