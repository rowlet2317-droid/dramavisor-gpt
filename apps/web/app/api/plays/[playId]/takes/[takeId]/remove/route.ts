import { getDatabase } from "@drama/db/client";
import { jobs, normalizedAudioArtifacts, takes } from "@drama/db/schema";
import { S3ObjectStorage } from "@drama/storage/s3-storage";
import { and, eq, sql } from "drizzle-orm";

import { requireUser } from "../../../../../../../lib/auth/session";
import { getRuntimeDependencies } from "../../../../../../../lib/runtime-composition";

type RouteContext = { params: Promise<{ playId: string; takeId: string }> };

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  const user = await requireUser();
  const { playId, takeId } = await context.params;
  const db = getDatabase();
  const [take] = await db.select({ objectKey: takes.objectKey }).from(takes).where(and(
    eq(takes.id, takeId), eq(takes.playId, playId), eq(takes.ownerUserId, user.id),
  )).limit(1);
  if (!take) return Response.json({ error: "Take not found" }, { status: 404 });
  const artifacts = await db.select({ objectKey: normalizedAudioArtifacts.canonicalObjectKey })
    .from(normalizedAudioArtifacts).where(and(eq(normalizedAudioArtifacts.ownerUserId, user.id),
      eq(normalizedAudioArtifacts.takeId, takeId)));
  const injected = getRuntimeDependencies();
  const storage = injected?.storage ?? new S3ObjectStorage({ bucket: process.env.S3_PRIVATE_BUCKET ?? "" });
  for (const { objectKey } of [{ objectKey: take.objectKey }, ...artifacts]) await storage.purgePrivate(objectKey);
  const removed = await db.transaction(async (transaction) => {
    await transaction.delete(jobs).where(and(eq(jobs.ownerUserId, user.id), eq(jobs.playId, playId),
      sql`${jobs.payload} ->> 'takeId' = ${takeId}::text`));
    return transaction.delete(takes).where(and(eq(takes.id, takeId), eq(takes.playId, playId),
      eq(takes.ownerUserId, user.id))).returning({ id: takes.id });
  });
  return removed.length ? new Response(null, { status: 204 })
    : Response.json({ error: "Take not found" }, { status: 404 });
}
