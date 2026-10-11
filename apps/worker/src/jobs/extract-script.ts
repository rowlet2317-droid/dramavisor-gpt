import { randomUUID } from "node:crypto";

import * as schema from "@drama/db/schema";
import { jobs, sourceFiles } from "@drama/db/schema";
import type { ScriptExtractor, ScriptInput } from "@drama/media/scripts/extract";
import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { assertActiveJobLease } from "./claim";

type RunExtractJobOptions<TQueryResult extends PgQueryResultHKT> = {
  db: PgDatabase<TQueryResult, typeof schema>;
  ownerUserId: string;
  jobId: string;
  extractor: ScriptExtractor;
  leaseToken: string;
  attemptCount: number;
  loadPrivateObject?: (objectKey: string) => Promise<Uint8Array>;
  createId?: () => string;
};

class ExtractScriptFailure extends Error {
  constructor(readonly code: "SOURCE_METADATA_FAILURE" | "SOURCE_LOAD_FAILURE" | "SCRIPT_EXTRACTION_FAILURE"
    | "PARSE_JOB_ENQUEUE_FAILURE",
    options?: ErrorOptions) {
    super(code, options);
    this.name = "ExtractScriptFailure";
  }
}

export async function runExtractScriptJob<TQueryResult extends PgQueryResultHKT>(
  options: RunExtractJobOptions<TQueryResult>,
): Promise<{ parseJobId: string }> {
  const [job] = await options.db.select().from(jobs).where(and(
    eq(jobs.id, options.jobId),
    eq(jobs.ownerUserId, options.ownerUserId),
    eq(jobs.kind, "extract_script"),
  )).limit(1);
  if (!job?.playId) throw new Error("Extract job not found");
  const sourceFileId = job.payload.sourceFileId;
  if (typeof sourceFileId !== "string") throw new Error("Extract job has no source file");
  const parseDedupeKey = `parse_play:${job.playId}:${sourceFileId}`;
  if (job.status === "completed") {
    const existing = await findParseJob(options.db, options.ownerUserId, parseDedupeKey);
    if (existing) return { parseJobId: existing.id };
  }

  let source: typeof sourceFiles.$inferSelect | undefined;
  try {
    [source] = await options.db.select().from(sourceFiles).where(and(
      eq(sourceFiles.id, sourceFileId),
      eq(sourceFiles.playId, job.playId),
      eq(sourceFiles.ownerUserId, options.ownerUserId),
    )).limit(1);
  } catch (error) {
    throw new ExtractScriptFailure("SOURCE_METADATA_FAILURE", { cause: error });
  }
  if (!source) throw new ExtractScriptFailure("SOURCE_METADATA_FAILURE");
  let input: ScriptInput;
  try {
    input = await scriptInput(source, options.loadPrivateObject);
  } catch (error) {
    throw new ExtractScriptFailure("SOURCE_LOAD_FAILURE", { cause: error });
  }
  let extracted;
  try {
    extracted = await options.extractor.extract(input);
  } catch (error) {
    throw new ExtractScriptFailure("SCRIPT_EXTRACTION_FAILURE", { cause: error });
  }
  const candidateId = (options.createId ?? randomUUID)();

  const parseJobId = await options.db.transaction(async (transaction) => {
    await assertActiveJobLease(transaction, options.ownerUserId, job.id, options);
    const inserted = await transaction.insert(jobs).values({
      id: candidateId,
      ownerUserId: options.ownerUserId,
      playId: job.playId,
      kind: "parse_play",
      dedupeKey: parseDedupeKey,
      payload: { sourceFileId, extracted },
    }).onConflictDoNothing().returning({ id: jobs.id });
    const id = inserted[0]?.id ?? (await findParseJob(transaction, options.ownerUserId, parseDedupeKey))?.id;
    if (!id) throw new Error("Unable to enqueue parse job");
    await transaction.update(jobs).set({
      status: "completed",
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
    return id;
  }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error) throw error;
    throw new ExtractScriptFailure("PARSE_JOB_ENQUEUE_FAILURE", { cause: error });
  });

  return { parseJobId };
}

async function findParseJob<TQueryResult extends PgQueryResultHKT>(
  db: PgDatabase<TQueryResult, typeof schema>,
  ownerUserId: string,
  dedupeKey: string,
) {
  const [job] = await db.select({ id: jobs.id }).from(jobs).where(and(
    eq(jobs.ownerUserId, ownerUserId),
    eq(jobs.dedupeKey, dedupeKey),
  )).limit(1);
  return job ?? null;
}

async function scriptInput(
  source: typeof sourceFiles.$inferSelect,
  loadPrivateObject?: (objectKey: string) => Promise<Uint8Array>,
): Promise<ScriptInput> {
  if (source.sourceText !== null) return { kind: "text", text: source.sourceText };
  if (!source.objectKey || !loadPrivateObject) throw new Error("Private source loader is required");
  return {
    kind: "file",
    filename: source.filename,
    contentType: contentType(source.filename),
    bytes: await loadPrivateObject(source.objectKey),
  };
}

function contentType(filename: string): string {
  if (filename.toLowerCase().endsWith(".txt")) return "text/plain";
  if (filename.toLowerCase().endsWith(".pdf")) return "application/pdf";
  if (filename.toLowerCase().endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  throw new Error("Unsupported private script file");
}
