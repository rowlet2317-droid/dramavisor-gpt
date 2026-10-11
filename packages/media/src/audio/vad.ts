export const VAD_FRAME_MS = 20;
export const VAD_HOP_MS = 10;
export const VAD_SPEECH_ABOVE_NOISE_DB = 12;
export const VAD_MIN_SPEECH_MS = 120;

export type VadFrame = {
  startSample: number;
  endSample: number;
  rms: number;
  rmsDb: number;
  speech: boolean;
};

export type VadResult = { frames: VadFrame[]; noiseFloorDb: number };

export function detectSpeech(samples: Float32Array, sampleRate: number): VadResult {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("A positive sample rate is required");
  const frameLength = Math.max(1, Math.round(sampleRate * VAD_FRAME_MS / 1_000));
  const hopLength = Math.max(1, Math.round(sampleRate * VAD_HOP_MS / 1_000));
  const frames: VadFrame[] = [];
  for (let start = 0; start + frameLength <= samples.length; start += hopLength) {
    let sumSquares = 0;
    for (let index = start; index < start + frameLength; index += 1) sumSquares += samples[index]! ** 2;
    const rms = Math.sqrt(sumSquares / frameLength);
    frames.push({ startSample: start, endSample: start + frameLength, rms, rmsDb: toDb(rms), speech: false });
  }
  if (frames.length === 0 && samples.length > 0) {
    let sumSquares = 0;
    for (const sample of samples) sumSquares += sample ** 2;
    const rms = Math.sqrt(sumSquares / samples.length);
    frames.push({ startSample: 0, endSample: samples.length, rms, rmsDb: toDb(rms), speech: false });
  }
  const noiseFloorDb = measuredNoiseFloor(frames);
  const threshold = noiseFloorDb + VAD_SPEECH_ABOVE_NOISE_DB;
  const candidates = frames.map((frame) => frame.rmsDb > threshold);
  const minimumFrames = Math.max(1, Math.ceil((VAD_MIN_SPEECH_MS - VAD_FRAME_MS) / VAD_HOP_MS) + 1);
  for (let start = 0; start < candidates.length;) {
    if (!candidates[start]) { start += 1; continue; }
    let end = start + 1;
    while (end < candidates.length && candidates[end]) end += 1;
    if (end - start >= minimumFrames) for (let index = start; index < end; index += 1) frames[index]!.speech = true;
    start = end;
  }
  // A take can begin immediately and remain voiced throughout.  In that case every frame participates
  // in the noise estimate, so the relative threshold has no quiet baseline to compare against.
  if (!frames.some((frame) => frame.speech) && frames.length >= minimumFrames
    && hasVoiceLikeZeroCrossingRate(samples, sampleRate)) {
    for (const frame of frames) frame.speech = true;
  }
  return { frames, noiseFloorDb };
}

function hasVoiceLikeZeroCrossingRate(samples: Float32Array, sampleRate: number): boolean {
  if (samples.length < 2) return false;
  let crossings = 0;
  let previous = samples[0]!;
  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index]!;
    if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) crossings += 1;
    previous = current;
  }
  const crossingsPerSecond = crossings / samples.length * sampleRate;
  // A finite window can miss one boundary crossing of a 60 Hz waveform, so permit one-window resolution.
  return crossingsPerSecond >= 120 - sampleRate / samples.length && crossingsPerSecond <= 1_000;
}

function measuredNoiseFloor(frames: VadFrame[]): number {
  const finite = frames.map((frame) => frame.rmsDb).filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return -120;
  const quietCount = Math.max(1, Math.ceil(finite.length * 0.2));
  return finite.slice(0, quietCount).reduce((sum, value) => sum + value, 0) / quietCount;
}

function toDb(amplitude: number): number {
  return amplitude === 0 ? -120 : 20 * Math.log10(amplitude);
}
