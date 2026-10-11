import { randomUUID } from "node:crypto";

import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import { and, desc, eq } from "drizzle-orm";

import * as schema from "../schema";
import { plays } from "../schema";

export type CreatePlayInput = {
  id?: string;
  title: string;
  status?: "processing";
};

export class PlayRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: PgDatabase<TQueryResult, typeof schema>) {}

  async list(ownerUserId: string) {
    return this.db
      .select()
      .from(plays)
      .where(eq(plays.ownerUserId, ownerUserId))
      .orderBy(desc(plays.createdAt));
  }

  async get(ownerUserId: string, playId: string) {
    const rows = await this.db
      .select()
      .from(plays)
      .where(and(eq(plays.id, playId), eq(plays.ownerUserId, ownerUserId)))
      .limit(1);

    return rows[0] ?? null;
  }

  async create(ownerUserId: string, input: CreatePlayInput) {
    const rows = await this.db
      .insert(plays)
      .values({
        id: input.id ?? randomUUID(),
        ownerUserId,
        title: input.title,
        status: input.status ?? "processing",
      })
      .returning();

    return rows[0]!;
  }
}
