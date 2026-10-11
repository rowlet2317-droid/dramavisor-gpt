import { getDatabase } from "@drama/db/client";
import { playModels, plays, sourceFiles } from "@drama/db/schema";
import type { ScriptElement } from "@drama/domain/play-model";
import { and, desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { requirePageUser } from "../../../../lib/auth/page-session";
import { ReviewControls } from "../../../../components/review/review-controls";

type ReviewPageProps = { params: Promise<{ playId: string }> };

export default async function ReviewPage({ params }: ReviewPageProps) {
  const user = await requirePageUser();
  const { playId } = await params;
  const db = getDatabase();
  const [play] = await db.select({ id: plays.id, title: plays.title }).from(plays).where(and(
    eq(plays.id, playId),
    eq(plays.ownerUserId, user.id),
  )).limit(1);
  if (!play) notFound();
  const [version] = await db.select().from(playModels).where(and(
    eq(playModels.playId, playId),
    eq(playModels.ownerUserId, user.id),
  )).orderBy(desc(playModels.version)).limit(1);
  if (!version) return <main><h1>{play.title}</h1><p>The structural review is not ready yet.</p></main>;
  const [source] = await db.select({ id: sourceFiles.id, filename: sourceFiles.filename }).from(sourceFiles).where(and(
    eq(sourceFiles.playId, playId), eq(sourceFiles.ownerUserId, user.id),
  )).limit(1);

  const elements = new Map<string, ScriptElement & { sceneId: string }>();
  for (const act of version.model.acts) {
    for (const scene of act.scenes) {
      for (const element of scene.elements) elements.set(element.id, { ...element, sceneId: scene.id });
    }
  }

  return (
    <main>
      <h1>Review {play.title}</h1>
      <p>Version {version.version}. Resolve every flagged passage before approval.</p>
      {source ? <p><a href={`/api/plays/${playId}/source/${source.id}`}>Open private source</a> · {source.filename}</p> : null}
      {version.issues.length === 0 ? <p>No blocking issues remain.</p> : null}
      {version.issues.map((issue) => (
        <article key={issue.id}>
          <h2>{issue.kind.replaceAll("_", " ")}</h2>
          <p>{issue.message}</p>
          {issue.elementIds.map((elementId) => {
            const element = elements.get(elementId);
            return (
              <blockquote key={elementId}>
                <p>{element?.text ?? "Source passage unavailable"}</p>
                <footer>{element?.sourcePage ? `Page ${element.sourcePage}` : "Page unavailable"}</footer>
              </blockquote>
            );
          })}
        </article>
      ))}
      <ReviewControls playId={playId} expectedModelId={version.id} expectedModelVersion={version.version}
        issues={version.issues} elements={[...elements.values()].map((element) => ({ id: element.id,
          text: element.text, kind: element.kind,
          characterId: "characterId" in element ? element.characterId : undefined, sceneId: element.sceneId,
        }))} characters={version.model.characters.map(({ id, name }) => ({ id, name }))} />
    </main>
  );
}
