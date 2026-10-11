import { getDatabase } from "@drama/db/client";
import { notFound } from "next/navigation";

import { AnalysisSummaryCard } from "../../../../components/study/analysis-summary-card";
import { requirePageUser } from "../../../../lib/auth/page-session";
import { loadOwnedStudy, studyArtifact } from "../../../../lib/study";
import { playSectionKinds, playSectionTitle } from "../../../../lib/study-sections";

export default async function OverviewPage({ params }: { params: Promise<{ playId: string }> }) {
  const user = await requirePageUser();
  const { playId } = await params;
  const study = await loadOwnedStudy(getDatabase(), user.id, playId);
  if (!study) notFound();
  return <>
    <header className="study-header"><p className="eyebrow">First read</p><h2>Understand the whole play</h2>
      <p>Scan the essentials, then open the analysis you need for today&apos;s rehearsal.</p></header>
    <section className="study-section"><div className="section-heading"><div><p className="eyebrow">At a glance</p>
      <h3>Play analysis</h3></div><p>Four focused reads instead of one long report.</p></div>
      <div className="analysis-summary-grid">{playSectionKinds.map((kind) => {
      const row = study.artifacts.find((artifact) => artifact.kind === kind);
      const artifact = row ? studyArtifact(row.content) : null;
      return <AnalysisSummaryCard key={kind} title={playSectionTitle(kind)} claims={artifact?.claims}
        href={`/plays/${playId}/overview/${kind}`} />;
    })}</div></section>
  </>;
}
