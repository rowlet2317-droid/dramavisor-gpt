import type { CoachingConfidence, CoachingEvidence, CoachingReport } from "@drama/domain/coaching";

export type CoachingLine = {
  elementId: string;
  text: string;
};

export type FixedCoachingRating = {
  score: number | null;
  confidence: CoachingConfidence;
  evidenceIds: string[];
};

export type CoachingSynthesisRequest = {
  sceneObjective: string | null;
  selectedInterpretation: string | null;
  lines: CoachingLine[];
  evidence: CoachingEvidence[];
  lineAccuracy: FixedCoachingRating;
  previousComparableTakeSummary: string | null;
  soloCompleteTake: boolean;
};

export interface Coach {
  synthesize(request: CoachingSynthesisRequest): Promise<CoachingReport>;
}
