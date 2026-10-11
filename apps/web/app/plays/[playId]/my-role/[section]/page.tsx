import { getDatabase } from "@drama/db/client";
import { notFound } from "next/navigation";

import { GroundedClaim } from "../../../../../components/study/grounded-claim";
import { requirePageUser } from "../../../../../lib/auth/page-session";
import { loadOwnedStudy, roleWorkbook } from "../../../../../lib/study";
import { workbookSectionKinds, workbookSectionTitle, type WorkbookSectionKind } from "../../../../../lib/study-sections";

export default async function WorkbookSectionPage({ params, searchParams }: {
  params: Promise<{ playId: string; section: string }>;
  searchParams: Promise<{ characterId?: string }>;
}) {
  const user = await requirePageUser();
  const { playId, section } = await params;
  const { characterId } = await searchParams;
  if (!characterId || !workbookSectionKinds.includes(section as WorkbookSectionKind)) notFound();
  const kind = section as WorkbookSectionKind;
  const study = await loadOwnedStudy(getDatabase(), user.id, playId);
  if (!study) notFound();
  const character = study.play.characters.find((candidate) => candidate.id === characterId);
  if (!character) notFound();
  const row = study.artifacts.find((artifact) => artifact.kind === `role_workbook:${characterId}`);
  const workbook = row ? roleWorkbook(row.content) : null;
  const title = workbookSectionTitle(kind);
  const claims = workbook?.[kind];
  return <>
    <a className="back-link" href={`/plays/${playId}/my-role?characterId=${encodeURIComponent(characterId)}`}>
      ← {character.name}&apos;s workbook
    </a>
    <header className="study-header"><p className="eyebrow">{character.name} · Workbook</p><h2>{title}</h2>
      <p>The complete set of grounded notes for this part of your role preparation.</p></header>
    <section className="study-section">
      {claims?.length ? claims.map((claim) => <GroundedClaim key={claim.id} claim={claim} play={study.play} />)
        : <p className="muted">No grounded notes in this section.</p>}
    </section>
  </>;
}
