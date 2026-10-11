import { getDatabase } from "@drama/db/client";
import { StudyRepository } from "@drama/db/repositories/study";
import { notFound } from "next/navigation";

import { RecorderControls } from "../../../../../../components/practice/recorder-controls";
import { requirePageUser } from "../../../../../../lib/auth/page-session";

export default async function PracticePage({ params }: {
  params: Promise<{ playId: string; sceneId: string }>;
}) {
  const user = await requirePageUser();
  const { playId, sceneId: encodedSceneId } = await params;
  const sceneId = decodeURIComponent(encodedSceneId);
  const repository = new StudyRepository(getDatabase());
  if (!await repository.getOwnedPlay(user.id, playId)) notFound();
  const approved = await repository.getApprovedModel(user.id, playId);
  if (!approved) notFound();
  const scene = approved.model.acts.flatMap((act) => act.scenes).find((candidate) => candidate.id === sceneId);
  if (!scene) notFound();
  const characters = new Map(approved.model.characters.map((character) => [character.id, character]));
  const roles = scene.characterIds.flatMap((id) => {
    const character = characters.get(id);
    return character ? [{ id: character.id, name: character.name }] : [];
  });
  return <>
    <header className="study-header"><p className="eyebrow">Voice-only complete take</p>
      <h2>Practice {scene.title}</h2>
      <p>Your performance will not be interrupted. Coaching begins after the private upload.</p>
    </header>
    <RecorderControls playId={playId} sceneId={scene.id} playModelVersion={approved.version} roles={roles} />
    <p><a className="button-link" href={`/plays/${playId}/scenes/${encodeURIComponent(scene.id)}/rehearse`}>
      Open interactive rehearsal</a></p>
    <p><a className="button-link" href={`/plays/${playId}/scenes/${encodeURIComponent(scene.id)}/exercise`}>
      Open guided exercise</a></p>
  </>;
}
