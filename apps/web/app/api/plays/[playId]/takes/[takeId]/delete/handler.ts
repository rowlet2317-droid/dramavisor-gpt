import type * as schema from "@drama/db/schema";
import { lockActiveOwner } from "@drama/db/repositories/auth";
import { normalizedAudioArtifacts, takes } from "@drama/db/schema";
import type { ObjectStorage } from "@drama/storage/port";
import { and, eq, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type RouteContext = { params: Promise<{ playId: string; takeId: string }> };
type Dependencies<TQueryResult extends PgQueryResultHKT> = {
  authenticate: () => Promise<{ id: string }>;
  db: PgDatabase<TQueryResult, typeof schema>;
  storage: ObjectStorage;
  now?: () => Date;
};

export function createDeleteTakeAudioHandler<TQueryResult extends PgQueryResultHKT>(
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
    const { playId, takeId } = await context.params;
    let purgePromise: Promise<void> | undefined;
    const purgePlan = await dependencies.db.transaction(async (transaction) => {
      if (!await lockActiveOwner(transaction, user.id)) return false;
      const [take] = await transaction.select({ objectKey: takes.objectKey,
        audioDeletedAt: takes.audioDeletedAt }).from(takes).where(and(eq(takes.id, takeId),
          eq(takes.playId, playId), eq(takes.ownerUserId, user.id))).limit(1);
      if (!take) return false;
      if (take.audioDeletedAt) return "already_purged" as const;
      const artifacts = await transaction.select({ objectKey: normalizedAudioArtifacts.canonicalObjectKey })
        .from(normalizedAudioArtifacts).where(and(eq(normalizedAudioArtifacts.ownerUserId, user.id),
          eq(normalizedAudioArtifacts.takeId, takeId)));
      purgePromise = purgePrivateObjects(dependencies.storage,
        [take.objectKey, ...artifacts.map(({ objectKey }) => objectKey)]);
      void purgePromise.catch(() => undefined);
      return "started" as const;
    });
    if (!purgePlan) return Response.json({ error: "Take not found" }, { status: 404 });
    if (purgePlan === "already_purged") return new Response(null, { status: 204 });
    if (!purgePromise) throw new Error("Audio purge did not start");

    await purgePromise;
    const finalized = await dependencies.db.transaction(async (transaction) => {
      if (!await lockActiveOwner(transaction, user.id)) return false;
      const [updated] = await transaction.update(takes).set({ audioDeletedAt: dependencies.now?.() ?? new Date() })
        .where(and(eq(takes.id, takeId), eq(takes.playId, playId), eq(takes.ownerUserId, user.id),
          isNull(takes.audioDeletedAt))).returning({ id: takes.id });
      if (updated) return true;
      const [existing] = await transaction.select({ id: takes.id }).from(takes).where(and(eq(takes.id, takeId),
        eq(takes.playId, playId), eq(takes.ownerUserId, user.id))).limit(1);
      return Boolean(existing);
    });
    return finalized ? new Response(null, { status: 204 })
      : Response.json({ error: "Take not found" }, { status: 404 });
  };
}

async function purgePrivateObjects(storage: ObjectStorage, objectKeys: string[]): Promise<void> {
  for (const objectKey of objectKeys) await storage.purgePrivate(objectKey);
}
