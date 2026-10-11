import type { ContextualTutor } from "@drama/ai/tutor/port";
import { lockActiveOwner } from "@drama/db/repositories/auth";
import { StudyRepository } from "@drama/db/repositories/study";
import type * as schema from "@drama/db/schema";
import type { PlayModel, ScriptElement } from "@drama/domain/play-model";
import { RoleWorkbookSchema, StudyArtifactSchema, validateStudyArtifact,
  type RoleWorkbook, type StudyArtifact } from "@drama/domain/study";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";

const INSUFFICIENT_EVIDENCE = "The script does not establish this";
const RequestSchema = z.object({
  question: z.string().trim().min(1).max(2_000),
  context: z.object({
    sceneId: z.string().min(1).optional(),
    characterId: z.string().min(1).optional(),
    elementIds: z.array(z.string().min(1)).max(50).optional(),
  }),
});

type RouteContext = { params: Promise<{ playId: string }> };
type Dependencies<TQueryResult extends PgQueryResultHKT> = {
  authenticate: () => Promise<{ id: string }>;
  db: PgDatabase<TQueryResult, typeof schema>;
  tutor: ContextualTutor;
};

export function createTutorHandler<TQueryResult extends PgQueryResultHKT>(dependencies: Dependencies<TQueryResult>) {
  return async function POST(request: Request, routeContext: RouteContext): Promise<Response> {
    let user: { id: string };
    try {
      user = await dependencies.authenticate();
    } catch (error) {
      if (error instanceof Error && error.name === "UnauthorizedError") {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      return Response.json({ error: "Unable to authenticate" }, { status: 500 });
    }
    const body = RequestSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return Response.json({ error: "Invalid tutor request" }, { status: 422 });
    const { playId } = await routeContext.params;
    const prepared = await dependencies.db.transaction(async (transaction): Promise<PreparedTutor> => {
      if (!await lockActiveOwner(transaction, user.id)) return { status: "not_found" };
      const repository = new StudyRepository(transaction);
      if (!await repository.getOwnedPlay(user.id, playId)) return { status: "not_found" };
      const approved = await repository.getApprovedModel(user.id, playId);
      if (!approved) return { status: "model_not_found" };
      const selected = selectContext(approved.model, body.data.context);
      if (!selected) return { status: "invalid_context" };
      const artifacts = relevantArtifacts(
        await repository.listArtifacts(user.id, playId), body.data.context.sceneId, body.data.context.characterId,
      );
      return { status: "ready", approved, selected, artifacts };
    });
    if (prepared.status === "not_found") {
      return Response.json({ error: "Play not found" }, { status: 404 });
    }
    if (prepared.status === "model_not_found") {
      return Response.json({ error: "Approved Play Model not found" }, { status: 404 });
    }
    if (prepared.status === "invalid_context") {
      return Response.json({ error: "Selected context is not in the approved Play Model" }, { status: 422 });
    }

    let validationError: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let answer: ReturnType<ContextualTutor["answer"]> | undefined;
      const providerStarted = await dependencies.db.transaction(async (transaction) => {
        if (!await lockActiveOwner(transaction, user.id)) return false;
        answer = dependencies.tutor.answer({ question: body.data.question, play: prepared.approved.model,
          context: prepared.selected, artifacts: prepared.artifacts, validationError });
        void answer.catch(() => undefined);
        return true;
      });
      if (!providerStarted) return Response.json({ error: "Play not found" }, { status: 404 });
      if (!answer) throw new Error("Tutor answer did not start");
      const candidate = await answer;
      try {
        const validated = validateStudyArtifact({
          id: "contextual-tutor", kind: "overview", scopeId: null, claims: candidate.claims,
        }, prepared.approved.model);
        const stillActive = await dependencies.db.transaction((transaction) =>
          lockActiveOwner(transaction, user.id));
        if (!stillActive) return Response.json({ error: "Play not found" }, { status: 404 });
        if (!validated.claims.some((claim) => claim.reference !== null)) {
          return Response.json({ answer: INSUFFICIENT_EVIDENCE, claims: [] });
        }
        return Response.json({ answer: candidate.answer, claims: validated.claims });
      } catch (error) {
        validationError = error instanceof Error ? error.message : String(error);
      }
    }
    return Response.json({ error: "Unable to produce a grounded tutor answer" }, { status: 502 });
  };
}

type SelectedContext = NonNullable<ReturnType<typeof selectContext>>;
type PreparedTutor =
  | { status: "not_found" }
  | { status: "model_not_found" }
  | { status: "invalid_context" }
  | { status: "ready"; approved: NonNullable<Awaited<ReturnType<StudyRepository<PgQueryResultHKT>["getApprovedModel"]>>>;
    selected: SelectedContext; artifacts: Array<StudyArtifact | RoleWorkbook> };

export function createTutorRoute<TQueryResult extends PgQueryResultHKT>(
  dependencies: Omit<Dependencies<TQueryResult>, "tutor">,
  loadTutor: () => ContextualTutor,
) {
  let tutor: ContextualTutor | undefined;
  return createTutorHandler({ ...dependencies, tutor: {
    answer: (request) => (tutor ??= loadTutor()).answer(request),
  } });
}

function selectContext(play: PlayModel, context: z.infer<typeof RequestSchema>["context"]): {
  scene: PlayModel["acts"][number]["scenes"][number] | null;
  character: PlayModel["characters"][number] | null;
  elements: ScriptElement[];
} | null {
  const scenes = play.acts.flatMap((act) => act.scenes);
  const elements = scenes.flatMap((scene) => scene.elements);
  const scene = context.sceneId ? scenes.find((candidate) => candidate.id === context.sceneId) ?? null : null;
  const character = context.characterId
    ? play.characters.find((candidate) => candidate.id === context.characterId) ?? null
    : null;
  const selectedElements = (context.elementIds ?? []).map((id) => elements.find((element) => element.id === id));
  if ((context.sceneId && !scene) || (context.characterId && !character) || selectedElements.some((item) => !item)) {
    return null;
  }
  if (scene && selectedElements.some((item) => !scene.elements.some((element) => element.id === item!.id))) {
    return null;
  }
  return { scene, character, elements: selectedElements as ScriptElement[] };
}

function relevantArtifacts(rows: Array<{ kind: string; status: string; content: unknown }>,
  sceneId?: string, characterId?: string): Array<StudyArtifact | RoleWorkbook> {
  const allowedKinds = new Set([
    "overview", "themes", "dramatic_structure", "characters", "relationships",
    ...(sceneId ? [`scene:${sceneId}`] : []),
    ...(characterId ? [`role_workbook:${characterId}`] : []),
  ]);
  const artifacts: Array<StudyArtifact | RoleWorkbook> = [];
  for (const row of rows) {
    if (row.status !== "current" || !allowedKinds.has(row.kind)) continue;
    const parsed = row.kind.startsWith("role_workbook:")
      ? RoleWorkbookSchema.safeParse(row.content)
      : StudyArtifactSchema.safeParse(row.content);
    if (parsed.success) artifacts.push(parsed.data);
  }
  return artifacts;
}
