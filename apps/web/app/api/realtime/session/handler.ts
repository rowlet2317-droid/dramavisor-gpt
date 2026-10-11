import { randomUUID } from "node:crypto";

import type { RealtimeCredentialIssuer, RealtimeSessionGrant } from "@drama/ai/realtime/port";
import { StudyRepository } from "@drama/db/repositories/study";
import { lockActiveOwner } from "@drama/db/repositories/auth";
import { characterVoiceAssignments, playModels, rehearsalSessions } from "@drama/db/schema";
import type * as schema from "@drama/db/schema";
import { assignVoices } from "@drama/domain/rehearsal/voice-assignment";
import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { emitOperationalEvent } from "../../../../lib/observability/sink";

type Dependencies<TQueryResult extends PgQueryResultHKT> = {
  authenticate: () => Promise<{ id: string }>;
  db: PgDatabase<TQueryResult, typeof schema>;
  credentials: RealtimeCredentialIssuer;
  createId?: () => string;
  now?: () => Date;
  supportedVoices?: string[];
  ttsConfigured?: boolean;
};

type RealtimeRequest =
  | { type: "start"; playId: string; sceneId: string; actorRoleId: string }
  | { type: "role_output"; rehearsalSessionId: string; roleId: string };

export function createRealtimeSessionHandler<TQueryResult extends PgQueryResultHKT>(
  dependencies: Dependencies<TQueryResult>,
) {
  return async function POST(request: Request): Promise<Response> {
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
    const input = await parseRequest(request);
    if (!input) return Response.json({ error: "Invalid realtime session request" }, { status: 422 });
    if (input.type === "role_output") return issueRoleOutput(dependencies, user.id, input);
    const now = (dependencies.now ?? (() => new Date()))();
    const rehearsalSessionId = (dependencies.createId ?? randomUUID)();
    let issuance: ReturnType<RealtimeCredentialIssuer["issue"]> | undefined;
    let prepared: PreparedRealtime;
    try {
      prepared = await dependencies.db.transaction(async (transaction): Promise<PreparedRealtime> => {
        if (!await lockActiveOwner(transaction, user.id)) return { status: "not_found" };
        const study = new StudyRepository(transaction);
        if (!await study.getOwnedPlay(user.id, input.playId)) return { status: "not_found" };
        const approved = await study.getApprovedModel(user.id, input.playId);
        const scene = approved?.model.acts.flatMap((act) => act.scenes).find(({ id }) => id === input.sceneId);
        if (!approved || !scene || !scene.characterIds.includes(input.actorRoleId)) {
          return { status: "invalid_context" };
        }
        issuance = dependencies.credentials.issue({ userId: user.id, purpose: { type: "actor_input" } });
        void issuance.catch(() => undefined);
        return { status: "ready", approved, scene };
      });
    } catch (error) {
      emitOperationalEvent({ type: "realtime.provider_failure", state: "failed", error, userId: user.id });
      return Response.json({ error: "Unable to create realtime session" }, { status: 502 });
    }
    if (prepared.status === "not_found") return Response.json({ error: "Play not found" }, { status: 404 });
    if (prepared.status === "invalid_context") {
      return Response.json({ error: "Realtime rehearsal context not found" }, { status: 422 });
    }
    if (!issuance) throw new Error("Realtime credential issuance did not start");
    let issued: Awaited<ReturnType<RealtimeCredentialIssuer["issue"]>>;
    try {
      issued = await issuance;
    } catch (error) {
      emitOperationalEvent({ type: "realtime.provider_failure", state: "failed", error, userId: user.id });
      return Response.json({ error: "Unable to create realtime session" }, { status: 502 });
    }
    const assignments = assignVoices(prepared.scene.characterIds.filter((characterId) => characterId !== input.actorRoleId)
      .map((characterId) => ({ playId: input.playId,
      characterId, dialogueCount: prepared.scene.elements.filter((element) => element.kind === "dialogue"
        && element.characterId === characterId).length })), [], dependencies.supportedVoices
          ?? ["alloy", "ash", "cedar", "coral", "echo", "marin", "sage", "shimmer"]);
    try {
      const finalized = await dependencies.db.transaction(async (transaction) => {
        if (!await lockActiveOwner(transaction, user.id)) return false;
        const expiryMs = new Date(issued.expiresAt).getTime();
        if (!Number.isFinite(expiryMs) || expiryMs <= now.getTime() || expiryMs - now.getTime() > 600_000) {
          throw new InvalidCredentialExpiryError();
        }
      await transaction.insert(rehearsalSessions).values({ id: rehearsalSessionId, ownerUserId: user.id,
        playId: input.playId, playModelId: prepared.approved.id, playModelVersion: prepared.approved.version,
        sceneId: input.sceneId, actorRoleId: input.actorRoleId, model: issued.model,
        grantExpiresAt: new Date(issued.expiresAt), state: "grant_issued" });
      if (assignments.length > 0) await transaction.insert(characterVoiceAssignments).values(assignments.map(
        (assignment) => ({ ownerUserId: user.id, rehearsalSessionId, ...assignment }),
      ));
        return true;
      });
      if (!finalized) return Response.json({ error: "Play not found" }, { status: 404 });
    } catch (error) {
      if (error instanceof InvalidCredentialExpiryError) return Response.json({ error: "Invalid realtime credential expiry" }, { status: 502 });
      emitOperationalEvent({ type: "realtime.provider_failure", state: "failed", error, userId: user.id });
      return Response.json({ error: "Unable to create realtime session" }, { status: 502 });
    }
    const grant: RealtimeSessionGrant = { ...issued, rehearsalSessionId };
    return Response.json({ ...grant, assignments, ttsConfigured: dependencies.ttsConfigured === true }, { status: 201 });
  };
}

