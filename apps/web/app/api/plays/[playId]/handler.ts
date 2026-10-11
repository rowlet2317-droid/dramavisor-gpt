import { randomUUID } from "node:crypto";

import type * as schema from "@drama/db/schema";
import { lockActiveOwner } from "@drama/db/repositories/auth";
import { jobs, normalizedAudioArtifacts, plays, sourceFiles, takes } from "@drama/db/schema";
import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type RouteContext = { params: Promise<{ playId: string }> };
type Dependencies<TQueryResult extends PgQueryResultHKT> = {
  authenticate: () => Promise<{ id: string }>;
  db: PgDatabase<TQueryResult, typeof schema>;
  createId?: () => string;
};

export function createDeletePlayHandler<TQueryResult extends PgQueryResultHKT>(
  dependencies: Dependencies<TQueryResult>,
) {
  return async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
    let user: { id: string };
    try {
      user = await dependencies.authenticate();
    } catch (error) {
      if (error instanceof Error && error.name === "UnauthorizedError") {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      return Response.json({ error: "Unable to authenticate" }, { status: 500 });
    }
    const { playId } = await context.params;
    const deleted = await dependencies.db.transaction(async (transaction) => {
      if (!await lockActiveOwner(transaction, user.id)) return false;
      const [owned] = await transaction.select({ id: plays.id }).from(plays).where(and(
        eq(plays.id, playId), eq(plays.ownerUserId, user.id))).limit(1).for("update");
      if (!owned) return false;
      const originalObjects = await transaction.select({ objectKey: takes.objectKey }).from(takes).where(and(
        eq(takes.playId, playId), eq(takes.ownerUserId, user.id)));
      const sourceObjects = await transaction.select({ objectKey: sourceFiles.objectKey }).from(sourceFiles).where(and(
        eq(sourceFiles.playId, playId), eq(sourceFiles.ownerUserId, user.id)));
      const normalizedObjects = await transaction.select({ objectKey: normalizedAudioArtifacts.canonicalObjectKey,
        storageVersionToken: normalizedAudioArtifacts.storageVersionToken }).from(normalizedAudioArtifacts)
        .where(and(eq(normalizedAudioArtifacts.playId, playId),
          eq(normalizedAudioArtifacts.ownerUserId, user.id)));
      await transaction.insert(jobs).values({ id: (dependencies.createId ?? randomUUID)(),
        ownerUserId: user.id, kind: "purge_play_audio",
        dedupeKey: `purge_play_audio:${user.id}:${playId}`,
        payload: { playId, originalObjectKeys: [...originalObjects, ...sourceObjects]
          .map(({ objectKey }) => objectKey).filter((key): key is string => key !== null),
          normalizedObjects } }).onConflictDoNothing();
      await transaction.delete(plays).where(and(eq(plays.id, playId), eq(plays.ownerUserId, user.id)));
      return true;
    });
    return deleted ? Response.json({ status: "deletion_queued" }, { status: 202 })
      : Response.json({ error: "Play not found" }, { status: 404 });
  };
}
