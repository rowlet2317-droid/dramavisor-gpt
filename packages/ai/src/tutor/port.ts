import type { PlayModel, ScriptElement } from "@drama/domain/play-model";
import { GroundedClaimSchema, type GroundedClaim, type RoleWorkbook, type StudyArtifact } from "@drama/domain/study";
import { z } from "zod";

export const TutorResponseSchema = z.object({
  answer: z.string().min(1),
  claims: z.array(GroundedClaimSchema),
});

export type TutorResponse = z.infer<typeof TutorResponseSchema>;

export type TutorRequest = {
  question: string;
  play: PlayModel;
  context: {
    scene: PlayModel["acts"][number]["scenes"][number] | null;
    character: PlayModel["characters"][number] | null;
    elements: ScriptElement[];
  };
  artifacts: Array<StudyArtifact | RoleWorkbook>;
  validationError?: string;
};

export interface ContextualTutor {
  answer(request: TutorRequest): Promise<{ answer: string; claims: GroundedClaim[] }>;
}
