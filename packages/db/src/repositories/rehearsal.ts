import type { PersistedRehearsalEvent, RehearsalState } from "@drama/domain/rehearsal/types";
import { createRehearsalState } from "@drama/domain/rehearsal/controller";
import { reduceRehearsal, RehearsalSequenceError } from "@drama/domain/rehearsal/reducer";
import { validateTransition } from "@drama/domain/rehearsal/transitions";
import { and, asc, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import * as schema from "../schema";
import { characterVoiceAssignments, playModels, rehearsalEvents, rehearsalSessions } from "../schema";
import { lockActiveOwner } from "./auth";

export class RehearsalRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: PgDatabase<TQueryResult, typeof schema>) {}

  async appendEvent(input: { ownerUserId: string; sessionId: string; event: PersistedRehearsalEvent;
    receivedAt?: Date }) {
    return this.appendTimedEvent(input);
  }

  async appendTrustedProviderEvent(input: { ownerUserId: string; sessionId: string;
    event: PersistedRehearsalEvent; receivedAt?: Date;
    providerTiming: { atMs: number; clockId: string } }) {
    if (input.event.type !== "ai_speech_finished" && input.event.type !== "actor_line_final") {
      throw new Error("INVALID_TRUSTED_PROVIDER_EVENT_TYPE");
    }
    if (!Number.isFinite(input.providerTiming.atMs) || input.providerTiming.atMs < 0
      || !input.providerTiming.clockId.trim()) throw new Error("INVALID_TRUSTED_PROVIDER_TIMING");
    return this.appendTimedEvent(input);
  }

  private async appendTimedEvent(input: { ownerUserId: string; sessionId: string;
    event: PersistedRehearsalEvent; receivedAt?: Date;
    providerTiming?: { atMs: number; clockId: string } }) {
    return this.db.transaction(async (transaction) => {
      if (!await lockActiveOwner(transaction, input.ownerUserId)) throw new Error("ACCOUNT_NOT_ACTIVE");
      const [session] = await transaction.select().from(rehearsalSessions)
        .where(and(eq(rehearsalSessions.ownerUserId, input.ownerUserId),
          eq(rehearsalSessions.id, input.sessionId))).for("update").limit(1);
      if (!session) throw new Error("Rehearsal session not found");

      const storedEvents = await transaction.select({ sequence: rehearsalEvents.sequence, event: rehearsalEvents.event })
        .from(rehearsalEvents)
        .where(and(eq(rehearsalEvents.ownerUserId, input.ownerUserId),
          eq(rehearsalEvents.rehearsalSessionId, input.sessionId)))
        .orderBy(asc(rehearsalEvents.sequence));
      const latest = storedEvents.at(-1);
      const expectedSequence = (latest?.sequence ?? 0) + 1;
      const [modelRow] = await transaction.select({ model: playModels.model }).from(playModels).where(and(
        eq(playModels.ownerUserId, input.ownerUserId), eq(playModels.id, session.playModelId),
        eq(playModels.version, session.playModelVersion),
      )).limit(1);
      if (!modelRow) throw new Error("Pinned rehearsal model not found");
      const scene = modelRow.model.acts.flatMap(({ scenes }) => scenes).find(({ id }) => id === session.sceneId);
      if (!scene) throw new Error("Pinned rehearsal scene not found");
      const initial = createRehearsalState({ sessionId: input.sessionId, actorRoleId: session.actorRoleId,
        lines: scene.elements.filter((element) => element.kind === "dialogue").map((element) => ({
          elementId: element.id, ordinal: element.ordinal, characterId: element.characterId, text: element.text,
        })) });
      const reduced = storedEvents.reduce((state, row) => reduceRehearsal(state, row.event), initial);
      const statusOverride = session.state === "recovering" || session.state === "stopped"
        || session.state === "completed" ? session.state : reduced.status;
      const authoritativeState = { ...reduced, status: statusOverride };
      const status = authoritativeState.status;
      if (latest?.sequence === input.event.sequence && isDeepStrictEqual(latest.event, input.event)) {
        const transition = validateTransition(status, input.event, { identicalRetry: true });
        if (transition.legal === false) throw new RehearsalTransitionError(transition.code);
        const [stored] = await transaction.select().from(rehearsalEvents).where(and(
          eq(rehearsalEvents.ownerUserId, input.ownerUserId),
          eq(rehearsalEvents.rehearsalSessionId, input.sessionId),
          eq(rehearsalEvents.sequence, input.event.sequence),
        )).limit(1);
        return { ...stored!, idempotent: true };
      }
      if (input.event.sequence !== expectedSequence) {
        throw new RehearsalSequenceError(expectedSequence, input.event.sequence);
      }
      const transition = validateTransition(status, input.event);
      if (transition.legal === false) throw new RehearsalTransitionError(transition.code);

      const receivedAtMs = (input.receivedAt ?? new Date()).getTime();
      const timing = input.providerTiming;
      const [stored] = await transaction.insert(rehearsalEvents).values({
        ownerUserId: input.ownerUserId,
        rehearsalSessionId: input.sessionId,
        sequence: input.event.sequence,
        type: input.event.type,
        event: input.event,
        receivedAtMs,
        receivedClockId: "server:unix-epoch-ms",
        timingSource: timing ? "provider-derived" : "server-receipt",
        timingAtMs: timing?.atMs ?? receivedAtMs,
        timingClockId: timing?.clockId ?? "server:unix-epoch-ms",
      }).returning();
      const nextState = reduceRehearsal(authoritativeState, input.event);
      await transaction.update(rehearsalSessions).set({ state: storedSessionState(nextState.status),
        updatedAt: new Date() }).where(and(eq(rehearsalSessions.ownerUserId, input.ownerUserId),
        eq(rehearsalSessions.id, input.sessionId)));
      return { ...stored!, idempotent: false };
    });
  }

  async rehydrate(ownerUserId: string, sessionId: string): Promise<RehearsalState | null> {
    const [session] = await this.db.select().from(rehearsalSessions).where(and(
      eq(rehearsalSessions.ownerUserId, ownerUserId), eq(rehearsalSessions.id, sessionId),
    )).limit(1);
    if (!session) return null;

    const [modelRow] = await this.db.select({ model: playModels.model }).from(playModels).where(and(
      eq(playModels.ownerUserId, ownerUserId), eq(playModels.id, session.playModelId),
      eq(playModels.version, session.playModelVersion),
    )).limit(1);
    if (!modelRow) throw new Error("Pinned rehearsal model not found");
    const scene = modelRow.model.acts.flatMap(({ scenes }) => scenes)
      .find(({ id }) => id === session.sceneId);
    if (!scene) throw new Error("Pinned rehearsal scene not found");

    const initial = createRehearsalState({ sessionId, actorRoleId: session.actorRoleId,
      lines: scene.elements.filter((element) => element.kind === "dialogue")
        .map((element) => ({ elementId: element.id, ordinal: element.ordinal,
          characterId: element.characterId, text: element.text })) });
    const storedEvents = await this.db.select({ event: rehearsalEvents.event }).from(rehearsalEvents)
      .where(and(eq(rehearsalEvents.ownerUserId, ownerUserId),
        eq(rehearsalEvents.rehearsalSessionId, sessionId)))
      .orderBy(asc(rehearsalEvents.sequence));
    return storedEvents.reduce((state, row) => reduceRehearsal(state, row.event), initial);
  }

  async recoverySnapshot(ownerUserId: string, sessionId: string) {
    const [session] = await this.db.select().from(rehearsalSessions).where(and(
      eq(rehearsalSessions.ownerUserId, ownerUserId), eq(rehearsalSessions.id, sessionId),
    )).limit(1);
    if (!session) return null;
    const events = await this.db.select({ event: rehearsalEvents.event }).from(rehearsalEvents).where(and(
      eq(rehearsalEvents.ownerUserId, ownerUserId), eq(rehearsalEvents.rehearsalSessionId, sessionId),
    )).orderBy(asc(rehearsalEvents.sequence));
    const assignments = await this.db.select({ characterId: characterVoiceAssignments.characterId,
      voice: characterVoiceAssignments.voice, engine: characterVoiceAssignments.engine })
      .from(characterVoiceAssignments).where(and(eq(characterVoiceAssignments.ownerUserId, ownerUserId),
        eq(characterVoiceAssignments.rehearsalSessionId, sessionId)))
      .orderBy(asc(characterVoiceAssignments.characterId));
    return { session, events: events.map(({ event }) => event), assignments };
  }
}

export class RehearsalTransitionError extends Error {
  constructor(readonly code: "TERMINAL_SESSION" | "PAUSED_SESSION" | "ILLEGAL_TRANSITION") {
    super(code);
    this.name = "RehearsalTransitionError";
  }
}

function storedSessionState(status: RehearsalState["status"]):
  "grant_issued" | "active" | "paused" | "disconnected" | "recovering" | "await_interruption_choice"
  | "needs_position_confirmation" | "stopped" | "completed" {
  if (status === "ready") return "grant_issued";
  return status;
}
