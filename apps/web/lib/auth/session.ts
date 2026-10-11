import { createHash, randomBytes } from "node:crypto";

import { getDatabase } from "@drama/db/client";
import { AuthRepository } from "@drama/db/repositories/auth";
import { cookies } from "next/headers";

export const SESSION_COOKIE_NAME = "drama_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export class UnauthorizedError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "UnauthorizedError";
  }
}

export function createBearerToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashBearerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function readSessionToken(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  for (const pair of cookieHeader.split(";")) {
    const [name, ...value] = pair.trim().split("=");
    if (name === SESSION_COOKIE_NAME) {
      return value.join("=") || undefined;
    }
  }
  return undefined;
}

export function sessionCookie(token: string, expiresAt: Date, now = new Date()): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1_000));
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    ...(process.env.NODE_ENV !== "production" && process.env.SESSION_COOKIE_SECURE?.trim().toLowerCase() === "false"
      ? [] : ["Secure"]),
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export async function requireUser(): Promise<{ id: string }> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    throw new UnauthorizedError();
  }

  const auth = new AuthRepository(getDatabase());
  const session = await auth.findActiveSession(hashBearerToken(token), new Date());
  if (!session) {
    throw new UnauthorizedError();
  }

  return { id: session.ownerUserId };
}
