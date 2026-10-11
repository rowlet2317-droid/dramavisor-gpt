export const MEASUREMENT_CONFIDENCE = ["high", "medium", "low", "insufficient_data"] as const;
export type MeasurementConfidence = typeof MEASUREMENT_CONFIDENCE[number];

export type TechnicalQualityWarning = "CLIPPING" | "LOW_ALIGNMENT_COVERAGE";

export type ScoredMeasurement = {
  confidence: MeasurementConfidence;
  score: number | null;
};

export type Pause = { startMs: number; endMs: number; durationMs: number };

export type PaceMeasurement = ScoredMeasurement & { wordsPerMinute: number | null; wordCount: number };

export type LoudnessMeasurement = ScoredMeasurement & { rmsDb: number; rangeDb: number };

export type PitchMeasurement = ScoredMeasurement & {
  medianHz: number | null;
  rangeHz: number | null;
  voicedFrames: number;
};

export type LineMetric = {
  elementId: string;
  startMs: number;
  endMs: number;
  speechDurationMs: number;
  silenceDurationMs: number;
  rmsDb: number;
};

export type TakeMetrics = {
  durationMs: number;
  speechDurationMs: number;
  silenceDurationMs: number;
  pauses: Pause[];
  alignmentCoverage: number;
  clippingRatio: number;
  technicalWarnings: TechnicalQualityWarning[];
  pace: PaceMeasurement;
  loudness: LoudnessMeasurement;
  pitch: PitchMeasurement;
  lines: LineMetric[];
  wordsPerMinute: number | null;
};
