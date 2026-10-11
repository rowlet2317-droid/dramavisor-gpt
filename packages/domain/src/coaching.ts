import { z } from "zod";

export const COACHING_CONFIDENCE = ["high", "medium", "low"] as const;
export type CoachingConfidence = typeof COACHING_CONFIDENCE[number];

export const COACHING_RATING_CATEGORIES = [
  "line_accuracy",
  "clarity",
  "pacing",
  "cue_responsiveness",
  "vocal_variation",
] as const;
export type CoachingRatingCategory = typeof COACHING_RATING_CATEGORIES[number];

export const COACHING_EVIDENCE_KINDS = [
  "deterministic_metric",
  "transcript_alignment",
  "audio_observation",
] as const;
export type CoachingEvidenceKind = typeof COACHING_EVIDENCE_KINDS[number];

export const CoachingEvidenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(COACHING_EVIDENCE_KINDS),
  confidence: z.enum(COACHING_CONFIDENCE),
  description: z.string().min(1),
  startMs: z.number().int().nonnegative().nullable(),
  endMs: z.number().int().nonnegative().nullable(),
  elementIds: z.array(z.string().min(1)),
}).refine(
  ({ startMs, endMs }) => startMs === null || endMs === null || startMs <= endMs,
  { message: "INVALID_EVIDENCE_RANGE" },
);

export type CoachingEvidence = z.infer<typeof CoachingEvidenceSchema>;

const EvidenceReferenceSchema = z.object({
  text: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)),
});

const CoachingRatingSchema = z.object({
  category: z.enum(COACHING_RATING_CATEGORIES),
  score: z.number().min(0).max(100).nullable(),
  confidence: z.enum(COACHING_CONFIDENCE),
  evidenceIds: z.array(z.string().min(1)),
});

export const CoachingReportSchema = z.object({
  ratings: z.array(CoachingRatingSchema),
  strengths: z.array(EvidenceReferenceSchema),
  priorities: z.array(EvidenceReferenceSchema).max(3, "TOO_MANY_PRIORITIES"),
  exercise: z.object({
    title: z.string().min(1),
    instructions: z.string().min(1),
    targetCategory: z.enum(COACHING_RATING_CATEGORIES),
    evidenceIds: z.array(z.string().min(1)),
  }),
  interpretationNotes: z.array(EvidenceReferenceSchema),
});

export type CoachingReport = z.infer<typeof CoachingReportSchema>;

export type CoachingValidationOptions = {
  soloCompleteTake?: boolean;
};

export class CoachingValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CoachingValidationError";
  }
}

export type AlignedLineText = {
  expected: string;
  performed: string;
};

export function calculateLineAccuracy(lines: AlignedLineText[]): number {
  let editCount = 0;
  let tokenCount = 0;
  for (const line of lines) {
    const expected = tokenize(line.expected);
    const performed = tokenize(line.performed);
    editCount += editDistance(expected, performed);
    tokenCount += Math.max(expected.length, performed.length);
  }
  return tokenCount === 0 ? 100 : Math.round(100 * (1 - editCount / tokenCount));
}

export function validateCoachingReport(
  input: CoachingReport,
  evidenceInput: CoachingEvidence[],
  options: CoachingValidationOptions = {},
): CoachingReport {
  if (input.priorities.length > 3) {
    throw new CoachingValidationError("TOO_MANY_PRIORITIES");
  }

  const report = CoachingReportSchema.parse(input);
  const evidence = evidenceInput.map((item) => CoachingEvidenceSchema.parse(item));
  const evidenceById = new Map<string, CoachingEvidence>();
  for (const item of evidence) {
    if (evidenceById.has(item.id)) {
      throw new CoachingValidationError("DUPLICATE_EVIDENCE");
    }
    evidenceById.set(item.id, item);
  }

  if (
    report.ratings.length !== COACHING_RATING_CATEGORIES.length
    || new Set(report.ratings.map(({ category }) => category)).size
      !== COACHING_RATING_CATEGORIES.length
    || COACHING_RATING_CATEGORIES.some(
      (category) => !report.ratings.some((rating) => rating.category === category),
    )
  ) {
    throw new CoachingValidationError("INVALID_RATING_SET");
  }

  const references = [
    ...report.ratings,
    ...report.strengths,
    ...report.priorities,
    report.exercise,
    ...report.interpretationNotes,
  ];
  for (const reference of references) {
    for (const evidenceId of reference.evidenceIds) {
      if (!evidenceById.has(evidenceId)) {
        throw new CoachingValidationError("UNKNOWN_EVIDENCE");
      }
    }
  }

  const cueRating = report.ratings.find(({ category }) => category === "cue_responsiveness")!;
  if (options.soloCompleteTake && cueRating.score !== null) {
    throw new CoachingValidationError("SOLO_CUE_SCORE");
  }

  for (const rating of report.ratings) {
    if (rating.score === null) continue;

    const citedEvidence = rating.evidenceIds.map((id) => evidenceById.get(id)!);
    if (
      rating.confidence === "low"
      || citedEvidence.length === 0
      || citedEvidence.some(({ confidence }) => confidence === "low")
    ) {
      throw new CoachingValidationError("LOW_CONFIDENCE_SCORE");
    }
  }

  return report;
}

function tokenize(text: string): string[] {
  return text.normalize("NFKC").toLocaleLowerCase("en").match(/[\p{L}\p{N}']+/gu) ?? [];
}

function editDistance(expected: string[], performed: string[]): number {
  let previous = Array.from({ length: performed.length + 1 }, (_, index) => index);
  for (let expectedIndex = 1; expectedIndex <= expected.length; expectedIndex += 1) {
    const current = [expectedIndex];
    for (let performedIndex = 1; performedIndex <= performed.length; performedIndex += 1) {
      const substitution = previous[performedIndex - 1]!
        + (expected[expectedIndex - 1] === performed[performedIndex - 1] ? 0 : 1);
      current[performedIndex] = Math.min(
        previous[performedIndex]! + 1,
        current[performedIndex - 1]! + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[performed.length]!;
}
