import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createE2eDatabase } from "@drama/db/e2e-client";
import { applyMigrationFiles } from "@drama/db/migrations";
import { inviteTokens } from "@drama/db/schema";
import { installE2eComposition } from "../apps/web/lib/e2e/composition";

void main();

async function main() {
  if (process.env.E2E_TEST_MODE !== "1" || process.env.E2E_DATABASE_PATH !== "memory://") {
    throw new Error("The E2E Next server requires explicit in-memory test mode");
  }
  const projectRoot = process.env.E2E_PROJECT_ROOT;
  if (!projectRoot) throw new Error("E2E_PROJECT_ROOT is required");
  const { client, db } = createE2eDatabase(process.env.E2E_DATABASE_PATH);
  const migrationDirectory = pathToFileURL(`${resolve(projectRoot, "packages/db/migrations")}/`);
  await applyMigrationFiles({
    exec: (sql) => client.exec(sql).then(() => undefined),
    query: async <T>(sql: string, params: unknown[] = []) => (await client.query<T>(sql, params)).rows,
    transaction: (callback) => client.transaction(async (transaction) => callback({
      exec: (sql) => transaction.exec(sql).then(() => undefined),
      query: async <T>(sql: string, params: unknown[] = []) =>
        (await transaction.query<T>(sql, params)).rows,
    })),
  }, migrationDirectory);
  await db.insert(inviteTokens).values([
    invite("flow-invite", "flow@example.com"),
    invite("pdf-upload-invite", "pdf-upload@example.com"),
    invite("owner-invite", "owner@example.com"),
    invite("intruder-invite", "intruder@example.com"),
    invite("plan2-invite", "plan2@example.com"),
    invite("plan2-guided-invite", "plan2-guided@example.com"),
    invite("plan3-reconnect-invite", "plan3-reconnect@example.com"),
    invite("plan3-rehearsal-invite", "plan3-rehearsal@example.com"),
    invite("plan3-production-invite", "plan3-production@example.com"),
  ]);
  installE2eComposition(db);

  const nextStartPath = pathToFileURL(resolve(
    projectRoot, "apps/web/node_modules/next/dist/cli/next-start.js",
  )).href;
  const { nextStart } = await import(nextStartPath) as {
    nextStart: (options: { hostname: string; port: number }, directory: string) => Promise<void>;
  };
  await nextStart({ hostname: "127.0.0.1", port: 3100 }, resolve(projectRoot, "apps/web"));
}

function invite(token: string, email: string) {
  return { email, tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date("2030-01-01T00:00:00.000Z") };
}
