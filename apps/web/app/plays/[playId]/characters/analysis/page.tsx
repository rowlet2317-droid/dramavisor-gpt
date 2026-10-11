import { getDatabase } from "@drama/db/client";
import { notFound } from "next/navigation";

import { GroundedClaim } from "../../../../../components/study/grounded-claim";
import { requirePageUser } from "../../../../../lib/auth/page-session";
import { loadOwnedStudy, studyArtifact } from "../../../../../lib/study";

export default async function CharacterAnalysisPage({ params }: { params: Promise<{ playId: string }> }) {
  const user = await requirePageUser();
  const { playId } = await params;
  const study = await loadOwnedStudy(getDatabase(), user.id, playId);
  if (!study) notFound();
  const row = study.artifacts.find((artifact) => artifact.kind === "characters");
  const artifact = row ? studyArtifact(row.content) : null;
  return <>
    <a className="back-link" href={`/plays/${playId}/characters`}>← Characters</a>
    <header className="study-header"><p className="eyebrow">Company deep dive</p>
      <h2>What the script establishes</h2><p>Read the full grounded character analysis when you need it.</p></header>
    <section className="study-section">
      {artifact?.claims.length ? artifact.claims.map((claim) => <GroundedClaim key={claim.id} claim={claim}
        play={study.play} />) : <p className="muted">Character analysis is not available yet.</p>}
    </section>
  </>;
}
