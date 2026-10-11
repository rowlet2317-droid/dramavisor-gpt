import { describe, expect, it } from "vitest";

import type { CoachingReport } from "./coaching";
import { compareTakes, selectPreviousComparableTake, type CompletedCoachingTake } from "./take-comparison";

describe("take comparison", () => {
  it("reports improvement only for comparable non-null medium/high-confidence scores", () => {
    const previous = take("previous", "2026-08-20T12:00:00Z", report(82, "medium"));
    const current = take("current", "2026-08-21T12:00:00Z", report(94, "high"));

    const result = compareTakes(current, previous);

    expect(result.line_accuracy).toEqual({ previous: 82, current: 94, delta: 12 });
    expect(result.cue_responsiveness).toBeNull();
  });

  it("omits numeric deltas when either rating is null or low confidence", () => {
    const previousReport = report(82, "high");
    previousReport.ratings.find(({ category }) => category === "pacing")!.confidence = "low";
    const currentReport = report(94, "high");
    currentReport.ratings.find(({ category }) => category === "clarity")!.score = null;

    const result = compareTakes(
      take("current", "2026-08-21T12:00:00Z", currentReport),
      take("previous", "2026-08-20T12:00:00Z", previousReport),
    );

    expect(result.pacing).toBeNull();
    expect(result.clarity).toBeNull();
  });

  it("rejects comparisons across pinned play version, scene, role, or practice mode", () => {
    const current = take("current", "2026-08-21T12:00:00Z", report(94, "high"));
    const previous = { ...take("previous", "2026-08-20T12:00:00Z", report(82, "high")),
      playModelVersion: 2 };

    expect(() => compareTakes(current, previous)).toThrow("INCOMPARABLE_TAKES");
  });

  it("selects the most recent completed comparable take before the current take", () => {
    const current = take("current", "2026-08-21T12:00:00Z", report(94, "high"));
    const selected = selectPreviousComparableTake(current, [
      take("older", "2026-08-18T12:00:00Z", report(70, "high")),
      { ...take("wrong-role", "2026-08-20T18:00:00Z", report(90, "high")), roleId: "jordan" },
      take("future", "2026-08-22T12:00:00Z", report(99, "high")),
      take("latest-valid", "2026-08-20T12:00:00Z", report(82, "high")),
    ]);

    expect(selected?.id).toBe("latest-valid");
  });
});

function take(id: string, createdAt: string, coachingReport: CoachingReport): CompletedCoachingTake {
  return { id, playModelId: "model-1", playModelVersion: 1, sceneId: "scene-1", roleId: "alex",
    practiceMode: "complete_take", state: "completed", createdAt: new Date(createdAt), coachingReport };
}

function report(lineAccuracy: number, confidence: "high" | "medium"): CoachingReport {
  const rating = (category: CoachingReport["ratings"][number]["category"], score: number | null,
    ratingConfidence: "high" | "medium" | "low" = confidence) => ({
    category, score, confidence: ratingConfidence, evidenceIds: score === null ? [] : [`${category}-evidence`],
  });
  return { ratings: [
    rating("line_accuracy", lineAccuracy),
    rating("clarity", 80),
    rating("pacing", 75),
    rating("cue_responsiveness", null, "low"),
    rating("vocal_variation", 70),
  ], strengths: [], priorities: [], exercise: { title: "Repeat", instructions: "Repeat the line.",
    targetCategory: "line_accuracy", evidenceIds: ["line_accuracy-evidence"] }, interpretationNotes: [] };
}
