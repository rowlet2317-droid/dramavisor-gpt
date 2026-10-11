import { StudyRepository } from "@drama/db/repositories/study";
import type { Database } from "@drama/db/client";
import { RoleWorkbookSchema, StudyArtifactSchema, type RoleWorkbook, type StudyArtifact } from "@drama/domain/study";

export async function loadOwnedStudy(db: Database, ownerUserId: string, playId: string) {
  const repository = new StudyRepository(db);
  const play = await repository.getOwnedPlay(ownerUserId, playId);
  const approved = play ? await repository.getApprovedModel(ownerUserId, playId) : null;
  if (!play || !approved) return null;
  const rows = await repository.listArtifacts(ownerUserId, playId);
  return { play: approved.model, artifacts: rows.filter((row) => row.status === "current") };
}

export function studyArtifact(content: unknown): StudyArtifact | null {
  const parsed = StudyArtifactSchema.safeParse(content);
  return parsed.success ? parsed.data : null;
}

export function roleWorkbook(content: unknown): RoleWorkbook | null {
  const parsed = RoleWorkbookSchema.safeParse(content);
  return parsed.success ? parsed.data : null;
}
