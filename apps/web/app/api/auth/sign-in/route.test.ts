import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteQueryResultHKT } from "drizzle-orm/pglite";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthRepository } from "@drama/db/repositories/auth";
import * as schema from "@drama/db/schema";
import { sessions, users } from "@drama/db/schema";
import { hashPassword } from "../../../../lib/auth/password";
import { hashBearerToken, SESSION_COOKIE_NAME } from "../../../../lib/auth/session";
import { createSignInHandler } from "./handler";

const migrationUrl = new URL("../../../../../../packages/db/migrations/0001_foundation.sql", import.meta.url);
const accountDeletionMigrationUrl = new URL("../../../../../../packages/db/migrations/0019_account_deletion.sql", import.meta.url);

describe("POST /api/auth/sign-in", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let auth: AuthRepository<PgliteQueryResultHKT>;
  let userId: string;

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(await readFile(migrationUrl, "utf8"));
    await client.exec(await readFile(accountDeletionMigrationUrl, "utf8"));
    db = drizzle(client, { schema });
    auth = new AuthRepository(db);
    const [user] = await db.insert(users).values({
      email: "actor@example.com",
      passwordHash: await hashPassword("correct horse battery staple"),
    }).returning();
    userId = user!.id;
  });

  afterEach(async () => {
    await client.close();
  });

  it("returns 401 for a wrong password", async () => {
    const response = await createSignInHandler(auth, () => new Date("2026-08-01T12:00:00Z"))(
      request({ email: "actor@example.com", password: "wrong" }),
    );

    expect(response.status).toBe(401);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("does not issue a session to an account being deleted", async () => {
    await db.update(users).set({ accountStatus: "deleting" }).where(eq(users.id, userId));

    const response = await createSignInHandler(auth, () => new Date("2026-08-01T12:00:00Z"))(
      request({ email: "actor@example.com", password: "correct horse battery staple" }),
    );

    expect(response.status).toBe(401);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("does not issue a session when deletion starts after password verification", async () => {
    const racingAuth = {
      findUserByEmail: auth.findUserByEmail.bind(auth),
      rotateSession: async (input: Parameters<typeof auth.rotateSession>[0]) => {
        await db.update(users).set({ accountStatus: "deleting" }).where(eq(users.id, userId));
        return auth.rotateSession(input);
      },
    };

    const response = await createSignInHandler(racingAuth, () => new Date("2026-08-01T12:00:00Z"))(
      request({ email: "actor@example.com", password: "correct horse battery staple" }),
    );

    expect(response.status).toBe(401);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("rejects a password over 1024 bytes before password verification", async () => {
    const response = await createSignInHandler(
      auth,
      () => new Date("2026-08-01T12:00:00Z"),
      async () => {
        throw new Error("password verification must not run");
      },
    )(request({ email: "actor@example.com", password: "a".repeat(1025) }));

    expect(response.status).toBe(400);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("rotates an existing session after successful sign-in", async () => {
    const oldRawToken = "old-session-token";
    await db.insert(sessions).values({
      ownerUserId: userId,
      tokenHash: hashBearerToken(oldRawToken),
      expiresAt: new Date("2026-08-08T12:00:00Z"),
    });

    const response = await createSignInHandler(auth, () => new Date("2026-08-01T12:00:00Z"))(
      request(
        { email: "actor@example.com", password: "correct horse battery staple" },
        `${SESSION_COOKIE_NAME}=${oldRawToken}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=2592000");
    const [oldSession] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashBearerToken(oldRawToken)));
    expect(oldSession!.revokedAt).toEqual(new Date("2026-08-01T12:00:00Z"));
    expect(await db.select().from(sessions).where(and(eq(sessions.ownerUserId, userId), isNull(sessions.revokedAt))))
      .toHaveLength(1);
  });

  it("sets the session and redirects a native form submission in one response", async () => {
    const response = await createSignInHandler(auth, () => new Date("2026-08-01T12:00:00Z"))(
      formRequest({ email: "actor@example.com", password: "correct horse battery staple" }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/plays");
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(await db.select().from(sessions).where(and(eq(sessions.ownerUserId, userId), isNull(sessions.revokedAt))))
      .toHaveLength(1);
  });
});

function request(body: Record<string, string>, cookie?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie) {
    headers.set("cookie", cookie);
  }
  return new Request("http://localhost/api/auth/sign-in", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function formRequest(body: Record<string, string>) {
  return new Request("http://localhost/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}
