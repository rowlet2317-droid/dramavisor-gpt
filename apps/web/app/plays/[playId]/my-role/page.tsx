import { getDatabase } from "@drama/db/client";
import { notFound } from "next/navigation";

import { AnalysisSummaryCard } from "../../../../components/study/analysis-summary-card";
import { RolePicker } from "../../../../components/study/role-picker";
import { requirePageUser } from "../../../../lib/auth/page-session";
import { loadOwnedStudy, roleWorkbook } from "../../../../lib/study";
import { workbookSections } from "../../../../lib/study-sections";

export default async function MyRolePage({ params, searchParams }: {
  params: Promise<{ playId: string }>;
  searchParams: Promise<{ characterId?: string }>;
}) {
  const user = await requirePageUser();
  const { playId } = await params;
  const { characterId } = await searchParams;
  const study = await loadOwnedStudy(getDatabase(), user.id, playId);
  if (!study) notFound();
  if (characterId && !study.play.characters.some((character) => character.id === characterId)) notFound();
  const row = characterId ? study.artifacts.find((artifact) => artifact.kind === `role_workbook:${characterId}`) : null;
  const workbook = row ? roleWorkbook(row.content) : null;
  const character = study.play.characters.find((candidate) => candidate.id === characterId);
  return <>
    <header className="study-header"><p className="eyebrow">Actor workbook</p><h2>My Role</h2>
      <p>Separate personal choices from claims the script directly supports.</p></header>
    <RolePicker playId={playId} characters={study.play.characters} selectedCharacterId={characterId} />
    {character && workbook ? <section className="rehearsal-callout">
      <div><p className="eyebrow">Ready when you are</p><h3>Rehearse with AI</h3>
        <p>Play {character.name}; AI voices perform the other roles.</p></div>
      <ul className="rehearsal-links">{study.play.acts.flatMap((act) => act.scenes.map((scene) => ({ act, scene })))
        .filter(({ scene }) => scene.characterIds.includes(character.id))
        .map(({ act, scene }) => <li key={scene.id}><a className="button-link" href={`/plays/${playId}/scenes/${scene.id}/rehearse?actorRoleId=${encodeURIComponent(character.id)}`}>
          Rehearse A{act.ordinal} · S{scene.ordinal} {scene.title}
        </a></li>)}</ul>
    </section> : null}
    {character ? <section className="study-section"><div className="section-heading"><div>
      <p className="eyebrow">Workbook</p><h3>{character.name}</h3></div>
      <p>Open a section only when you need the full evidence.</p></div>
      {workbook ? <div className="analysis-summary-grid">{workbookSections(workbook).map(({ kind, title, claims }) => (
        <AnalysisSummaryCard key={kind} title={title} claims={claims}
          href={`/plays/${playId}/my-role/${kind}?characterId=${encodeURIComponent(character.id)}`}
          unavailable="No grounded notes in this section." />
      ))}</div> : <p className="muted">Build the workbook to start studying this role.</p>}
    </section> : null}
  </>;
}
