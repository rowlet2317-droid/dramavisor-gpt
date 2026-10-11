import { getDatabase } from "@drama/db/client";
import { notFound } from "next/navigation";

import { GroundedClaim } from "../../../../../components/study/grounded-claim";
import { requirePageUser } from "../../../../../lib/auth/page-session";
import { loadOwnedStudy, studyArtifact } from "../../../../../lib/study";
import { playSectionKinds, playSectionTitle, type PlaySectionKind } from "../../../../../lib/study-sections";

export default async function PlayAnalysisSectionPage({ params }: {
  params: Promise<{ playId: string; section: string }>;
}) {
  const user = await requirePageUser();
  const { playId, section } = await params;
  if (!playSectionKinds.includes(section as PlaySectionKind)) notFound();
  const kind = section as PlaySectionKind;
  const study = await loadOwnedStudy(getDatabase(), user.id, playId);
  if (!study) notFound();
  const row = study.artifacts.find((artifact) => artifact.kind === kind);
  const artifact = row ? studyArtifact(row.content) : null;
  const title = playSectionTitle(kind);
  return <>
    <a className="back-link" href={`/plays/${playId}/overview`}>← Play analysis</a>
    <header className="study-header"><p className="eyebrow">Deep dive</p><h2>{title}</h2>
      <p>Grounded observations and clearly labeled interpretations for closer study.</p></header>
    <section className="study-section"><h3>{title}</h3>
      {artifact?.claims.length ? artifact.claims.map((claim) => <GroundedClaim key={claim.id} claim={claim}
        play={study.play} />) : <p className="muted">This section is not available yet.</p>}
    </section>
  </>;
}
