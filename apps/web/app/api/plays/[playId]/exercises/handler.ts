import { randomUUID } from "node:crypto";

import { StudyRepository } from "@drama/db/repositories/study";
import type * as schema from "@drama/db/schema";
import { analysisArtifacts, coachingReports, takes } from "@drama/db/schema";
import { createExerciseSession, EXERCISE_KINDS, type ExerciseKind } from "@drama/domain/exercises";
import { RoleWorkbookSchema } from "@drama/domain/study";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type RouteContext = { params: Promise<{ playId: string }> };
type Dependencies<TQueryResult extends PgQueryResultHKT> = {
  authenticate: () => Promise<{ id: string }>;
  db: PgDatabase<TQueryResult, typeof schema>;
  createId?: () => string;
  now?: () => Date;
};

type ExerciseRequest = { playModelVersion: number; sceneId: string; roleId: string; kind: ExerciseKind };

export function createExerciseHandler<TQueryResult extends PgQueryResultHKT>(
  dependencies: Dependencies<TQueryResult>,
) {
  return async function POST(request: Request, context: RouteContext): Promise<Response> {
    let user: { id: string };
    try {
      user = await dependencies.authenticate();
    } catch (error) {
      if (error instanceof Error && error.name === "UnauthorizedError") {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      return Response.json({ error: "Unable to authenticate" }, { status: 500 });
    }
    const { playId } = await context.params;
    const study = new StudyRepository(dependencies.db);
    if (!await study.getOwnedPlay(user.id, playId)) {
      return Response.json({ error: "Play not found" }, { status: 404 });
    }
    const input = await parseRequest(request);
    if (!input) return Response.json({ error: "Invalid exercise request" }, { status: 422 });
    const approved = await study.getApprovedModel(user.id, playId, input.playModelVersion);
    const scene = approved?.model.acts.flatMap((act) => act.scenes).find(({ id }) => id === input.sceneId);
    if (!approved || !scene || !scene.characterIds.includes(input.roleId)) {
      return Response.json({ error: "Exercise context not found" }, { status: 422 });
    }
    const [latest] = await dependencies.db.select({ report: coachingReports.report,
      evidence: coachingReports.evidence }).from(coachingReports).innerJoin(takes, and(
      eq(takes.id, coachingReports.takeId), eq(takes.ownerUserId, coachingReports.ownerUserId)))
      .where(and(eq(takes.ownerUserId, user.id), eq(takes.playId, playId), eq(takes.playModelId, approved.id),
        eq(takes.playModelVersion, approved.version), eq(takes.sceneId, scene.id), eq(takes.roleId, input.roleId),
        eq(takes.practiceMode, "complete_take"), inArray(coachingReports.status,
          ["completed", "completed_with_limitations"]))).orderBy(desc(coachingReports.createdAt)).limit(1);
    const [workbookRow] = await dependencies.db.select({ content: analysisArtifacts.content })
      .from(analysisArtifacts).where(and(eq(analysisArtifacts.ownerUserId, user.id),
        eq(analysisArtifacts.playId, playId), eq(analysisArtifacts.kind, `role_workbook:${input.roleId}`),
        eq(analysisArtifacts.status, "current"))).limit(1);
    const workbook = RoleWorkbookSchema.safeParse(workbookRow?.content);
    const roleLines = scene.elements.filter((element) => element.kind === "dialogue"
      && element.characterId === input.roleId);
    const evidenceIds = latest?.report?.exercise.evidenceIds ?? [];
    const targetElementIds = [...new Set((latest?.evidence ?? []).filter(({ id }) => evidenceIds.includes(id))
      .flatMap(({ elementIds }) => elementIds))];
    if (targetElementIds.length === 0 && roleLines[0]) targetElementIds.push(roleLines[0].id);
    if (targetElementIds.length === 0) return Response.json({ error: "Exercise target not found" }, { status: 422 });
    const session = createExerciseSession({ id: (dependencies.createId ?? randomUUID)(), ownerUserId: user.id,
      playId, playModelId: approved.id, playModelVersion: approved.version, sceneId: scene.id,
      roleId: input.roleId, kind: input.kind, targetElementIds,
      prompt: exercisePrompt(input.kind, latest?.report?.exercise.instructions,
        workbook.success ? workbook.data : null), maxTurns: 4, now: dependencies.now?.() });
    return Response.json({ session }, { status: 201 });
  };
}

async function parseRequest(request: Request): Promise<ExerciseRequest | null> {
  const value = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!value || !Number.isInteger(value.playModelVersion) || typeof value.sceneId !== "string"
    || typeof value.roleId !== "string" || typeof value.kind !== "string"
    || !EXERCISE_KINDS.includes(value.kind as ExerciseKind)) return null;
  return value as ExerciseRequest;
}

function exercisePrompt(kind: ExerciseKind, priorInstructions: string | undefined,
  workbook: { sceneObjectives: Array<{ text: string }>; tactics: Array<{ text: string }>;
    subtextOptions: Array<{ text: string }> } | null): string {
  if (kind === "repeat_line" && priorInstructions?.trim()) return priorInstructions.trim();
  if (kind === "change_tactic") return workbook?.tactics[0]?.text ?? "Repeat the line with a different tactic.";
  if (kind === "pause_and_intend") {
    return workbook?.sceneObjectives[0]?.text ?? "Pause, name the intention, then speak the line.";
  }
  if (kind === "alternative_interpretation") {
    return workbook?.subtextOptions[0]?.text ?? "Try one clearly different interpretation of the line.";
  }
  return priorInstructions?.trim() || "Repeat the target line once with full attention.";
}
