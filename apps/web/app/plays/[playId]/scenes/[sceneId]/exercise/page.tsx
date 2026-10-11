import { getDatabase } from "@drama/db/client";
import { StudyRepository } from "@drama/db/repositories/study";
import { notFound } from "next/navigation";

import { GuidedExercise } from "../../../../../../components/practice/guided-exercise";
import { requirePageUser } from "../../../../../../lib/auth/page-session";

export default async function ExercisePage({ params }: {
  params: Promise<{ playId: string; sceneId: string }>;
}) {
  const user = await requirePageUser();
  const { playId, sceneId: encodedSceneId } = await params;
  const sceneId = decodeURIComponent(encodedSceneId);
  const repository = new StudyRepository(getDatabase());
  if (!await repository.getOwnedPlay(user.id, playId)) notFound();
  const approved = await repository.getApprovedModel(user.id, playId);
  if (!approved) notFound();
  const scene = approved.model.acts.flatMap((act) => act.scenes).find(({ id }) => id === sceneId);
  if (!scene) notFound();
  const characters = new Map(approved.model.characters.map((character) => [character.id, character]));
  const roles = scene.characterIds.flatMap((id) => {
    const character = characters.get(id); return character ? [{ id: character.id, name: character.name }] : [];
  });
  return <><header className="study-header"><p className="eyebrow">Guided vocal exercise</p>
    <h1>Exercise {scene.title}</h1><p>Record one bounded attempt, receive one note, then choose what happens next.</p>
  </header><GuidedExercise playId={playId} sceneId={scene.id} playModelVersion={approved.version}
    roles={roles} e2eMode={process.env.E2E_TEST_MODE === "1"} /></>;
}
