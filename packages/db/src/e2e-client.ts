import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { installE2eDatabase, type Database } from "./client";
import * as schema from "./schema";

export function createE2eDatabase(path = "memory://") {
  if (process.env.E2E_TEST_MODE !== "1") throw new Error("E2E database mode is not enabled");
  const client = new PGlite(path);
  const db = drizzle(client, { schema }) as unknown as Database;
  installE2eDatabase(db);
  return { client, db };
}
