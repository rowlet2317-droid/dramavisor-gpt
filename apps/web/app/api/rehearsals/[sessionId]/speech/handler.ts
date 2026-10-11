import { lockActiveOwner } from "@drama/db/repositories/auth";
import { RehearsalRepository } from "@drama/db/repositories/rehearsal";
import { characterVoiceAssignments, rehearsalSessions } from "@drama/db/schema";
import type * as schema from "@drama/db/schema";
import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";

type SynthesisInput = { exactText: string; voice: string; signal?: AbortSignal };
type SynthesisResult = { bytes: Uint8Array; mediaType: "audio/mpeg" };
type Dependencies<TQueryResult extends PgQueryResultHKT> = {
  authenticate: () => Promise<{ id: string }>;
  db: PgDatabase<TQueryResult, typeof schema>;
  synthesize: (input: SynthesisInput) => Promise<SynthesisResult>;
};
type SpeechCheck = { status: "not_found" | "conflict" }
  | { status: "ready"; exactText: string; voice: string };

const RequestSchema = z.object({ elementId: z.string().trim().min(1) }).strict();

export function createRehearsalSpeechHandler<TQueryResult extends PgQueryResultHKT>(
  dependencies: Dependencies<TQueryResult>,
) {
  return async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }): Promise<Response> {
    let user: { id: string };
    try {
      user = await dependencies.authenticate();
    } catch (error) {
      if (error instanceof Error && error.name === "UnauthorizedError") {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      return Response.json({ error: "Unable to authenticate" }, { status: 500 });
    }
    const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid rehearsal speech request" }, { status: 422 });
    const { sessionId } = await context.params;
    const prepared = await dependencies.db.transaction(async (transaction) => {
      if (!await lockActiveOwner(transaction, user.id)) return { status: "not_found" as const };
      return loadSpeechCheck(transaction, user.id, sessionId, parsed.data.elementId);
    });
    if (prepared.status !== "ready") return speechErrorResponse(prepared.status);

    let generated: SynthesisResult;
    try {
      generated = await dependencies.synthesize({ exactText: prepared.exactText, voice: prepared.voice,
        signal: request.signal });
    } catch {
      return Response.json({ error: "Unable to generate rehearsal speech" }, { status: 502 });
    }
    if (generated.mediaType !== "audio/mpeg" || generated.bytes.byteLength === 0) {
      return Response.json({ error: "Unable to generate rehearsal speech" }, { status: 502 });
    }

    const finalized = await dependencies.db.transaction(async (transaction) => {
      if (!await lockActiveOwner(transaction, user.id)) return { status: "not_found" as const };
      return loadSpeechCheck(transaction, user.id, sessionId, parsed.data.elementId);
    });
    if (finalized.status !== "ready") return speechErrorResponse(finalized.status);
    if (finalized.exactText !== prepared.exactText || finalized.voice !== prepared.voice) {
      return speechErrorResponse("conflict");
    }
    return new Response(generated.bytes as Uint8Array<ArrayBuffer>, { status: 200,
      headers: { "content-type": generated.mediaType, "cache-control": "private, no-store" } });
  };
}

async function loadSpeechCheck<TQueryResult extends PgQueryResultHKT>(
  db: PgDatabase<TQueryResult, typeof schema>, ownerUserId: string, sessionId: string, elementId: string,
): Promise<SpeechCheck> {
  const [session] = await db.select().from(rehearsalSessions).where(and(
    eq(rehearsalSessions.ownerUserId, ownerUserId), eq(rehearsalSessions.id, sessionId),
  )).for("update").limit(1);
  if (!session) return { status: "not_found" };
  if (session.state !== "active") return { status: "conflict" };
  const state = await new RehearsalRepository(db).rehydrate(ownerUserId, sessionId);
  const action = state?.pendingAction;
  if (!state || state.status !== "active" || action?.type !== "speak" || action.elementId !== elementId
    || state.cursorElementId !== elementId || action.characterId === session.actorRoleId) {
    return { status: "conflict" };
  }
  const line = state.lines.find((candidate) => candidate.elementId === elementId
    && candidate.characterId === action.characterId);
  if (!line) return { status: "conflict" };
  const [assignment] = await db.select({ voice: characterVoiceAssignments.voice })
    .from(characterVoiceAssignments).where(and(
      eq(characterVoiceAssignments.ownerUserId, ownerUserId),
      eq(characterVoiceAssignments.rehearsalSessionId, sessionId),
      eq(characterVoiceAssignments.characterId, action.characterId),
    )).limit(1);
  return assignment ? { status: "ready", exactText: line.text, voice: assignment.voice } : { status: "conflict" };
}

function speechErrorResponse(status: Exclude<SpeechCheck["status"], "ready">): Response {
  return status === "not_found"
    ? Response.json({ error: "Rehearsal session not found" }, { status: 404 })
    : Response.json({ error: "Rehearsal speech is no longer available" }, { status: 409 });
}
