import type { RealtimeCredentialIssuer } from "@drama/ai/realtime/port";
import { lockActiveOwner } from "@drama/db/repositories/auth";
import { RehearsalRepository } from "@drama/db/repositories/rehearsal";
import { StudyRepository } from "@drama/db/repositories/study";
import { rehearsalSessions } from "@drama/db/schema";
import type * as schema from "@drama/db/schema";
import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { emitOperationalEvent } from "../../../../../lib/observability/sink";

type Dependencies<TQueryResult extends PgQueryResultHKT> = {
  authenticate: () => Promise<{ id: string }>;
  credentials: RealtimeCredentialIssuer;
  db: PgDatabase<TQueryResult, typeof schema>;
  now?: () => Date;
};

export function createResumeRehearsalHandler<TQueryResult extends PgQueryResultHKT>(
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
      emitOperationalEvent({ type: "realtime.authentication_failure", state: "unauthorized", error });
      return Response.json({ error: "Unable to authenticate" }, { status: 500 });
    }
    const input = await request.json().catch(() => null) as { clientLastSequence?: unknown;
      playModelVersion?: unknown } | null;
    if (!input || !Number.isInteger(input.clientLastSequence) || (input.clientLastSequence as number) < 0
      || !Number.isInteger(input.playModelVersion) || (input.playModelVersion as number) < 1) {
      return Response.json({ error: "Invalid recovery request" }, { status: 422 });
    }
    const { sessionId } = await context.params;
    const clientLastSequence = input.clientLastSequence as number;
    const now = (dependencies.now ?? (() => new Date()))();
    let issuance: Promise<Awaited<ReturnType<RealtimeCredentialIssuer["issue"]>>> | undefined;
    const prepared = await dependencies.db.transaction(async (transaction): Promise<RecoveryCheck> => {
      if (!await lockActiveOwner(transaction, user.id)) return { status: "not_found" };
      const recovery = await loadRecoveryCheck(transaction, user.id, sessionId, clientLastSequence);
      if (recovery.status !== "ready") return recovery;
      issuance = dependencies.credentials.issue({ userId: user.id, purpose: { type: "actor_input" } });
      void issuance.catch(() => undefined);
      return recovery;
    });
    if (prepared.status !== "ready") return recoveryErrorResponse(prepared);
    if (!issuance) throw new Error("Realtime credential issuance did not start");

    let issued: Awaited<ReturnType<RealtimeCredentialIssuer["issue"]>>;
    try {
      issued = await issuance;
    } catch (error) {
      emitOperationalEvent({ type: "realtime.provider_failure", state: "failed", error, userId: user.id,
        sessionId });
      return Response.json({ error: "Unable to create realtime session" }, { status: 502 });
    }
    const expiryMs = new Date(issued.expiresAt).getTime();
    if (!Number.isFinite(expiryMs) || expiryMs <= now.getTime() || expiryMs - now.getTime() > 600_000) {
      return Response.json({ error: "Invalid realtime credential expiry" }, { status: 502 });
    }

    const result = await dependencies.db.transaction(async (transaction): Promise<ResumeResult> => {
      if (!await lockActiveOwner(transaction, user.id)) return { status: "not_found" };
      const recovery = await loadRecoveryCheck(transaction, user.id, sessionId, clientLastSequence);
      if (recovery.status !== "ready") return recovery;
      await transaction.update(rehearsalSessions).set({ grantExpiresAt: new Date(issued.expiresAt),
        updatedAt: now }).where(and(eq(rehearsalSessions.ownerUserId, user.id),
        eq(rehearsalSessions.id, sessionId)));
      return { ...recovery, status: "issued", issued };
    });
    if (result.status !== "issued") return recoveryErrorResponse(result);
    return Response.json({ grant: { ...result.issued, rehearsalSessionId: sessionId },
      recovery: { events: result.snapshot.events, serverLastSequence: result.serverLastSequence,
        serverPlayModelVersion: result.currentModelVersion,
        clientPlayModelVersion: input.playModelVersion, assignments: result.snapshot.assignments } });
  };
}

type RecoverySnapshot = NonNullable<Awaited<ReturnType<
  RehearsalRepository<PgQueryResultHKT>["recoverySnapshot"]
>>>;
type RecoveryCheck =
  | { status: "not_found" }
  | { status: "model_not_found" }
  | { status: "stopped" }
  | { status: "completed" }
  | { status: "client_ahead" }
  | { status: "ready"; snapshot: RecoverySnapshot; currentModelVersion: number; serverLastSequence: number };
type ResumeResult = Exclude<RecoveryCheck, { status: "ready" }>
  | ({ status: "issued"; issued: Awaited<ReturnType<RealtimeCredentialIssuer["issue"]>> }
    & Omit<Extract<RecoveryCheck, { status: "ready" }>, "status">);

async function loadRecoveryCheck<TQueryResult extends PgQueryResultHKT>(
  db: PgDatabase<TQueryResult, typeof schema>, ownerUserId: string, sessionId: string,
  clientLastSequence: number,
): Promise<RecoveryCheck> {
  const snapshot = await new RehearsalRepository(db).recoverySnapshot(ownerUserId, sessionId);
  if (!snapshot) return { status: "not_found" };
  const currentModel = await new StudyRepository(db).getApprovedModel(ownerUserId, snapshot.session.playId);
  if (!currentModel) return { status: "model_not_found" };
  if (snapshot.session.state === "stopped") return { status: "stopped" };
  if (snapshot.session.state === "completed") return { status: "completed" };
  const serverLastSequence = snapshot.events.at(-1)?.sequence ?? 0;
  if (clientLastSequence > serverLastSequence) return { status: "client_ahead" };
  return { status: "ready", snapshot, currentModelVersion: currentModel.version, serverLastSequence };
}

function recoveryErrorResponse(result: Exclude<RecoveryCheck, { status: "ready" }>): Response {
  if (result.status === "not_found") {
    return Response.json({ error: "Rehearsal session not found" }, { status: 404 });
  }
  if (result.status === "model_not_found") {
    return Response.json({ error: "Current approved play model not found" }, { status: 409 });
  }
  if (result.status === "stopped") {
    return Response.json({ error: "Rehearsal session has stopped" }, { status: 409 });
  }
  if (result.status === "completed") {
    return Response.json({ error: "Rehearsal session cannot resume" }, { status: 409 });
  }
  if (result.status === "client_ahead") {
    return Response.json({ error: "Client sequence is ahead of the server" }, { status: 409 });
  }
  const unreachable: never = result;
  return unreachable;
}
