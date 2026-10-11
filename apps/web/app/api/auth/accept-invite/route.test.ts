import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteQueryResultHKT } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthRepository } from "@drama/db/repositories/auth";
import * as schema from "@drama/db/schema";
import { inviteTokens, sessions, users } from "@drama/db/schema";
import { hashBearerToken, SESSION_COOKIE_NAME } from "../../../../lib/auth/session";
import { createAcceptInviteHandler } from "./handler";

const migrationUrl = new URL("../../../../../../packages/db/migrations/0001_foundation.sql", import.meta.url);
const accountDeletionMigrationUrl = new URL("../../../../../../packages/db/migrations/0019_account_deletion.sql", import.meta.url);
const inviteExpiryAfterTestStart = () => new Date(Date.now() + 60 * 60 * 1000);

describe("POST /api/auth/accept-invite", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let auth: AuthRepository<PgliteQueryResultHKT>;

  beforeEach(async () => {
    vi.stubEnv("SESSION_COOKIE_SECURE", "true");
    client = new PGlite();
    await client.exec(await readFile(migrationUrl, "utf8"));
    await client.exec(await readFile(accountDeletionMigrationUrl, "utf8"));
    db = drizzle(client, { schema });
    auth = new AuthRepository(db);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await client.close();
  });

  it("returns 410 for an expired invite", async () => {
    const rawToken = "expired-token";
    await db.insert(inviteTokens).values({
      email: "actor@example.com",
      tokenHash: hashBearerToken(rawToken),
      expiresAt: new Date("2026-07-31T12:00:00Z"),
    });

    const response = await createAcceptInviteHandler(auth, () => new Date("2026-08-01T12:00:00Z"))(
      request({ token: rawToken, password: "correct horse battery staple" }),
    );

    expect(response.status).toBe(410);
  });

  it("returns 409 for a used invite", async () => {
    const rawToken = "used-token";
    await db.insert(inviteTokens).values({
      email: "actor@example.com",
      tokenHash: hashBearerToken(rawToken),
      expiresAt: inviteExpiryAfterTestStart(),
      usedAt: new Date("2026-08-01T11:00:00Z"),
    });

    const response = await createAcceptInviteHandler(auth, () => new Date("2026-08-01T12:00:00Z"))(
      request({ token: rawToken, password: "correct horse battery staple" }),
    );

    expect(response.status).toBe(409);
  });

  it("creates the invited user and an HttpOnly session cookie", async () => {
    const rawToken = "valid-token";
    await db.insert(inviteTokens).values({
      email: "actor@example.com",
      tokenHash: hashBearerToken(rawToken),
      expiresAt: inviteExpiryAfterTestStart(),
    });

    const response = await createAcceptInviteHandler(auth, () => new Date("2026-08-01T12:00:00Z"))(
      request({ token: rawToken, password: "correct horse battery staple" }),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.user.email).toBe("actor@example.com");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=2592000");
    const [createdUser] = await db.select().from(users).where(eq(users.email, "actor@example.com"));
    expect(createdUser!.passwordHash).not.toBe("correct horse battery staple");
    const [createdSession] = await db.select().from(sessions);
    const rawSessionToken = cookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))?.[1] ?? "";
    expect(Buffer.from(rawSessionToken, "base64url")).toHaveLength(32);
    expect(createdSession!.tokenHash).toBe(hashBearerToken(rawSessionToken));
    expect(createdSession!.tokenHash).not.toBe(rawSessionToken);
  });

  it("sets the session and redirects a native form submission in one response", async () => {
    const rawToken = "native-form-token";
    await db.insert(inviteTokens).values({
      email: "form@example.com",
      tokenHash: hashBearerToken(rawToken),
      expiresAt: inviteExpiryAfterTestStart(),
    });

    const response = await createAcceptInviteHandler(auth, () => new Date("2026-08-01T12:00:00Z"))(
      formRequest({ token: rawToken, password: "correct horse battery staple" }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(await db.select().from(users).where(eq(users.email, "form@example.com"))).toHaveLength(1);
  });

  it("rejects passwords shorter than twelve characters", async () => {
    const rawToken = "short-password-token";
    await db.insert(inviteTokens).values({
      email: "actor@example.com",
      tokenHash: hashBearerToken(rawToken),
      expiresAt: inviteExpiryAfterTestStart(),
    });

    const response = await createAcceptInviteHandler(auth, () => new Date("2026-08-01T12:00:00Z"))(
      request({ token: rawToken, password: "too short" }),
    );

    expect(response.status).toBe(400);
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("rejects passwords longer than 1024 bytes", async () => {
    const rawToken = "long-password-token";
    await db.insert(inviteTokens).values({
      email: "actor@example.com",
      tokenHash: hashBearerToken(rawToken),
      expiresAt: inviteExpiryAfterTestStart(),
    });

    const response = await createAcceptInviteHandler(auth, () => new Date("2026-08-01T12:00:00Z"))(
      request({ token: rawToken, password: "a".repeat(1025) }),
    );

    expect(response.status).toBe(400);
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("returns 409 and consumes an invite for an existing account", async () => {
    await db.insert(users).values({
      email: "actor@example.com",
      passwordHash: "existing-password-hash",
    });
    const rawToken = "duplicate-email-token";
    const [invite] = await db.insert(inviteTokens).values({
      email: "actor@example.com",
      tokenHash: hashBearerToken(rawToken),
      expiresAt: inviteExpiryAfterTestStart(),
    }).returning();

    const response = await createAcceptInviteHandler(auth, () => new Date("2026-08-01T12:00:00Z"))(
      request({ token: rawToken, password: "correct horse battery staple" }),
    );

    expect(response.status).toBe(409);
    const [consumed] = await db.select().from(inviteTokens).where(eq(inviteTokens.id, invite!.id));
    expect(consumed!.usedAt).toBeInstanceOf(Date);
  });
});

function request(body: Record<string, string>) {
  return new Request("http://localhost/api/auth/accept-invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function formRequest(body: Record<string, string>) {
  return new Request("http://localhost/api/auth/accept-invite", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}
