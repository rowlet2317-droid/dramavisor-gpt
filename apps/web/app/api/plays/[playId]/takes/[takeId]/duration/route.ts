import { getDatabase } from "@drama/db/client";
import { takes } from "@drama/db/schema";
import { and, eq } from "drizzle-orm";

import { requireUser } from "../../../../../../../lib/auth/session";

const MAX_DURATION_MS = 20 * 60 * 1_000;
type RouteContext = { params: Promise<{ playId: string; takeId: string }> };

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const user = await requireUser();
  const body = await request.json().catch(() => null) as { durationMs?: unknown } | null;
  const durationMs = body?.durationMs;
  if (!Number.isInteger(durationMs) || (durationMs as number) <= 0 || (durationMs as number) > MAX_DURATION_MS) {
    return Response.json({ error: "A valid recording duration is required" }, { status: 422 });
  }
  const { playId, takeId } = await context.params;
  const [updated] = await getDatabase().update(takes).set({ durationMs: durationMs as number }).where(and(
    eq(takes.id, takeId), eq(takes.playId, playId), eq(takes.ownerUserId, user.id), eq(takes.mediaType, "audio/webm"),
  )).returning({ id: takes.id, durationMs: takes.durationMs });
  return updated ? Response.json({ take: updated }) : Response.json({ error: "Take not found" }, { status: 404 });
}
