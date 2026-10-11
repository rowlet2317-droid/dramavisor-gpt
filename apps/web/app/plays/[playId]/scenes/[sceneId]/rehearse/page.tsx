import { getDatabase } from "@drama/db/client";
import { StudyRepository } from "@drama/db/repositories/study";
import { assignVoices } from "@drama/domain/rehearsal/voice-assignment";
import { notFound } from "next/navigation";

import { RehearsalShell } from "../../../../../../components/rehearsal/rehearsal-shell";
import { requirePageUser } from "../../../../../../lib/auth/page-session";
import { roleWorkbook } from "../../../../../../lib/study";

export default async function RehearsePage({ params, searchParams }: {
  params: Promise<{ playId: string; sceneId: string }>;
  searchParams: Promise<{ actorRoleId?: string; reconnectTest?: string; productionE2e?: string }>;
}) {
  const user = await requirePageUser();
  const { playId, sceneId: encodedSceneId } = await params;
  const { actorRoleId: requestedRole, reconnectTest, productionE2e } = await searchParams;
  const sceneId = decodeURIComponent(encodedSceneId);
  const repository = new StudyRepository(getDatabase());
  if (!await repository.getOwnedPlay(user.id, playId)) notFound();
  const approved = await repository.getApprovedModel(user.id, playId);
  if (!approved) notFound();
  const scene = approved.model.acts.flatMap(({ scenes }) => scenes).find(({ id }) => id === sceneId);
  if (!scene) notFound();
  const actorRoleId = requestedRole ?? scene.characterIds[0];
  if (!actorRoleId || !scene.characterIds.includes(actorRoleId)) notFound();
  const characters = new Map(approved.model.characters.map((character) => [character.id, character]));
  const assignments = assignVoices(scene.characterIds.map((characterId) => ({ playId, characterId,
    dialogueCount: scene.elements.filter((element) => element.kind === "dialogue"
      && element.characterId === characterId).length })), [],
  ["alloy", "ash", "cedar", "coral", "echo", "marin", "sage", "shimmer"]);
  const voices = new Map(assignments.map((assignment) => [assignment.characterId, assignment.voice]));
  const workbookRow = (await repository.listArtifacts(user.id, playId)).find((row) => (
    row.status === "current" && row.kind === `role_workbook:${actorRoleId}`
  ));
  const workbook = workbookRow ? roleWorkbook(workbookRow.content) : null;
  const sceneElementIds = new Set(scene.elements.map(({ id }) => id));
  const beatElementIds = workbook?.beats.flatMap((claim) => claim.reference?.elementIds ?? [])
    .filter((elementId) => sceneElementIds.has(elementId)) ?? [];
  return <RehearsalShell playId={playId} playModelVersion={approved.version} actorRoleId={actorRoleId}
    beatElementIds={beatElementIds}
    e2eMode={process.env.E2E_TEST_MODE === "1" && productionE2e !== "1"}
    e2eDisconnectAfterSpeechCount={reconnectTest === "1" ? 2 : undefined} scene={{ id: scene.id,
      title: scene.title, lines: scene.elements.filter((element) => element.kind === "dialogue").map((element) => ({
        elementId: element.id, ordinal: element.ordinal, characterId: element.characterId,
        characterName: characters.get(element.characterId)?.name ?? "Unknown",
        text: element.text, voiceLabel: element.characterId === actorRoleId ? "You"
          : voices.get(element.characterId) ?? "AI",
      })) }} />;
}
