import { randomUUID } from "node:crypto";

import type { RoleWorkbook, StudyArtifact } from "@drama/domain/study";
import { and, desc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import * as schema from "../schema";
import { actorNotes, analysisArtifacts, playModels, plays } from "../schema";
import { lockActiveOwner } from "./auth";

type Provenance = {
  promptVersion: string;
  modelName: string;
  playModelVersion: number;
  generatedAt: Date;
};

export class StudyRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: PgDatabase<TQueryResult, typeof schema>) {}

  async getApprovedModel(ownerUserId: string, playId: string, version?: number) {
    const conditions = [eq(playModels.ownerUserId, ownerUserId), eq(playModels.playId, playId),
      eq(playModels.status, "approved")];
    if (version !== undefined) conditions.push(eq(playModels.version, version));
    const [row] = await this.db.select().from(playModels).where(and(...conditions))
      .orderBy(desc(playModels.version)).limit(1);
    return row ?? null;
  }

  async getOwnedPlay(ownerUserId: string, playId: string) {
    const [row] = await this.db.select({ id: plays.id }).from(plays).where(and(
      eq(plays.ownerUserId, ownerUserId), eq(plays.id, playId),
    )).limit(1);
    return row ?? null;
  }

  async replaceRoleWorkbook(ownerUserId: string, playId: string, workbook: RoleWorkbook,
    provenance: Provenance) {
    const kind = `role_workbook:${workbook.characterId}`;
    return this.db.transaction(async (transaction) => {
      if (!await lockActiveOwner(transaction, ownerUserId)) throw new Error("ACCOUNT_NOT_ACTIVE");
      const locked = await transaction.select({ id: plays.id }).from(plays).where(and(
        eq(plays.id, playId), eq(plays.ownerUserId, ownerUserId),
      )).for("update").limit(1);
      if (locked.length === 0) throw new Error("Play not found");
      await transaction.update(analysisArtifacts).set({ status: "stale", updatedAt: new Date() }).where(and(
        eq(analysisArtifacts.ownerUserId, ownerUserId), eq(analysisArtifacts.playId, playId),
        eq(analysisArtifacts.kind, kind), eq(analysisArtifacts.status, "current"),
      ));
      const [stored] = await transaction.insert(analysisArtifacts).values({ id: randomUUID(), ownerUserId,
        playId, kind, content: workbook, status: "current", ...provenance }).returning();
      return stored!;
    });
  }

  async listArtifacts(ownerUserId: string, playId: string) {
    return this.db.select().from(analysisArtifacts).where(and(
      eq(analysisArtifacts.ownerUserId, ownerUserId), eq(analysisArtifacts.playId, playId),
    ));
  }

  async getActorNotes(ownerUserId: string, playId: string, characterId: string) {
    const [row] = await this.db.select().from(actorNotes).where(and(
      eq(actorNotes.ownerUserId, ownerUserId), eq(actorNotes.playId, playId),
      eq(actorNotes.characterId, characterId),
    )).limit(1);
    return row ?? null;
  }

  async saveActorNotes(ownerUserId: string, playId: string, characterId: string,
    notes: Record<string, unknown>) {
    return this.db.transaction(async (transaction) => {
      if (!await lockActiveOwner(transaction, ownerUserId)) throw new Error("ACCOUNT_NOT_ACTIVE");
      const [row] = await transaction.insert(actorNotes).values({ ownerUserId, playId, characterId, notes })
        .onConflictDoUpdate({ target: [actorNotes.ownerUserId, actorNotes.playId, actorNotes.characterId],
          set: { notes, updatedAt: new Date() } }).returning();
      return row!;
    });
  }
}
