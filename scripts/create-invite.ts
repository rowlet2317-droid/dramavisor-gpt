import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createDatabase } from "../packages/db/src/client";
import { AuthRepository } from "../packages/db/src/repositories/auth";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

type InviteStore = {
  findUserByEmail(email: string): Promise<{ id: string } | null>;
  createInvite(email: string, tokenHash: string, expiresAt: Date): Promise<unknown>;
};

type ClosableDatabase = {
  $client: { end(): Promise<void> };
};

export async function withDatabaseCleanup<T>(
  database: ClosableDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } finally {
    await database.$client.end();
  }
}

export async function createInvite(
  email: string,
  store: InviteStore,
  now = new Date(),
  baseUrl = process.env.APP_URL ?? "http://localhost:3000",
): Promise<string> {
  const normalizedEmail = email.trim().toLowerCase();
  if (await store.findUserByEmail(normalizedEmail)) {
    throw new Error(`An account already exists for ${normalizedEmail}`);
  }
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await store.createInvite(normalizedEmail, tokenHash, new Date(now.getTime() + INVITE_TTL_MS));
  return new URL(`/invite/${token}`, baseUrl).toString();
}

async function main() {
  const emailFlag = process.argv.indexOf("--email");
  const email = emailFlag >= 0 ? process.argv[emailFlag + 1] : undefined;
  if (!email || !email.includes("@")) {
    throw new Error("Usage: create-invite --email actor@example.com");
  }

  const database = createDatabase();
  await withDatabaseCleanup(database, async () => {
    const url = await createInvite(email, new AuthRepository(database));
    process.stdout.write(`${url}\n`);
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
