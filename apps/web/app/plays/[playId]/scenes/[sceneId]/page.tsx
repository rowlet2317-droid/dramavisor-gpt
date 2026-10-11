import { getDatabase } from "@drama/db/client";
import { notFound } from "next/navigation";

import { GroundedClaim } from "../../../../../components/study/grounded-claim";
import { requirePageUser } from "../../../../../lib/auth/page-session";
import { loadOwnedStudy, studyArtifact } from "../../../../../lib/study";

export default async function ScenePage({ params }: {
  params: Promise<{ playId: string; sceneId: string }>;
}) {
  const user = await requirePageUser();
  const { playId, sceneId: encodedSceneId } = await params;
  const sceneId = decodeURIComponent(encodedSceneId);
  const study = await loadOwnedStudy(getDatabase(), user.id, playId);
  if (!study) notFound();
  const location = study.play.acts.flatMap((act) => act.scenes.map((scene) => ({ act, scene })))
    .find(({ scene }) => scene.id === sceneId);
  if (!location) notFound();
  const artifactRow = study.artifacts.find((artifact) => artifact.kind === `scene:${sceneId}`);
  const artifact = artifactRow ? studyArtifact(artifactRow.content) : null;
  const characterNames = new Map(study.play.characters.map((character) => [character.id, character.name]));
  return <>
    <header className="study-header"><p className="eyebrow">Act {location.act.ordinal} · Scene {location.scene.ordinal}</p>
      <h2>{location.scene.title}</h2><p>Use evidence chips to jump from analysis back to the exact line.</p></header>
    <section className="study-section"><h3>Scene study</h3>
      {artifact?.claims.length ? artifact.claims.map((claim) => <GroundedClaim key={claim.id} claim={claim}
        play={study.play} />) : <p className="muted">Scene analysis is not available yet.</p>}
    </section>
    <section className="script-passage" aria-label="Original script passage"><h3>Original passage</h3>
      {location.scene.elements.map((element) => <article id={element.id} key={element.id}
        className={`script-line script-line--${element.kind}`}>
        {element.kind === "dialogue" ? <strong>{characterNames.get(element.characterId) ?? "Unknown"}</strong> : null}
        <p>{element.text}</p><footer>{element.id}{element.sourcePage ? ` · Source page ${element.sourcePage}` : ""}</footer>
        <a href={`?elementId=${encodeURIComponent(element.id)}#${element.id}`}>Ask about this passage</a>
      </article>)}
    </section>
  </>;
}
