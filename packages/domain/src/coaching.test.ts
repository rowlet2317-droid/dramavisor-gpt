import { describe, expect, it } from "vitest";

import {
  calculateLineAccuracy,
  validateCoachingReport,
  type CoachingEvidence,
  type CoachingReport,
} from "./coaching";

describe("deterministic line accuracy", () => {
  it("calculates aligned token edit distance without punctuation or case noise", () => {
    expect(calculateLineAccuracy([
      { expected: "We begin, right now.", performed: "we begin right now" },
      { expected: "Stay with me.", performed: "Stay me" },
    ])).toBe(86);
  });

  it("returns zero when expected text is replaced rather than treating an empty side as exact", () => {
    expect(calculateLineAccuracy([{ expected: "Stay", performed: "" }])).toBe(0);
  });
});

const evidence: CoachingEvidence[] = [{
  id: "metric-pace",
  kind: "deterministic_metric",
  confidence: "high",
  description: "Measured pace is steady.",
  startMs: null,
  endMs: null,
  elementIds: ["line-1"],
}];

describe("coaching report validation", () => {
  it("rejects more than three priorities", () => {
    // Break caught: removing the priority cap lets synthesis overwhelm the actor with an unbounded critique list.
    const report = validReport();
    report.priorities.push({ text: "Fourth priority", evidenceIds: ["metric-pace"] });

    expect(() => validateCoachingReport(report, evidence)).toThrow("TOO_MANY_PRIORITIES");
  });

  it("rejects a score supported by low-confidence evidence", () => {
    // Break caught: trusting a low-confidence source turns uncertain measurements into authoritative scores.
    const report = validReport();
    const lowEvidence = [{ ...evidence[0]!, confidence: "low" as const }];

    expect(() => validateCoachingReport(report, lowEvidence)).toThrow("LOW_CONFIDENCE_SCORE");
  });

  it("allows low-confidence evidence when the rating score is null", () => {
    const report = validReport();
    const pacing = report.ratings.find(({ category }) => category === "pacing")!;
    pacing.score = null;
    pacing.confidence = "low";
    pacing.evidenceIds = ["observation-pace"];
    const lowEvidence: CoachingEvidence = {
      ...evidence[0]!,
      id: "observation-pace",
      kind: "audio_observation",
      confidence: "low",
    };

    expect(validateCoachingReport(report, [...evidence, lowEvidence])).toEqual(report);
  });

  it("rejects report notes that cite unknown evidence", () => {
    // Break caught: accepting invented evidence IDs leaves the UI unable to replay or explain a coaching claim.
    const report = validReport();
    report.strengths[0]!.evidenceIds = ["missing-evidence"];

    expect(() => validateCoachingReport(report, evidence)).toThrow("UNKNOWN_EVIDENCE");
  });

  it("requires every rating category exactly once", () => {
    // Break caught: duplicate categories can hide an omitted rating while still producing five cards.
    const report = validReport();
    report.ratings[4] = { ...report.ratings[0]! };

    expect(() => validateCoachingReport(report, evidence)).toThrow("INVALID_RATING_SET");
  });

  it("forces cue responsiveness to N/A for a solo complete take", () => {
    // Break caught: scoring cue response without another actor fabricates evidence that does not exist.
    const report = validReport();
    report.ratings.find(({ category }) => category === "cue_responsiveness")!.score = 80;

    expect(() => validateCoachingReport(report, evidence, { soloCompleteTake: true }))
      .toThrow("SOLO_CUE_SCORE");
  });
});

function validReport(): CoachingReport {
  return {
    ratings: [
      { category: "line_accuracy", score: 90, confidence: "high", evidenceIds: ["metric-pace"] },
      { category: "clarity", score: 85, confidence: "high", evidenceIds: ["metric-pace"] },
      { category: "pacing", score: 80, confidence: "high", evidenceIds: ["metric-pace"] },
      { category: "cue_responsiveness", score: null, confidence: "low", evidenceIds: [] },
      { category: "vocal_variation", score: 75, confidence: "high", evidenceIds: ["metric-pace"] },
    ],
    strengths: [{ text: "Clear intention", evidenceIds: ["metric-pace"] }],
    priorities: [
      { text: "Vary the pace", evidenceIds: ["metric-pace"] },
      { text: "Land the final word", evidenceIds: ["metric-pace"] },
      { text: "Clarify the turn", evidenceIds: ["metric-pace"] },
    ],
    exercise: {
      title: "Tempo ladder",
      instructions: "Repeat the line at three deliberate tempos.",
      targetCategory: "pacing",
      evidenceIds: ["metric-pace"],
    },
    interpretationNotes: [{ text: "The urgency can remain playable.", evidenceIds: ["metric-pace"] }],
  };
}
