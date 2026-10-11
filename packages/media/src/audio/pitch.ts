import type { VadFrame } from "./vad";

export type PitchResult = { valuesHz: number[]; medianHz: number | null; rangeHz: number | null };

const MINIMUM_PITCH_HZ = 60;
const MAXIMUM_PITCH_HZ = 500;
const MAXIMUM_ANALYSIS_FRAMES = 600;

/** A small, deterministic YIN implementation suitable for 20 ms voiced analysis frames. */
export function measurePitch(samples: Float32Array, sampleRate: number, frames: VadFrame[]): PitchResult {
  const windowLength = Math.ceil(sampleRate / MINIMUM_PITCH_HZ * 2);
  const voicedFrames = frames.filter((frame) => frame.speech);
  // Pitch analysis is substantially more expensive than VAD. Long rehearsals,
  // especially mixed tracks containing every AI cue, can contain hundreds of
  // thousands of voiced frames. Sample those frames evenly so analysis remains
  // representative without exhausting the worker's CPU budget.
  const analysisFrames = evenlySample(voicedFrames, MAXIMUM_ANALYSIS_FRAMES);
  const valuesHz = analysisFrames.flatMap((frame) => {
    const center = Math.round((frame.startSample + frame.endSample) / 2);
    const start = Math.max(0, Math.min(samples.length - windowLength, center - Math.floor(windowLength / 2)));
    const pitch = yin(samples.subarray(start, start + windowLength), sampleRate);
    return pitch === null ? [] : [pitch];
  });
  if (valuesHz.length === 0) return { valuesHz, medianHz: null, rangeHz: null };
  const sorted = [...valuesHz].sort((left, right) => left - right);
  return { valuesHz, medianHz: percentile(sorted, 0.5), rangeHz: percentile(sorted, 0.95) - percentile(sorted, 0.05) };
}

function evenlySample<T>(values: T[], limit: number): T[] {
  if (values.length <= limit) return values;
  return Array.from({ length: limit }, (_, index) => values[Math.floor(index * values.length / limit)]!);
}

function yin(frame: Float32Array, sampleRate: number): number | null {
  let mean = 0;
  for (const sample of frame) mean += sample;
  mean /= frame.length || 1;
  let variance = 0;
  for (const sample of frame) variance += (sample - mean) ** 2;
  if (variance / Math.max(1, frame.length) < 1e-10) return null;
  const minimumLag = Math.ceil(sampleRate / MAXIMUM_PITCH_HZ);
  const maximumLag = Math.min(Math.ceil(sampleRate / MINIMUM_PITCH_HZ), Math.floor(frame.length / 2));
  if (maximumLag <= minimumLag) return null;
  const difference = new Float64Array(maximumLag + 1);
  const cumulative = new Float64Array(maximumLag + 1);
  let running = 0;
  let bestLag = 0;
  let bestValue = Number.POSITIVE_INFINITY;
  for (let lag = 1; lag <= maximumLag; lag += 1) {
    let sum = 0;
    for (let index = 0; index + lag < frame.length; index += 1) {
      const delta = frame[index]! - frame[index + lag]!;
      sum += delta * delta;
    }
    difference[lag] = sum;
    running += sum;
    cumulative[lag] = sum * lag / (running || 1);
    if (lag >= minimumLag && cumulative[lag]! < bestValue) { bestValue = cumulative[lag]!; bestLag = lag; }
  }
  if (bestLag === 0 || bestValue > 0.15) return null;
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    if (cumulative[lag]! < 0.15) {
      while (lag + 1 <= maximumLag && cumulative[lag + 1]! < cumulative[lag]!) lag += 1;
      bestLag = lag;
      break;
    }
  }
  const before = bestLag > minimumLag ? cumulative[bestLag - 1]! : cumulative[bestLag]!;
  const current = cumulative[bestLag]!;
  const after = bestLag < maximumLag ? cumulative[bestLag + 1]! : current;
  const denominator = before - 2 * current + after;
  const refinedLag = denominator === 0 ? bestLag : bestLag + 0.5 * (before - after) / denominator;
  return refinedLag > 0 ? sampleRate / refinedLag : null;
}

function percentile(sorted: number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}
