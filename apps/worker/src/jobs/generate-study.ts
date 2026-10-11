import { randomUUID } from "node:crypto";

import type { StudyGenerator } from "@drama/ai/study/port";
import { fallbackStudyArtifact } from "@drama/ai/study/fallback";
import * as schema from "@drama/db/schema";
import { analysisArtifacts, jobs, plays } from "@drama/db/schema";
import { StudyRepository } from "@drama/db/repositories/study";
import { validateStudyArtifact, type StudyArtifact, type StudySectionKind } from "@drama/domain/study";
import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { assertActiveJobLease } from "./claim";

type Options<TQueryResult extends PgQueryResultHKT> = {
  db: PgDatabase<TQueryResult, typeof schema>;
  ownerUserId: string;
  jobId: string;
  generator: StudyGenerator;
  leaseToken: string;
  attemptCount: number;
  promptVersion: string;
  modelName: string;
  generatedAt?: Date;
  createId?: () => string;
};

type Result = { status: "completed" | "completed_with_limitations"; omittedSections: string[] };

export async function runGenerateStudyJob<TQueryResult extends PgQueryResultHKT>(
  options: Options<TQueryResult>,
): Promise<Result> {
  const [job] = await options.db.select().from(jobs).where(and(
    eq(jobs.id, options.jobId), eq(jobs.ownerUserId, options.ownerUserId), eq(jobs.kind, "generate_study"),
  )).limit(1);
  if (!job?.playId) throw new Error("Study job not found");
  if (job.status === "completed") return { status: "completed", omittedSections: [] };
  if (job.status === "completed_with_limitations") {
    return { status: "completed_with_limitations", omittedSections: [] };
  }
  const version = numberPayload(job.payload.playModelVersion, "Study job has no Play Model version");
  const repository = new StudyRepository(options.db);
  const approved = await repository.getApprovedModel(options.ownerUserId, job.playId, version);
  if (!approved) throw new Error("Approved Play Model not found");

  const requests: { kind: StudySectionKind; scopeId: string | null; key: string }[] = [
    ...(["overview", "themes", "dramatic_structure", "characters", "relationships"] as const)
      .map((kind) => ({ kind, scopeId: null, key: kind })),
    ...approved.model.acts.flatMap((act) => act.scenes.map((scene) => (
      { kind: "scene" as const, scopeId: scene.id, key: `scene:${scene.id}` }
    ))),
  ];
  const artifacts: { key: string; artifact: StudyArtifact }[] = [];
  const omittedSections: string[] = [];

  for (const request of requests) {
    let validationError: string | undefined;
    let accepted: StudyArtifact | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let candidate: StudyArtifact;
      try {
        candidate = await options.generator.generateStudySection({
          play: approved.model, kind: request.kind, scopeId: request.scopeId, validationError,
        });
      } catch {
        accepted = fallbackStudyArtifact(approved.model, request.kind, request.scopeId);
        break;
      }
      try {
        const validated = validateStudyArtifact(candidate, approved.model);
        if (validated.kind !== request.kind || validated.scopeId !== request.scopeId) {
          throw new Error("STUDY_SECTION_SCOPE_MISMATCH");
        }
        accepted = validated;
        break;
      } catch (error) {
        validationError = error instanceof Error ? error.message : String(error);
      }
    }
    if (accepted) artifacts.push({ key: request.key, artifact: accepted });
    else omittedSections.push(request.key);
  }

  const status = omittedSections.length === 0 ? "completed" : "completed_with_limitations";
  const generatedAt = options.generatedAt ?? new Date();
  await options.db.transaction(async (transaction) => {
    await assertActiveJobLease(transaction, options.ownerUserId, job.id, {
      leaseToken: options.leaseToken, attemptCount: options.attemptCount,
    });
    await transaction.update(analysisArtifacts).set({ status: "stale", updatedAt: generatedAt }).where(and(
      eq(analysisArtifacts.ownerUserId, options.ownerUserId), eq(analysisArtifacts.playId, job.playId!),
      inArray(analysisArtifacts.kind, requests.map(({ key }) => key)), eq(analysisArtifacts.status, "current"),
    ));
    if (artifacts.length > 0) {
      await transaction.insert(analysisArtifacts).values(artifacts.map(({ key, artifact }) => ({
        id: (options.createId ?? randomUUID)(), ownerUserId: options.ownerUserId, playId: job.playId!,
        kind: key, content: artifact, status: "current", promptVersion: options.promptVersion,
        modelName: options.modelName, playModelVersion: version, generatedAt,
      })));
    }
    await transaction.update(jobs).set({ status, errorCode: omittedSections.length > 0
      ? `INVALID_STUDY_SECTION:${omittedSections.join(",")}` : null,
    leaseExpiresAt: null, leaseToken: null, updatedAt: generatedAt }).where(and(
      eq(jobs.id, job.id), eq(jobs.ownerUserId, options.ownerUserId),
      eq(jobs.attemptCount, options.attemptCount), eq(jobs.leaseToken, options.leaseToken),
    ));
    await transaction.update(plays).set({ status: "study_ready", updatedAt: generatedAt }).where(and(
      eq(plays.id, job.playId!), eq(plays.ownerUserId, options.ownerUserId),
    ));
  });
  return { status, omittedSections };
}

function numberPayload(value: unknown, message: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(message);
  return value as number;
}
