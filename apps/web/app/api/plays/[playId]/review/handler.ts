import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import * as schema from "@drama/db/schema";
import { lockActiveOwner } from "@drama/db/repositories/auth";
import { analysisArtifacts, jobs, playModels, plays } from "@drama/db/schema";
import {
  applyReviewCorrections,
  ParseProposalSchema,
  ReviewPatchSchema,
} from "@drama/domain/parse-review";
import { and, desc, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type RouteContext = { params: Promise<{ playId: string }> };

type ReviewDependencies<TQueryResult extends PgQueryResultHKT> = {
  authenticate: () => Promise<{ id: string }>;
  db: PgDatabase<TQueryResult, typeof schema>;
  createId?: () => string;
};

export function createReviewHandler<TQueryResult extends PgQueryResultHKT>(
  dependencies: ReviewDependencies<TQueryResult>,
) {
  return async function PATCH(request: Request, context: RouteContext): Promise<Response> {
    let user: { id: string };
    try {
      user = await dependencies.authenticate();
    } catch (error) {
      if (error instanceof Error && error.name === "UnauthorizedError") {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      return Response.json({ error: "Unable to authenticate" }, { status: 500 });
    }

    const body = ReviewPatchSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return Response.json({ error: "Invalid review corrections" }, { status: 422 });
    }
    const { playId } = await context.params;
    const [ownedPlay] = await dependencies.db.select({ id: plays.id }).from(plays).where(and(
      eq(plays.id, playId),
      eq(plays.ownerUserId, user.id),
    )).limit(1);
    if (!ownedPlay) return Response.json({ error: "Play not found" }, { status: 404 });

    try {
      const result = await dependencies.db.transaction(async (transaction) => {
        if (!await lockActiveOwner(transaction, user.id)) throw new ReviewNotFoundError();
        await transaction.execute(sql`
          SELECT id
          FROM play_models
          WHERE play_id = ${playId} AND owner_user_id = ${user.id}
          ORDER BY version DESC
          FOR UPDATE
          LIMIT 1
        `);
        const [current] = await transaction.select().from(playModels).where(and(
          eq(playModels.playId, playId),
          eq(playModels.ownerUserId, user.id),
        )).orderBy(desc(playModels.version)).limit(1);
        if (!current) throw new ReviewNotFoundError();

        const [expected] = await transaction.select().from(playModels).where(and(
          eq(playModels.id, body.data.expectedModelId),
          eq(playModels.version, body.data.expectedModelVersion),
          eq(playModels.playId, playId),
          eq(playModels.ownerUserId, user.id),
        )).limit(1);
        if (!expected) throw new ReviewConflictError();

        if (current.id !== expected.id || current.version !== expected.version
          || current.status !== "review_required") {
          const replay = equivalentReplay(current, expected, body.data, playId);
          if (replay) return replay;
          throw new ReviewConflictError();
        }

        const currentProposal = ParseProposalSchema.parse({
          playModel: current.model,
          issues: current.issues,
        });
        const nextVersion = current.version + 1;
        const proposal = applyReviewCorrections(
          currentProposal,
          body.data.corrections,
          playId,
          nextVersion,
        );
        if (body.data.approve && proposal.issues.length > 0) {
          throw new BlockingIssuesError();
        }

        const id = (dependencies.createId ?? randomUUID)();
        const status = body.data.approve ? "approved" : "review_required";
        await transaction.update(playModels).set({ status: "superseded", updatedAt: new Date() }).where(and(
          eq(playModels.id, current.id),
          eq(playModels.ownerUserId, user.id),
          eq(playModels.playId, playId),
        ));
        await transaction.insert(playModels).values({
          id,
          ownerUserId: user.id,
          playId,
          version: nextVersion,
          status,
          model: proposal.playModel,
          issues: proposal.issues,
        });
        await transaction.update(analysisArtifacts).set({ status: "stale", updatedAt: new Date() }).where(and(
          eq(analysisArtifacts.ownerUserId, user.id),
          eq(analysisArtifacts.playId, playId),
          eq(analysisArtifacts.status, "current"),
        ));
        if (body.data.approve) {
          await transaction.insert(jobs).values({
            ownerUserId: user.id,
            playId,
            kind: "generate_study",
            dedupeKey: `generate_study:${playId}:v${nextVersion}`,
            payload: { playModelVersion: nextVersion },
          });
        }
        await transaction.update(plays).set({
          status: body.data.approve ? "study_queued" : "review",
          updatedAt: new Date(),
        }).where(and(eq(plays.id, playId), eq(plays.ownerUserId, user.id)));

        return { id, version: nextVersion, status };
      });
      return Response.json({ model: result });
    } catch (error) {
      if (error instanceof ReviewNotFoundError) {
        return Response.json({ error: "Review not found" }, { status: 404 });
      }
      if (error instanceof BlockingIssuesError) {
        return Response.json({ error: "Resolve all blocking issues before approval" }, { status: 422 });
      }
      if (error instanceof ReviewConflictError) {
        return Response.json({ error: "The reviewed model changed; reload before applying corrections" }, { status: 409 });
      }
      if (error instanceof Error && (
        error.message.startsWith("Correction")
        || error.message.startsWith("Only dialogue")
      )) {
        return Response.json({ error: error.message }, { status: 422 });
      }
      return Response.json({ error: "Unable to update review" }, { status: 500 });
    }
  };
}

class ReviewNotFoundError extends Error {}
class BlockingIssuesError extends Error {}
class ReviewConflictError extends Error {}

function equivalentReplay(
  current: typeof playModels.$inferSelect,
  expected: typeof playModels.$inferSelect,
  patch: typeof ReviewPatchSchema._output,
  playId: string,
) {
  if (current.version !== expected.version + 1) return null;
  const desiredStatus = patch.approve ? "approved" : "review_required";
  if (current.status !== desiredStatus) return null;
  try {
    const proposal = applyReviewCorrections(ParseProposalSchema.parse({ playModel: expected.model,
      issues: expected.issues }), patch.corrections, playId, current.version);
    if (patch.approve && proposal.issues.length > 0) return null;
    if (!isDeepStrictEqual(current.model, proposal.playModel)
      || !isDeepStrictEqual(current.issues, proposal.issues)) return null;
    return { id: current.id, version: current.version, status: current.status };
  } catch {
    return null;
  }
}
