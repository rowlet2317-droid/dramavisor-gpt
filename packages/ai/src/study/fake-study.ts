import type { RoleWorkbook, StudyArtifact } from "@drama/domain/study";

import type { RoleWorkbookRequest, StudyGenerator, StudySectionRequest } from "./port";

type FakeStudyOptions = {
  sectionResponses?: Record<string, StudyArtifact[]>;
  roleResponses?: RoleWorkbook[];
};

export class FakeStudyGenerator implements StudyGenerator {
  readonly studyCalls: StudySectionRequest[] = [];
  readonly roleCalls: RoleWorkbookRequest[] = [];
  private readonly sectionIndexes = new Map<string, number>();
  private roleIndex = 0;

  constructor(private readonly options: FakeStudyOptions = {}) {}

  async generateStudySection(request: StudySectionRequest): Promise<StudyArtifact> {
    this.studyCalls.push(structuredClone(request));
    const key = request.kind === "scene" ? `scene:${request.scopeId}` : request.kind;
    const responses = this.options.sectionResponses?.[key];
    if (!responses?.length) throw new Error(`FakeStudyGenerator has no response for ${key}`);
    const index = this.sectionIndexes.get(key) ?? 0;
    this.sectionIndexes.set(key, index + 1);
    return structuredClone(responses[Math.min(index, responses.length - 1)]!);
  }

  async generateRoleWorkbook(request: RoleWorkbookRequest): Promise<RoleWorkbook> {
    this.roleCalls.push(structuredClone(request));
    const responses = this.options.roleResponses;
    if (!responses?.length) throw new Error("FakeStudyGenerator has no role response");
    const response = responses[Math.min(this.roleIndex, responses.length - 1)]!;
    this.roleIndex += 1;
    return structuredClone(response);
  }
}
