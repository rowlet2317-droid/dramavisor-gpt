import type { CoachingEvidence } from "@drama/domain/coaching";

export type AudioReviewLine = {
  elementId: string;
  text: string;
  startMs?: number | null;
  endMs?: number | null;
};

export type AudioReviewRequest = {
  audio: Uint8Array;
  durationMs: number;
  sceneObjective: string | null;
  selectedInterpretation: string | null;
  lines: AudioReviewLine[];
};

export interface AudioReviewer {
  review(request: AudioReviewRequest): Promise<CoachingEvidence[]>;
}
