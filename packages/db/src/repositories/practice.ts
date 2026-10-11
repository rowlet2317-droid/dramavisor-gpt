import { randomUUID } from "node:crypto";

import type { PracticeMode, RetentionChoice } from "@drama/domain/practice";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import * as schema from "../schema";
import { jobs, practiceSessions, takeEvents, takes, takeStageJobChains } from "../schema";
import { lockActiveOwner } from "./auth";

export type CreateQueuedTakeInput = {
  ownerUserId: string;
  playId: string;
  playModelId: string;
  playModelVersion: number;
  sceneId: string;
  roleId: string;
  selectedInterpretation: string | null;
  retentionChoice: RetentionChoice;
  practiceMode?: PracticeMode;
  rehearsalSessionId?: string | null;
  durationMs: number;
  mediaType: "audio/webm" | "audio/wav";
  objectKey: string;
  sessionId?: string;
  takeId?: string;
};

export class PracticeRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: PgDatabase<TQueryResult, typeof schema>) {}

  async createQueuedTake(input: CreateQueuedTakeInput) {
    return this.db.transaction(async (transaction) => {
      if (!await lockActiveOwner(transaction, input.ownerUserId)) throw new InactiveAccountError();
      return this.createQueuedTakeInTransaction(transaction, input);
    });
  }

  async createQueuedTakeInTransaction(
    transaction: PgDatabase<TQueryResult, typeof schema>, input: CreateQueuedTakeInput,
  ) {
      const sessionId = input.sessionId ?? randomUUID();
      const takeId = input.takeId ?? randomUUID();
      const [session] = await transaction.insert(practiceSessions).values({
        id: sessionId, ownerUserId: input.ownerUserId, playId: input.playId,
        playModelId: input.playModelId, playModelVersion: input.playModelVersion,
        sceneId: input.sceneId, roleId: input.roleId, selectedInterpretation: input.selectedInterpretation,
        retentionChoice: input.retentionChoice, practiceMode: input.practiceMode ?? "complete_take",
      }).returning();
      const [take] = await transaction.insert(takes).values({
        id: takeId, ownerUserId: input.ownerUserId, practiceSessionId: sessionId, playId: input.playId,
        playModelId: input.playModelId, playModelVersion: input.playModelVersion,
        sceneId: input.sceneId, roleId: input.roleId, selectedInterpretation: input.selectedInterpretation,
        retentionChoice: input.retentionChoice, durationMs: input.durationMs, mediaType: input.mediaType,
        objectKey: input.objectKey, state: "queued", practiceMode: input.practiceMode ?? "complete_take",
        rehearsalSessionId: input.rehearsalSessionId ?? null,
      }).returning();
      await transaction.insert(takeEvents).values({
        ownerUserId: input.ownerUserId, takeId, state: "queued", details: {},
      });
      const [job] = await transaction.insert(jobs).values({
        ownerUserId: input.ownerUserId, playId: input.playId, kind: "process_take",
        dedupeKey: `process_take:${takeId}`, payload: { takeId },
      }).returning({ id: jobs.id });
      await transaction.insert(takeStageJobChains).values({
        jobId: job!.id,
        ownerUserId: input.ownerUserId,
        playId: input.playId,
        takeId,
        stageKind: "process_take",
      });
      return { session: session!, take: take! };
  }
}

export class InactiveAccountError extends Error {
  constructor() { super("ACCOUNT_NOT_ACTIVE"); this.name = "InactiveAccountError"; }
}
