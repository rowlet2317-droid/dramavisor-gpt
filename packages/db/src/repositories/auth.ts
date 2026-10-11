import { randomUUID } from "node:crypto";

import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import * as schema from "../schema";
import { accountDeletions, accountDeletionAudits, inviteTokens, normalizedAudioArtifacts, rehearsalSessions,
  privateObjectCleanupTasks, sourceFiles, sessions, takes, users } from "../schema";
import type { AccountDeletionObjectInventory } from "../schema";

/** Holds the account row lock until the caller's surrounding transaction finishes. */
export async function lockActiveOwner<TQueryResult extends PgQueryResultHKT>(
  db: PgDatabase<TQueryResult, typeof schema>, ownerUserId: string,
): Promise<boolean> {
  const [user] = await db.select({ id: users.id }).from(users).where(and(
    eq(users.id, ownerUserId), eq(users.accountStatus, "active"),
  )).for("update").limit(1);
  return Boolean(user);
}

export type AcceptInviteResult =
  | { status: "accepted"; user: typeof users.$inferSelect }
  | { status: "expired" }
  | { status: "existing_user" }
  | { status: "invalid" }
  | { status: "used" };

export type AcceptInviteInput = {
  tokenHash: string;
  passwordHash: string;
  sessionTokenHash: string;
  sessionExpiresAt: Date;
  now: Date;
};

export type AccountDeletionRequestResult =
  | { status: "queued"; deletionId: string }
  | { status: "not_found" };

