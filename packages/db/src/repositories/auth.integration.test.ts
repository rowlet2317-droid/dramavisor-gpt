import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteQueryResultHKT } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../schema";
import { inviteTokens, sessions, users } from "../schema";
import { AuthRepository } from "./auth";

const migrationUrl = new URL("../../migrations/0001_foundation.sql", import.meta.url);
const accountDeletionMigrationUrl = new URL("../../migrations/0019_account_deletion.sql", import.meta.url);

describe("AuthRepository invite claims", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let auth: AuthRepository<PgliteQueryResultHKT>;

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(await readFile(migrationUrl, "utf8"));
    await client.exec(await readFile(accountDeletionMigrationUrl, "utf8"));
    db = drizzle(client, { schema });
    auth = new AuthRepository(db);
  });

  afterEach(async () => {
    await client.close();
  });

  it("does not claim an invite that expired after request-time validation", async () => {
    const requestTime = new Date(Date.now() - 2_000);
    const expiredAfterRequest = new Date(Date.now() - 1_000);
    await db.insert(inviteTokens).values({
      email: "actor@example.com",
      tokenHash: "stale-request-time-hash",
      expiresAt: expiredAfterRequest,
    });

    const result = await auth.acceptInvite({
      tokenHash: "stale-request-time-hash",
      passwordHash: "derived-password-hash",
      sessionTokenHash: "new-session-hash",
      sessionExpiresAt: new Date(Date.now() + 60_000),
      now: requestTime,
    });

    expect(result).toEqual({ status: "expired" });
    expect(await db.select().from(users)).toHaveLength(0);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("uses statement claim time rather than transaction-start time", async () => {
    const transactionStart = new Date();
    const expiresAfterTransactionStart = new Date(transactionStart.getTime() + 60_000);
    const actualClaimTime = new Date(transactionStart.getTime() + 120_000);
    const claimTimeSql = sql`${actualClaimTime.toISOString()}::timestamptz`;
    const claimTimeAuth = new AuthRepository(db, claimTimeSql);
    await db.insert(inviteTokens).values({
      email: "actor@example.com",
      tokenHash: "claim-time-hash",
      expiresAt: expiresAfterTransactionStart,
    });

    const result = await claimTimeAuth.acceptInvite({
      tokenHash: "claim-time-hash",
      passwordHash: "derived-password-hash",
      sessionTokenHash: "new-session-hash",
      sessionExpiresAt: new Date(actualClaimTime.getTime() + 60_000),
      now: transactionStart,
    });

    expect(result).toEqual({ status: "expired" });
    expect(await db.select().from(users)).toHaveLength(0);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });
});
