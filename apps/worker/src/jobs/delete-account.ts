import { AuthRepository } from "@drama/db/repositories/auth";
import * as schema from "@drama/db/schema";
import { jobs } from "@drama/db/schema";
import type { ObjectStorage } from "@drama/storage/port";
import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { assertActiveJobLease, type JobLease } from "./claim";

type Options<TQueryResult extends PgQueryResultHKT> = JobLease & {
  db: PgDatabase<TQueryResult, typeof schema>;
  ownerUserId: string;
  jobId: string;
  storage: ObjectStorage;
  now?: Date;
};

/** Deletes the persisted inventory first; database cascade is impossible until every delete resolves. */
export async function runDeleteAccountJob<TQueryResult extends PgQueryResultHKT>(
  options: Options<TQueryResult>,
): Promise<"completed" | "already_completed"> {
  const [job] = await options.db.select({ payload: jobs.payload }).from(jobs).where(and(
    eq(jobs.id, options.jobId), eq(jobs.ownerUserId, options.ownerUserId), eq(jobs.kind, "delete_account"),
  )).limit(1);
  if (!job) return "already_completed";
  const deletionId = typeof job.payload.deletionId === "string" ? job.payload.deletionId : null;
  if (!deletionId) throw new Error("INVALID_ACCOUNT_DELETION_JOB");
  await assertActiveJobLease(options.db, options.ownerUserId, options.jobId, options);
  const repository = new AuthRepository(options.db);
  const deletion = await repository.getAccountDeletion(options.ownerUserId, deletionId);
  if (!deletion) return "already_completed";
  assertSafeInventory(options.ownerUserId, deletion.objectInventory);
  for (const objectKey of deletion.objectInventory.objectKeys) await options.storage.purgePrivate(objectKey);
  for (const object of deletion.objectInventory.versionedObjects) await options.storage.purgePrivate(object.objectKey);
  await assertActiveJobLease(options.db, options.ownerUserId, options.jobId, options);
  const outcome = await repository.completeAccountDeletion({ ownerUserId: options.ownerUserId, deletionId,
    completedAt: options.now ?? new Date() });
  if (outcome === "not_ready") throw new Error("ACCOUNT_DELETION_NOT_READY");
  return outcome;
}

function assertSafeInventory(ownerUserId: string, inventory: typeof schema.accountDeletions.$inferSelect["objectInventory"]) {
  const prefix = `users/${ownerUserId}/`;
  if (!inventory.objectKeys.every((objectKey) => objectKey.startsWith(prefix))
    || !inventory.versionedObjects.every(({ objectKey, versionToken }) => objectKey.startsWith(prefix)
      && Boolean(versionToken.trim()))) {
    throw new Error("INVALID_ACCOUNT_DELETION_INVENTORY");
  }
}
