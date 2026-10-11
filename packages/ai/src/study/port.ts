import type { PlayModel } from "@drama/domain/play-model";
import type { RoleWorkbook, StudyArtifact, StudySectionKind } from "@drama/domain/study";

export type StudySectionRequest = {
  play: PlayModel;
  kind: StudySectionKind;
  scopeId: string | null;
  validationError?: string;
};

export type RoleWorkbookRequest = {
  play: PlayModel;
  characterId: string;
  directorConcept: string | null;
  validationError?: string;
};

export interface StudyGenerator {
  generateStudySection(request: StudySectionRequest): Promise<StudyArtifact>;
  generateRoleWorkbook(request: RoleWorkbookRequest): Promise<RoleWorkbook>;
}
