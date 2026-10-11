import { StudyRepository } from "@drama/db/repositories/study";
import type * as schema from "@drama/db/schema";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type RouteContext = { params: Promise<{ playId: string }> };
type Dependencies<TQueryResult extends PgQueryResultHKT> = {
  authenticate: () => Promise<{ id: string }>;
  db: PgDatabase<TQueryResult, typeof schema>;
};

export function createStudyHandler<TQueryResult extends PgQueryResultHKT>(dependencies: Dependencies<TQueryResult>) {
  return async function GET(request: Request, context: RouteContext): Promise<Response> {
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
    const repository = new StudyRepository(dependencies.db);
    const play = await repository.getOwnedPlay(user.id, playId);
    if (!play) return Response.json({ error: "Play not found" }, { status: 404 });
    const approved = await repository.getApprovedModel(user.id, playId);
    if (!approved) return Response.json({ error: "Approved Play Model not found" }, { status: 404 });
    const url = new URL(request.url);
    const section = url.searchParams.get("section");
    const sceneId = url.searchParams.get("sceneId");
    if (section === "scene" && !approved.model.acts.some((act) => act.scenes.some((scene) => scene.id === sceneId))) {
      return Response.json({ error: "Scene not found" }, { status: 404 });
    }
    const artifacts = (await repository.listArtifacts(user.id, playId)).filter((artifact) => {
      if (artifact.status !== "current") return false;
      if (!section) return true;
      if (section === "scene") return artifact.kind === `scene:${sceneId}`;
      return artifact.kind === section;
    });
    return Response.json({ playModel: approved.model, artifacts: artifacts.map((artifact) => artifact.content) });
  };
}
