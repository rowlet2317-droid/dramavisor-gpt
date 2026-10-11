import type { StudyGenerator } from "@drama/ai/study/port";
import { fallbackRoleWorkbook } from "@drama/ai/study/fallback";
import { lockActiveOwner } from "@drama/db/repositories/auth";
import { StudyRepository } from "@drama/db/repositories/study";
import type * as schema from "@drama/db/schema";
import { validateRoleWorkbook } from "@drama/domain/study";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";

type RouteContext = { params: Promise<{ playId: string }> };
type Dependencies<TQueryResult extends PgQueryResultHKT> = {
  authenticate: () => Promise<{ id: string }>;
  db: PgDatabase<TQueryResult, typeof schema>;
  generator: StudyGenerator;
  promptVersion: string;
  modelName: string;
  now?: () => Date;
};

const RequestSchema = z.object({
  characterId: z.string().min(1),
  directorConcept: z.string().trim().min(1).optional(),
});

export function createMyRoleHandler<TQueryResult extends PgQueryResultHKT>(dependencies: Dependencies<TQueryResult>) {
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
    const body = RequestSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return Response.json({ error: "Invalid role request" }, { status: 422 });
    const { playId } = await context.params;
    const repository = new StudyRepository(dependencies.db);
    if (!await repository.getOwnedPlay(user.id, playId)) {
      return Response.json({ error: "Play not found" }, { status: 404 });
    }
    const approved = await repository.getApprovedModel(user.id, playId);
    if (!approved) return Response.json({ error: "Approved Play Model not found" }, { status: 404 });
    if (!approved.model.characters.some((character) => character.id === body.data.characterId)) {
      return Response.json({ error: "Character is not in the approved Play Model" }, { status: 422 });
    }

    const directorConcept = body.data.directorConcept ?? null;
    let validationError: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let generation: Promise<Awaited<ReturnType<StudyGenerator["generateRoleWorkbook"]>>> | undefined;
      const active = await dependencies.db.transaction(async (transaction) => {
        if (!await lockActiveOwner(transaction, user.id)) return false;
        generation = dependencies.generator.generateRoleWorkbook({ play: approved.model,
          characterId: body.data.characterId, directorConcept, validationError });
        void generation.catch(() => undefined);
        return true;
      });
      if (!active) return Response.json({ error: "Play not found" }, { status: 404 });
      if (!generation) throw new Error("Role workbook generation did not start");
      let candidate: Awaited<ReturnType<StudyGenerator["generateRoleWorkbook"]>>;
      try {
        candidate = await generation;
      } catch {
        candidate = fallbackRoleWorkbook(approved.model, body.data.characterId, directorConcept);
      }
      try {
        const workbook = validateRoleWorkbook(candidate, approved.model);
        if (workbook.characterId !== body.data.characterId || workbook.directorConcept !== directorConcept) {
          throw new Error("ROLE_WORKBOOK_SCOPE_MISMATCH");
        }
        await repository.replaceRoleWorkbook(user.id, playId, workbook, {
          promptVersion: dependencies.promptVersion, modelName: dependencies.modelName,
          playModelVersion: approved.version, generatedAt: (dependencies.now ?? (() => new Date()))(),
        });
        const notes = await repository.getActorNotes(user.id, playId, body.data.characterId);
        return Response.json({ workbook, actorNotes: notes?.notes ?? {} }, { status: 201 });
      } catch (error) {
        if (error instanceof Error && error.message === "ACCOUNT_NOT_ACTIVE") {
          return Response.json({ error: "Play not found" }, { status: 404 });
        }
        validationError = error instanceof Error ? error.message : String(error);
      }
    }
    return Response.json({ error: "Unable to generate a grounded role workbook" }, { status: 502 });
  };
}

type GeneratorComposition = Pick<Dependencies<PgQueryResultHKT>, "generator" | "promptVersion" | "modelName">;

export function createMyRoleRoute<TQueryResult extends PgQueryResultHKT>(
  dependencies: Omit<Dependencies<TQueryResult>, "generator" | "promptVersion" | "modelName">,
  loadGenerator: () => GeneratorComposition,
) {
  let composition: GeneratorComposition | undefined;
  const getComposition = () => (composition ??= loadGenerator());
  return createMyRoleHandler({
    ...dependencies,
    generator: {
      generateStudySection: (request) => getComposition().generator.generateStudySection(request),
      generateRoleWorkbook: (request) => getComposition().generator.generateRoleWorkbook(request),
    },
    get promptVersion() { return getComposition().promptVersion; },
    get modelName() { return getComposition().modelName; },
  });
}
