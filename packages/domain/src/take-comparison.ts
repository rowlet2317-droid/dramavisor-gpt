import { COACHING_RATING_CATEGORIES, type CoachingReport, type CoachingRatingCategory }
  from "./coaching";
import type { PracticeMode } from "./practice";

export type { PracticeMode } from "./practice";

export type CompletedCoachingTake = {
  id: string;
  playModelId: string;
  playModelVersion: number;
  sceneId: string;
  roleId: string;
  practiceMode: PracticeMode;
  state: "completed" | "completed_with_limitations";
  createdAt: Date;
  coachingReport: CoachingReport;
};

export type ScoreDelta = {
  previous: number;
  current: number;
  delta: number;
};

export type TakeComparison = Record<CoachingRatingCategory, ScoreDelta | null>;

export function compareTakes(current: CompletedCoachingTake, previous: CompletedCoachingTake): TakeComparison {
  if (!isComparable(current, previous)) throw new Error("INCOMPARABLE_TAKES");

  return Object.fromEntries(COACHING_RATING_CATEGORIES.map((category) => {
    const currentRating = current.coachingReport.ratings.find((rating) => rating.category === category);
    const previousRating = previous.coachingReport.ratings.find((rating) => rating.category === category);
    if (!currentRating || !previousRating || currentRating.score === null || previousRating.score === null
      || currentRating.confidence === "low" || previousRating.confidence === "low") {
      return [category, null];
    }
    return [category, { previous: previousRating.score, current: currentRating.score,
      delta: currentRating.score - previousRating.score }];
  })) as TakeComparison;
}

export function selectPreviousComparableTake(
  current: CompletedCoachingTake,
  candidates: CompletedCoachingTake[],
): CompletedCoachingTake | null {
  return candidates.filter((candidate) => candidate.id !== current.id
    && candidate.createdAt.getTime() < current.createdAt.getTime()
    && isComparable(current, candidate))
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
}

function isComparable(left: CompletedCoachingTake, right: CompletedCoachingTake): boolean {
  return left.playModelId === right.playModelId
    && left.playModelVersion === right.playModelVersion
    && left.sceneId === right.sceneId
    && left.roleId === right.roleId
    && left.practiceMode === right.practiceMode;
}