export class AuthRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(
    private readonly db: PgDatabase<TQueryResult, typeof schema>,
    private readonly claimClock: SQL = sql`clock_timestamp()`,
  ) {}

  async createInvite(email: string, tokenHash: string, expiresAt: Date) {
    const rows = await this.db
      .insert(inviteTokens)
      .values({ email: email.trim().toLowerCase(), tokenHash, expiresAt })
      .returning();
    return rows[0]!;
  }

  async acceptInvite(input: AcceptInviteInput): Promise<AcceptInviteResult> {
    return this.db.transaction(async (tx) => {
      const [invite] = await tx
        .select()
        .from(inviteTokens)
        .where(eq(inviteTokens.tokenHash, input.tokenHash))
        .limit(1);

      if (!invite) {
        return { status: "invalid" };
      }
      if (invite.usedAt) {
        return { status: "used" };
      }
      if (invite.expiresAt <= input.now) {
        return { status: "expired" };
      }

      const claimed = await tx
        .update(inviteTokens)
        .set({ usedAt: this.claimClock })
        .where(and(
          eq(inviteTokens.id, invite.id),
          isNull(inviteTokens.usedAt),
          gt(inviteTokens.expiresAt, this.claimClock),
        ))
        .returning({ id: inviteTokens.id });
      if (claimed.length === 0) {
        const [currentInvite] = await tx
          .select({ usedAt: inviteTokens.usedAt })
          .from(inviteTokens)
          .where(eq(inviteTokens.id, invite.id))
          .limit(1);
        if (!currentInvite) {
          return { status: "invalid" };
        }
        return currentInvite.usedAt ? { status: "used" } : { status: "expired" };
      }

      const [user] = await tx
        .insert(users)
        .values({ email: invite.email, passwordHash: input.passwordHash })
        .onConflictDoNothing({ target: users.email })
        .returning();
      if (!user) {
        return { status: "existing_user" };
      }
      await tx.insert(sessions).values({
        ownerUserId: user!.id,
        tokenHash: input.sessionTokenHash,
        expiresAt: input.sessionExpiresAt,
      });

      return { status: "accepted", user: user! };
    });
  }

  async findUserByEmail(email: string) {
    const rows = await this.db
      .select({ id: users.id, email: users.email, passwordHash: users.passwordHash, accountStatus: users.accountStatus })
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(1);
    return rows[0] ?? null;
  }

  async findUserById(userId: string) {
    const [user] = await this.db.select({ id: users.id, passwordHash: users.passwordHash,
      accountStatus: users.accountStatus }).from(users).where(eq(users.id, userId)).limit(1);
    return user ?? null;
  }

  async requestAccountDeletion(input: { ownerUserId: string; now: Date; createId?: () => string })
    : Promise<AccountDeletionRequestResult> {
    const createId = input.createId ?? randomUUID;
    return this.db.transaction(async (transaction) => {
      const [user] = await transaction.select({ id: users.id }).from(users).where(eq(users.id, input.ownerUserId))
        .for("update").limit(1);
      if (!user) return { status: "not_found" };
      const [existing] = await transaction.select({ id: accountDeletions.id }).from(accountDeletions)
        .where(eq(accountDeletions.ownerUserId, input.ownerUserId)).limit(1);
      if (existing) return { status: "queued", deletionId: existing.id };

      await transaction.update(users).set({ accountStatus: "deleting", updatedAt: input.now })
        .where(eq(users.id, input.ownerUserId));
      await transaction.update(sessions).set({ revokedAt: input.now }).where(and(
        eq(sessions.ownerUserId, input.ownerUserId), isNull(sessions.revokedAt),
      ));
      await transaction.update(rehearsalSessions).set({ state: "stopped", grantExpiresAt: input.now,
        updatedAt: input.now }).where(eq(rehearsalSessions.ownerUserId, input.ownerUserId));
      await transaction.update(schema.jobs).set({ status: "action_required", errorCode: "ACCOUNT_DELETION_PENDING",
        leaseToken: null, leaseExpiresAt: null, updatedAt: input.now }).where(and(
        eq(schema.jobs.ownerUserId, input.ownerUserId), ne(schema.jobs.kind, "delete_account"),
        inArray(schema.jobs.status, ["queued", "running"]),
      ));
      const inventory = await collectAccountObjectInventory(transaction, input.ownerUserId);
      const deletionId = createId();
      await transaction.insert(accountDeletions).values({ id: deletionId, ownerUserId: input.ownerUserId,
        objectInventory: inventory, createdAt: input.now });
      await transaction.insert(schema.jobs).values({ id: createId(), ownerUserId: input.ownerUserId,
        kind: "delete_account", dedupeKey: `delete_account:${input.ownerUserId}`, payload: { deletionId },
        availableAt: input.now, updatedAt: input.now });
      return { status: "queued", deletionId };
    });
  }

  async getAccountDeletion(ownerUserId: string, deletionId: string) {
    const [deletion] = await this.db.select().from(accountDeletions).where(and(
      eq(accountDeletions.ownerUserId, ownerUserId), eq(accountDeletions.id, deletionId),
    )).limit(1);
    return deletion ?? null;
  }

  async completeAccountDeletion(input: { ownerUserId: string; deletionId: string; completedAt: Date })
    : Promise<"completed" | "already_completed" | "not_ready"> {
    return this.db.transaction(async (transaction) => {
      const [deletion] = await transaction.select().from(accountDeletions).where(and(
        eq(accountDeletions.ownerUserId, input.ownerUserId), eq(accountDeletions.id, input.deletionId),
      )).for("update").limit(1);
      if (!deletion) {
        const [audit] = await transaction.select({ id: accountDeletionAudits.id }).from(accountDeletionAudits)
          .where(eq(accountDeletionAudits.deletionId, input.deletionId)).limit(1);
        return audit ? "already_completed" : "not_ready";
      }
      const [user] = await transaction.select({ accountStatus: users.accountStatus }).from(users)
        .where(eq(users.id, input.ownerUserId)).limit(1);
      if (!user || user.accountStatus !== "deleting") return "not_ready";
      await transaction.insert(accountDeletionAudits).values({ deletionId: deletion.id,
        objectCount: deletion.objectInventory.objectKeys.length + deletion.objectInventory.versionedObjects.length,
        completedAt: input.completedAt });
      await transaction.delete(privateObjectCleanupTasks).where(eq(privateObjectCleanupTasks.ownerUserId, input.ownerUserId));
      await transaction.delete(users).where(eq(users.id, input.ownerUserId));
      return "completed";
    });
  }

  async rotateSession(input: {
    ownerUserId: string;
    previousTokenHash?: string;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [activeUser] = await tx.select({ id: users.id }).from(users).where(and(
        eq(users.id, input.ownerUserId), eq(users.accountStatus, "active"),
      )).for("update").limit(1);
      if (!activeUser) return false;
      if (input.previousTokenHash) {
        await tx
          .update(sessions)
          .set({ revokedAt: input.now })
          .where(and(
            eq(sessions.ownerUserId, input.ownerUserId),
            eq(sessions.tokenHash, input.previousTokenHash),
            isNull(sessions.revokedAt),
          ));
      }

      const rows = await tx
        .insert(sessions)
        .values({
          ownerUserId: input.ownerUserId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        })
        .returning();
      return Boolean(rows[0]);
    });
  }

  async findActiveSession(tokenHash: string, now: Date) {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ))
      .limit(1);
    return rows[0] ?? null;
  }
}

