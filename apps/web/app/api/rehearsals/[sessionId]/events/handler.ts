import { RehearsalRepository, RehearsalTransitionError } from "@drama/db/repositories/rehearsal";
import type * as schema from "@drama/db/schema";
import { RehearsalSequenceError } from "@drama/domain/rehearsal/reducer";
import type { PersistedRehearsalEvent } from "@drama/domain/rehearsal/types";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type Dependencies<TQueryResult extends PgQueryResultHKT> = {
  authenticate: () => Promise<{ id: string }>;
  db: PgDatabase<TQueryResult, typeof schema>;
  now?: () => Date;
};

export function createRehearsalEventHandler<TQueryResult extends PgQueryResultHKT>(
  dependencies: Dependencies<TQueryResult>,
) {
  return async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
    let user: { id: string };
    try {
      user = await dependencies.authenticate();
    } catch (error) {
      if (error instanceof Error && error.name === "UnauthorizedError") {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      return Response.json({ error: "Unable to authenticate" }, { status: 500 });
    }
    const { sessionId } = await context.params;
    const event = await parseEvent(request);
    if (!event) return Response.json({ error: "Invalid rehearsal event" }, { status: 422 });

    try {
      const stored = await new RehearsalRepository(dependencies.db)
        .appendEvent({ ownerUserId: user.id, sessionId, event,
          receivedAt: dependencies.now?.() ?? new Date() });
      return Response.json({ acknowledgedSequence: event.sequence }, { status: stored.idempotent ? 200 : 201 });
    } catch (error) {
      if (error instanceof Error && error.message === "ACCOUNT_NOT_ACTIVE") {
        return Response.json({ error: "Rehearsal session not found" }, { status: 404 });
      }
      if (error instanceof Error && error.message === "Rehearsal session not found") {
        return Response.json({ error: "Rehearsal session not found" }, { status: 404 });
      }
      if (error instanceof RehearsalSequenceError || error instanceof RehearsalTransitionError) {
        return Response.json({ error: "Rehearsal event conflicts with session state" }, { status: 409 });
      }
      throw error;
    }
  };
}

async function parseEvent(request: Request): Promise<PersistedRehearsalEvent | null> {
  const body = await request.json().catch(() => null) as { event?: unknown } | null;
  return isPersistedEvent(body?.event) ? body.event : null;
}

function isPersistedEvent(value: unknown): value is PersistedRehearsalEvent {
  if (!isRecord(value) || !isPositiveInteger(value.sequence) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "started": return isFiniteNumber(value.startedAtMs);
    case "actor_line_final": return typeof value.text === "string" && isFiniteNumber(value.endedAtMs);
    case "ai_speech_started": return speechIdentity(value) && isFiniteNumber(value.startedAtMs);
    case "ai_speech_finished": return speechIdentity(value) && isFiniteNumber(value.endedAtMs);
    case "cue_requested":
    case "paused":
    case "resumed":
    case "fallback_selected":
    case "stopped": return true;
    case "restart_requested": return value.elementId === undefined || typeof value.elementId === "string";
    case "interrupted": return isFiniteNumber(value.atMs)
      && (value.elementId === undefined || typeof value.elementId === "string");
    case "continue_after_interruption":
    case "restart_line": return typeof value.elementId === "string";
    case "manual_actor_line_completed": return typeof value.elementId === "string"
      && isFiniteNumber(value.endedAtMs);
    case "connection_lost": return typeof value.reason === "string";
    case "position_confirmed": return typeof value.elementId === "string";
    default: return false;
  }
}

function speechIdentity(value: Record<string, unknown>): boolean {
  return typeof value.characterId === "string" && typeof value.elementId === "string";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
