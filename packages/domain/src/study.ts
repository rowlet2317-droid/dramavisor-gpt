import { z } from "zod";

import type { PlayModel } from "./play-model";

export const StudySectionKindSchema = z.enum([
  "overview", "themes", "dramatic_structure", "characters", "relationships", "scene",
]);
export type StudySectionKind = z.infer<typeof StudySectionKindSchema>;

export const GroundedClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  epistemicStatus: z.enum(["explicit", "interpretation"]),
  reference: z.object({
    playId: z.string().min(1),
    elementIds: z.array(z.string().min(1)).min(1),
  }).nullable(),
});
export type GroundedClaim = z.infer<typeof GroundedClaimSchema>;

export const StudyArtifactSchema = z.object({
  id: z.string().min(1),
  kind: StudySectionKindSchema,
  scopeId: z.string().min(1).nullable(),
  claims: z.array(GroundedClaimSchema),
});
export type StudyArtifact = z.infer<typeof StudyArtifactSchema>;

const claimList = z.array(GroundedClaimSchema);
export const RoleWorkbookSchema = z.object({
  id: z.string().min(1),
  characterId: z.string().min(1),
  directorConcept: z.string().min(1).nullable(),
  circumstances: claimList,
  relationships: claimList,
  superObjectiveOptions: claimList,
  sceneObjectives: claimList,
  obstacles: claimList,
  stakes: claimList,
  tactics: claimList,
  entranceExitStates: claimList,
  beats: claimList,
  subtextOptions: claimList,
  referencedStageDirections: claimList,
});
export type RoleWorkbook = z.infer<typeof RoleWorkbookSchema>;

export function validateStudyArtifact(input: unknown, play: PlayModel): StudyArtifact {
  const artifact = StudyArtifactSchema.parse(input);
  validateClaims(artifact.claims, play);
  return artifact;
}

export function validateRoleWorkbook(input: unknown, play: PlayModel): RoleWorkbook {
  const workbook = RoleWorkbookSchema.parse(input);
  if (!play.characters.some((character) => character.id === workbook.characterId)) {
    throw new StudyGroundingError("UNKNOWN_CHARACTER");
  }
  for (const field of roleClaimFields) validateClaims(workbook[field], play);
  const stageDirectionIds = new Set(play.acts.flatMap((act) => act.scenes.flatMap((scene) => (
    scene.elements.filter((element) => element.kind === "stage_direction").map((element) => element.id)
  ))));
  for (const claim of workbook.referencedStageDirections) {
    if (!claim.reference) throw new StudyGroundingError("MISSING_SCRIPT_REFERENCE");
    if (claim.reference.elementIds.some((id) => !stageDirectionIds.has(id))) {
      throw new StudyGroundingError("REFERENCE_IS_NOT_STAGE_DIRECTION");
    }
  }
  return workbook;
}

const roleClaimFields = [
  "circumstances", "relationships", "superObjectiveOptions", "sceneObjectives", "obstacles", "stakes",
  "tactics", "entranceExitStates", "beats", "subtextOptions", "referencedStageDirections",
] as const;

function validateClaims(claims: GroundedClaim[], play: PlayModel): void {
  const playId = play.id.replace(/:v\d+$/, "");
  const elementIds = new Set(play.acts.flatMap((act) => (
    act.scenes.flatMap((scene) => scene.elements.map((element) => element.id))
  )));
  for (const claim of claims) {
    if (claim.epistemicStatus === "explicit" && !claim.reference) {
      throw new StudyGroundingError("MISSING_SCRIPT_REFERENCE");
    }
    if (claim.reference && (
      claim.reference.playId !== playId
      || claim.reference.elementIds.some((id) => !elementIds.has(id))
    )) {
      throw new StudyGroundingError("UNKNOWN_SCRIPT_REFERENCE");
    }
  }
}

export class StudyGroundingError extends Error {
  constructor(readonly code: "MISSING_SCRIPT_REFERENCE" | "UNKNOWN_SCRIPT_REFERENCE" | "UNKNOWN_CHARACTER"
    | "REFERENCE_IS_NOT_STAGE_DIRECTION") {
    super(code);
    this.name = "StudyGroundingError";
  }
}
