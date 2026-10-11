import type * as schema from "@drama/db/schema";
import { jobs, normalizedAudioArtifacts, takes } from "@drama/db/schema";
import type { ObjectStorage } from "@drama/storage/port";
import { and, eq, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { assertActiveJobLease, type JobLease, StaleJobLeaseError } from "./claim";

type JobDatabase<TQueryResult extends PgQueryResultHKT> = PgDatabase<TQueryResult, typeof schema>;

type PurgeOptions<TQueryResult extends PgQueryResultHKT> = {
  db: JobDatabase<TQueryResult>;
  ownerUserId: string;
  takeId: string;
  storage: ObjectStorage;
  deletedAt?: Date;
};

type PurgeJobOptions<TQueryResult extends PgQueryResultHKT> = JobLease & {
  db: JobDatabase<TQueryResult>;
  ownerUserId: string;
  jobId: string;
  storage: ObjectStorage;
  now?: Date;
};

export async function purgeTakeAudio<TQueryResult extends PgQueryResultHKT>(
  options: PurgeOptions<TQueryResult>,
): Promise<boolean> {
  const [take] = await options.db.select().from(takes).where(and(eq(takes.id, options.takeId),
    eq(takes.ownerUserId, options.ownerUserId))).limit(1);
  if (!take) return false;
  if (take.audioDeletedAt) return true;
  const artifacts = await options.db.select().from(normalizedAudioArtifacts).where(and(
    eq(normalizedAudioArtifacts.ownerUserId, options.ownerUserId),
    eq(normalizedAudioArtifacts.takeId, options.takeId)));
  await options.storage.purgePrivate(take.objectKey);
  for (const artifact of artifacts) {
    await options.storage.purgePrivate(artifact.canonicalObjectKey);
  }
  await options.db.update(takes).set({ audioDeletedAt: options.deletedAt ?? new Date() }).where(and(
    eq(takes.id, options.takeId), eq(takes.ownerUserId, options.ownerUserId), isNull(takes.audioDeletedAt)));
  return true;
}

export async function runPurgeTakeAudioJob<TQueryResult extends PgQueryResultHKT>(
  options: PurgeJobOptions<TQueryResult>,
): Promise<void> {
  await assertActiveJobLease(options.db, options.ownerUserId, options.jobId, options);
  const [job] = await options.db.select().from(jobs).where(and(eq(jobs.id, options.jobId),
    eq(jobs.ownerUserId, options.ownerUserId), eq(jobs.kind, "purge_take_audio"))).limit(1);
  const takeId = job && typeof job.payload.takeId === "string" ? job.payload.takeId : null;
  if (!takeId || !await purgeTakeAudio({ db: options.db, ownerUserId: options.ownerUserId, takeId,
    storage: options.storage, deletedAt: options.now })) throw new Error("INVALID_AUDIO_PURGE_CHAIN");
  const [completed] = await options.db.update(jobs).set({ status: "completed", errorCode: null,
    leaseToken: null, leaseExpiresAt: null, updatedAt: options.now ?? new Date() }).where(and(
    eq(jobs.id, options.jobId), eq(jobs.ownerUserId, options.ownerUserId), eq(jobs.status, "running"),
    eq(jobs.attemptCount, options.attemptCount), eq(jobs.leaseToken, options.leaseToken))).returning();
  if (!completed) throw new StaleJobLeaseError();
}

export async function runPurgePlayAudioJob<TQueryResult extends PgQueryResultHKT>(
  options: PurgeJobOptions<TQueryResult>,
): Promise<void> {
  await assertActiveJobLease(options.db, options.ownerUserId, options.jobId, options);
  const [job] = await options.db.select().from(jobs).where(and(eq(jobs.id, options.jobId),
    eq(jobs.ownerUserId, options.ownerUserId), eq(jobs.kind, "purge_play_audio"))).limit(1);
  const inventory = parsePlayInventory(job?.payload, options.ownerUserId);
  if (!inventory) throw new Error("INVALID_PLAY_AUDIO_PURGE");
  for (const objectKey of inventory.originalObjectKeys) await options.storage.purgePrivate(objectKey);
  for (const object of inventory.normalizedObjects) {
    await options.storage.purgePrivate(object.objectKey);
  }
  const [completed] = await options.db.update(jobs).set({ status: "completed", errorCode: null,
    leaseToken: null, leaseExpiresAt: null, updatedAt: options.now ?? new Date() }).where(and(
    eq(jobs.id, options.jobId), eq(jobs.ownerUserId, options.ownerUserId), eq(jobs.status, "running"),
    eq(jobs.attemptCount, options.attemptCount), eq(jobs.leaseToken, options.leaseToken))).returning();
  if (!completed) throw new StaleJobLeaseError();
}

function parsePlayInventory(payload: Record<string, unknown> | undefined, ownerUserId: string) {
  if (!payload || typeof payload.playId !== "string" || !Array.isArray(payload.originalObjectKeys)
    || !Array.isArray(payload.normalizedObjects)) return null;
  const prefix = `users/${ownerUserId}/plays/${payload.playId}/`;
  if (!payload.originalObjectKeys.every((value) => typeof value === "string" && value.startsWith(prefix))) {
    return null;
  }
  const normalizedObjects = payload.normalizedObjects.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const object = value as Record<string, unknown>;
    return typeof object.objectKey === "string" && object.objectKey.startsWith(prefix)
      && typeof object.storageVersionToken === "string" && object.storageVersionToken.trim()
      ? [{ objectKey: object.objectKey, storageVersionToken: object.storageVersionToken }] : [];
  });
  if (normalizedObjects.length !== payload.normalizedObjects.length) return null;
  return { originalObjectKeys: payload.originalObjectKeys as string[], normalizedObjects };
}