async function collectAccountObjectInventory<TQueryResult extends PgQueryResultHKT>(
  db: PgDatabase<TQueryResult, typeof schema>, ownerUserId: string,
): Promise<AccountDeletionObjectInventory> {
  const [sources, accountTakes, normalized, cleanup, cleanupJobs] = await Promise.all([
    db.select({ objectKey: sourceFiles.objectKey }).from(sourceFiles).where(eq(sourceFiles.ownerUserId, ownerUserId)),
    db.select({ objectKey: takes.objectKey }).from(takes).where(eq(takes.ownerUserId, ownerUserId)),
    db.select({ objectKey: normalizedAudioArtifacts.canonicalObjectKey,
      versionToken: normalizedAudioArtifacts.storageVersionToken }).from(normalizedAudioArtifacts)
      .where(eq(normalizedAudioArtifacts.ownerUserId, ownerUserId)),
    db.select({ objectKey: privateObjectCleanupTasks.objectKey,
      versionToken: privateObjectCleanupTasks.storageVersionToken }).from(privateObjectCleanupTasks).where(and(
      eq(privateObjectCleanupTasks.ownerUserId, ownerUserId),
      inArray(privateObjectCleanupTasks.status, ["queued", "action_required"]),
    )),
    db.select({ kind: schema.jobs.kind, payload: schema.jobs.payload }).from(schema.jobs).where(and(
      eq(schema.jobs.ownerUserId, ownerUserId),
      inArray(schema.jobs.status, ["queued", "action_required"]),
      inArray(schema.jobs.kind, ["delete_private_object", "purge_play_audio"]),
    )),
  ]);
  const cleanupJobInventory = collectCleanupJobInventory(ownerUserId, cleanupJobs);
  const versionedObjects = new Map<string, { objectKey: string; versionToken: string }>();
  for (const object of [...normalized, ...cleanup, ...cleanupJobInventory.versionedObjects]) {
    versionedObjects.set(`${object.objectKey}\0${object.versionToken}`, object);
  }
  return {
    objectKeys: [...new Set([...sources.flatMap(({ objectKey }) => objectKey ? [objectKey] : []),
      ...accountTakes.map(({ objectKey }) => objectKey), ...cleanupJobInventory.objectKeys])].sort(),
    versionedObjects: [...versionedObjects.values()]
      .sort((left, right) => left.objectKey.localeCompare(right.objectKey) || left.versionToken.localeCompare(right.versionToken)),
  };
}

function collectCleanupJobInventory(ownerUserId: string, jobs: Array<{ kind: string; payload: Record<string, unknown> }>) {
  const prefix = `users/${ownerUserId}/`;
  const objectKeys: string[] = [];
  const versionedObjects: Array<{ objectKey: string; versionToken: string }> = [];
  for (const job of jobs) {
    if (job.kind === "delete_private_object" && typeof job.payload.objectKey === "string"
      && job.payload.objectKey.startsWith(prefix)) {
      objectKeys.push(job.payload.objectKey);
      continue;
    }
    if (job.kind !== "purge_play_audio" || typeof job.payload.playId !== "string" || !job.payload.playId.trim()
      || !Array.isArray(job.payload.originalObjectKeys) || !Array.isArray(job.payload.normalizedObjects)) {
      throw new Error("INVALID_PRIVATE_OBJECT_CLEANUP_IDENTITY");
    }
    const playPrefix = `${prefix}plays/${job.payload.playId}/`;
    if (!job.payload.originalObjectKeys.every((key) => typeof key === "string" && key.startsWith(playPrefix))) {
      throw new Error("INVALID_PRIVATE_OBJECT_CLEANUP_IDENTITY");
    }
    const normalized = job.payload.normalizedObjects.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const object = value as Record<string, unknown>;
      return typeof object.objectKey === "string" && object.objectKey.startsWith(playPrefix)
        && typeof object.storageVersionToken === "string" && object.storageVersionToken.trim()
        ? [{ objectKey: object.objectKey, versionToken: object.storageVersionToken }] : [];
    });
    if (normalized.length !== job.payload.normalizedObjects.length) {
      throw new Error("INVALID_PRIVATE_OBJECT_CLEANUP_IDENTITY");
    }
    objectKeys.push(...job.payload.originalObjectKeys);
    versionedObjects.push(...normalized);
  }
  return { objectKeys, versionedObjects };
}
