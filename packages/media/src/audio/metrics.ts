import type { LineAlignment, TranscriptWord } from "@drama/domain/transcript";
import type { LineMetric, MeasurementConfidence, TakeMetrics } from "@drama/domain/audio-metrics";

import { detectSpeech, type VadFrame } from "./vad";
import { measurePitch } from "./pitch";

export type MeasureTakeOptions = {
  sampleRate: number;
  alignments: LineAlignment[];
  wordCount?: number;
  words?: TranscriptWord[];
};

export function measureTake(samples: Float32Array, options: MeasureTakeOptions): TakeMetrics {
  if (!Number.isFinite(options.sampleRate) || options.sampleRate <= 0) throw new Error("A positive sample rate is required");
  const durationMs = samples.length / options.sampleRate * 1_000;
  const { frames } = detectSpeech(samples, options.sampleRate);
  const segments = speechSegments(frames, options.sampleRate);
  const speechDurationMs = intervalsDuration(segments);
  const silenceDurationMs = Math.max(0, durationMs - speechDurationMs);
  const pauses = segments.slice(1).map((segment, index) => ({ startMs: segments[index]!.endMs,
    endMs: segment.startMs, durationMs: segment.startMs - segments[index]!.endMs }));
  const alignmentCoverage = coverage(options.alignments, durationMs);
  const clippingRatio = clippedRatio(samples);
  const technicalWarnings = [
    ...(clippingRatio > 0.05 ? ["CLIPPING" as const] : []),
    ...(alignmentCoverage < 0.6 ? ["LOW_ALIGNMENT_COVERAGE" as const] : []),
  ];
  const sharedConfidence = measurementConfidence(alignmentCoverage, clippingRatio);
  const wordCount = options.wordCount ?? options.words?.length ?? 0;
  const wordsPerMinute = wordCount > 0 && speechDurationMs > 0 ? wordCount / speechDurationMs * 60_000 : null;
  const takeRmsDb = calculateRmsDb(samples);
  const loudnessRangeDb = frameRange(frames);
  const pitch = measurePitch(samples, options.sampleRate, frames);
  const pitchConfidence: MeasurementConfidence = sharedConfidence === "insufficient_data" || pitch.valuesHz.length < 50
    ? "insufficient_data" : sharedConfidence;
  const paceConfidence: MeasurementConfidence = sharedConfidence === "insufficient_data" ? "insufficient_data"
    : wordsPerMinute === null ? "low" : sharedConfidence;
  const lines = lineMetrics(options.alignments, frames, samples, durationMs, options.sampleRate);
  return {
    durationMs, speechDurationMs, silenceDurationMs, pauses, alignmentCoverage, clippingRatio, technicalWarnings,
    wordsPerMinute,
    pace: { wordsPerMinute, wordCount, confidence: paceConfidence,
      score: paceConfidence === "high" || paceConfidence === "medium" ? wordsPerMinute : null },
    loudness: { rmsDb: takeRmsDb, rangeDb: loudnessRangeDb, confidence: sharedConfidence,
      score: sharedConfidence === "high" || sharedConfidence === "medium" ? takeRmsDb : null },
    pitch: { medianHz: pitch.medianHz, rangeHz: pitch.rangeHz, voicedFrames: pitch.valuesHz.length,
      confidence: pitchConfidence, score: pitchConfidence === "high" || pitchConfidence === "medium" ? pitch.medianHz : null },
    lines,
  };
}

type Interval = { startMs: number; endMs: number };

function speechSegments(frames: VadFrame[], sampleRate: number): Interval[] {
  const segments: Interval[] = [];
  for (const frame of frames) {
    if (!frame.speech) continue;
    const startMs = frame.startSample / sampleRate * 1_000;
    const endMs = frame.endSample / sampleRate * 1_000;
    const previous = segments.at(-1);
    if (previous && startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, endMs);
    else segments.push({ startMs, endMs });
  }
  return segments;
}

function coverage(alignments: LineAlignment[], durationMs: number): number {
  if (durationMs <= 0) return 0;
  const windows = alignments.flatMap((alignment) => !isUsableAlignment(alignment)
    || alignment.transcriptStartMs === null || alignment.transcriptEndMs === null
    ? [] : [{ startMs: Math.max(0, alignment.transcriptStartMs), endMs: Math.min(durationMs, alignment.transcriptEndMs) }])
    .filter((window) => window.endMs > window.startMs).sort((left, right) => left.startMs - right.startMs);
  return Math.min(1, intervalsDuration(windows) / durationMs);
}

function isUsableAlignment(alignment: LineAlignment): boolean {
  return alignment.status === "matched" && alignment.similarity >= 0.9
    || alignment.status === "paraphrased" && alignment.similarity >= 0.65;
}

function intervalsDuration(intervals: Interval[]): number {
  let duration = 0;
  let end = -Infinity;
  for (const interval of intervals) {
    const start = Math.max(interval.startMs, end);
    duration += Math.max(0, interval.endMs - start);
    end = Math.max(end, interval.endMs);
  }
  return duration;
}

function measurementConfidence(alignmentCoverage: number, clippingRatio: number): MeasurementConfidence {
  if (alignmentCoverage < 0.6 || clippingRatio > 0.05) return "insufficient_data";
  if (alignmentCoverage < 0.75) return "low";
  if (alignmentCoverage < 0.9) return "medium";
  return "high";
}

function clippedRatio(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let count = 0;
  for (const sample of samples) if (Math.abs(sample) >= 0.999) count += 1;
  return count / samples.length;
}

function calculateRmsDb(samples: Float32Array): number {
  if (samples.length === 0) return -120;
  let sum = 0;
  for (const sample of samples) sum += sample ** 2;
  const rms = Math.sqrt(sum / samples.length);
  return rms === 0 ? -120 : 20 * Math.log10(rms);
}

function frameRange(frames: VadFrame[]): number {
  const values = frames.map((frame) => frame.rmsDb).filter((value) => value > -120).sort((left, right) => left - right);
  if (values.length === 0) return 0;
  return percentile(values, 0.95) - percentile(values, 0.05);
}

function lineMetrics(alignments: LineAlignment[], frames: VadFrame[], samples: Float32Array, durationMs: number,
  sampleRate: number): LineMetric[] {
  return alignments.flatMap((alignment) => {
    if (alignment.transcriptStartMs === null || alignment.transcriptEndMs === null) return [];
    const startMs = Math.max(0, alignment.transcriptStartMs);
    const endMs = Math.min(durationMs, alignment.transcriptEndMs);
    if (endMs <= startMs) return [];
    const speechDurationMs = frames.reduce((sum, frame, index) => !frame.speech ? sum : sum + overlap(startMs,
      endMs, frame.startSample / sampleRate * 1_000, (frames[index + 1]?.startSample ?? frame.endSample)
        / sampleRate * 1_000), 0);
    const startSample = Math.max(0, Math.floor(startMs / 1_000 * sampleRate));
    const endSample = Math.min(samples.length, Math.ceil(endMs / 1_000 * sampleRate));
    let sumSquares = 0;
    for (let index = startSample; index < endSample; index += 1) sumSquares += samples[index]! ** 2;
    const rms = Math.sqrt(sumSquares / Math.max(1, endSample - startSample));
    return [{ elementId: alignment.elementId, startMs, endMs, speechDurationMs,
      silenceDurationMs: endMs - startMs - speechDurationMs, rmsDb: rms === 0 ? -120 : 20 * Math.log10(rms) }];
  });
}

function overlap(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function percentile(sorted: number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}
