import { getDatabase } from "@drama/db/client";
import { notFound } from "next/navigation";

import { AnalysisSummaryCard } from "../../../../components/study/analysis-summary-card";
import { requirePageUser } from "../../../../lib/auth/page-session";
import { loadOwnedStudy, studyArtifact } from "../../../../lib/study";

export default async function CharactersPage({ params }: { params: Promise<{ playId: string }> }) {
  const user = await requirePageUser();
  const { playId } = await params;
  const study = await loadOwnedStudy(getDatabase(), user.id, playId);
  if (!study) notFound();
  const characterArtifactRow = study.artifacts.find((artifact) => artifact.kind === "characters");
  const characterArtifact = characterArtifactRow ? studyArtifact(characterArtifactRow.content) : null;
  return <>
    <header className="study-header"><p className="eyebrow">Company</p><h2>Characters</h2>
      <p>Map who enters the story, then choose the role you are rehearsing.</p></header>
    <ul className="character-grid">{study.play.characters.map((character) => {
      const scenes = study.play.acts.flatMap((act) => act.scenes).filter((scene) => (
        scene.characterIds.includes(character.id)
      ));
      return <li key={character.id}><article className="character-card"><h3>{character.name}</h3>
        <p>{scenes.length} {scenes.length === 1 ? "scene" : "scenes"}</p>
        {character.aliases.length ? <p className="muted">Also: {character.aliases.join(", ")}</p> : null}
        <a href={`/plays/${playId}/my-role?characterId=${encodeURIComponent(character.id)}`}>Choose as My Role →</a>
      </article></li>;
    })}</ul>
    <section className="study-section"><AnalysisSummaryCard title="What the script establishes"
      claims={characterArtifact?.claims} href={`/plays/${playId}/characters/analysis`}
      unavailable="Character analysis is not available yet." /></section>
  </>;
}
