import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export function createDatabase(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const client = postgres(databaseUrl);
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDatabase>;

let database: Database | undefined;
type DatabaseGlobal = typeof globalThis & { __dramaE2eDatabase?: Database };

export function getDatabase(): Database {
  const e2eDatabase = (globalThis as DatabaseGlobal).__dramaE2eDatabase;
  if (process.env.E2E_TEST_MODE === "1" && e2eDatabase) return e2eDatabase;
  database ??= createDatabase();
  return database;
}

export function installE2eDatabase(databaseOverride: Database): void {
  if (process.env.E2E_TEST_MODE !== "1") throw new Error("E2E database mode is not enabled");
  (globalThis as DatabaseGlobal).__dramaE2eDatabase = databaseOverride;
}