class InvalidCredentialExpiryError extends Error {}

async function issueRoleOutput<TQueryResult extends PgQueryResultHKT>(
  dependencies: Dependencies<TQueryResult>, userId: string,
  input: Extract<RealtimeRequest, { type: "role_output" }>,
): Promise<Response> {
  const now = (dependencies.now ?? (() => new Date()))();
  const prepared = await dependencies.db.transaction(async (transaction): Promise<RoleOutputCheck> => {
    if (!await lockActiveOwner(transaction, userId)) return { status: "not_found" };
    const [session] = await transaction.select().from(rehearsalSessions).where(and(
      eq(rehearsalSessions.ownerUserId, userId), eq(rehearsalSessions.id, input.rehearsalSessionId),
    )).limit(1);
    if (!session) return { status: "not_found" };
    if (session.state === "stopped" || session.state === "completed") return { status: "stopped" };
    if (session.actorRoleId === input.roleId) return { status: "invalid_context" };
    const [model] = await transaction.select({ model: playModels.model }).from(playModels).where(and(
      eq(playModels.ownerUserId, userId), eq(playModels.id, session.playModelId),
      eq(playModels.playId, session.playId), eq(playModels.version, session.playModelVersion),
    )).limit(1);
    const scene = model?.model.acts.flatMap((act) => act.scenes).find(({ id }) => id === session.sceneId);
    if (!scene || !scene.characterIds.includes(input.roleId)) return { status: "invalid_context" };
    const [assignment] = await transaction.select({ voice: characterVoiceAssignments.voice,
      engine: characterVoiceAssignments.engine }).from(characterVoiceAssignments).where(and(
      eq(characterVoiceAssignments.ownerUserId, userId),
      eq(characterVoiceAssignments.rehearsalSessionId, session.id),
      eq(characterVoiceAssignments.characterId, input.roleId),
    )).limit(1);
    if (!assignment || assignment.engine !== "realtime") return { status: "invalid_context" };
    return { status: "ready", voice: assignment.voice };
  });
  if (prepared.status === "not_found") return Response.json({ error: "Rehearsal session not found" }, { status: 404 });
  if (prepared.status === "stopped") return stoppedGrantResponse();
  if (prepared.status === "invalid_context") {
    return Response.json({ error: "Realtime role context not found" }, { status: 422 });
  }
  let issued: Awaited<ReturnType<RealtimeCredentialIssuer["issue"]>>;
  try {
    issued = await dependencies.credentials.issue({ userId, purpose: { type: "role_output", roleId: input.roleId,
      voice: prepared.voice } });
  } catch (error) {
    emitOperationalEvent({ type: "realtime.provider_failure", state: "failed", error, userId });
    return Response.json({ error: "Unable to create realtime session" }, { status: 502 });
  }
  const expiryMs = new Date(issued.expiresAt).getTime();
  if (!Number.isFinite(expiryMs) || expiryMs <= now.getTime() || expiryMs - now.getTime() > 600_000) {
    return Response.json({ error: "Invalid realtime credential expiry" }, { status: 502 });
  }
  const finalized = await dependencies.db.transaction(async (transaction): Promise<"issued" | "not_found" | "stopped"> => {
    if (!await lockActiveOwner(transaction, userId)) return "not_found";
    const [session] = await transaction.select({ id: rehearsalSessions.id, state: rehearsalSessions.state })
      .from(rehearsalSessions).where(and(
      eq(rehearsalSessions.ownerUserId, userId), eq(rehearsalSessions.id, input.rehearsalSessionId),
    )).limit(1);
    if (!session) return "not_found";
    if (session.state === "stopped" || session.state === "completed") return "stopped";
    await transaction.update(rehearsalSessions).set({ grantExpiresAt: new Date(issued.expiresAt), updatedAt: now })
      .where(and(eq(rehearsalSessions.ownerUserId, userId), eq(rehearsalSessions.id, input.rehearsalSessionId)));
    return "issued";
  });
  if (finalized === "not_found") return Response.json({ error: "Rehearsal session not found" }, { status: 404 });
  if (finalized === "stopped") return stoppedGrantResponse();
  return Response.json({ ...issued, rehearsalSessionId: input.rehearsalSessionId });
}

function stoppedGrantResponse(): Response {
  return Response.json({ error: "Rehearsal session cannot issue another grant" }, { status: 409 });
}

type ApprovedModel = NonNullable<Awaited<ReturnType<StudyRepository<PgQueryResultHKT>["getApprovedModel"]>>>;
type PreparedRealtime =
  | { status: "not_found" }
  | { status: "invalid_context" }
  | { status: "ready"; approved: ApprovedModel;
    scene: ApprovedModel["model"]["acts"][number]["scenes"][number] };
type RoleOutputCheck = { status: "not_found" } | { status: "invalid_context" } | { status: "stopped" }
  | { status: "ready"; voice: string };

async function parseRequest(request: Request): Promise<RealtimeRequest | null> {
  const value = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!value || typeof value.type !== "string") return null;
  if (value.type === "start" && typeof value.playId === "string" && value.playId.trim()
    && typeof value.sceneId === "string" && value.sceneId.trim()
    && typeof value.actorRoleId === "string" && value.actorRoleId.trim()) {
    return { type: "start", playId: value.playId, sceneId: value.sceneId, actorRoleId: value.actorRoleId };
  }
  if (value.type === "role_output" && typeof value.rehearsalSessionId === "string"
    && value.rehearsalSessionId.trim() && typeof value.roleId === "string" && value.roleId.trim()) {
    return { type: "role_output", rehearsalSessionId: value.rehearsalSessionId, roleId: value.roleId };
  }
  return null;
}
