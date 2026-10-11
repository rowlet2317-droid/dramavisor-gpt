import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteQueryResultHKT } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../schema";
import { plays } from "../schema";
import { PlayRepository } from "./plays";

describe("PlayRepository owner scoping", () => {
  let client: PGlite;
  let repo: PlayRepository<PgliteQueryResultHKT>;

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(`
      CREATE TABLE plays (
        id uuid PRIMARY KEY,
        owner_user_id text NOT NULL,
        title text NOT NULL,
        status text NOT NULL DEFAULT 'processing',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    repo = new PlayRepository(drizzle(client, { schema }));
  });

  afterEach(async () => {
    await client.close();
  });

  it("does not return another actor's play", async () => {
    const play = await repo.create("user_a", { title: "Private Play" });

    await expect(repo.get("user_b", play.id)).resolves.toBeNull();
  });

  it("returns the owner's play and excludes it from another owner's list", async () => {
    const play = await repo.create("user_a", { title: "Private Play" });

    await expect(repo.get("user_a", play.id)).resolves.toMatchObject({
      id: play.id,
      ownerUserId: "user_a",
      title: "Private Play",
    });
    await expect(repo.list("user_a")).resolves.toHaveLength(1);
    await expect(repo.list("user_b")).resolves.toEqual([]);
  });
});
