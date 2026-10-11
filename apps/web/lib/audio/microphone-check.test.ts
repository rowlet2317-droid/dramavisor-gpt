import { describe, expect, it } from "vitest";

import { inspectMicrophone } from "./microphone-check";

const sampleRate = 1_000;

describe("inspectMicrophone", () => {
  it.each([
    { rmsDb: -45, warns: false },
    { rmsDb: -45.01, warns: true },
  ])("uses -45 dBFS as the low-signal boundary", ({ rmsDb, warns }) => {
    const result = inspectMicrophone(constantSamples(rmsDb, 3 * sampleRate), sampleRate);

    expect(result.rmsDb).toBeCloseTo(rmsDb, 2);
    expect(result.warnings.includes("SIGNAL_TOO_LOW")).toBe(warns);
    expect(result.ok).toBe(true);
  });

  it.each([
    { clippedSamples: 3, warns: false },
    { clippedSamples: 4, warns: true },
  ])("flags clipping only above 0.1% of all samples", ({ clippedSamples, warns }) => {
    const samples = constantSamples(-20, 3 * sampleRate);
    samples.fill(dbToAmplitude(-0.49), 0, clippedSamples);

    const result = inspectMicrophone(samples, sampleRate);

    expect(result.peakDb).toBeCloseTo(-0.49, 2);
    expect(result.warnings.includes("CLIPPING")).toBe(warns);
    expect(result.ok).toBe(true);
  });

  it.each([
    { noiseDb: -35, warns: false },
    { noiseDb: -34.99, warns: true },
  ])("uses the first second and -35 dBFS as the background-noise boundary", ({ noiseDb, warns }) => {
    const samples = new Float32Array(3 * sampleRate);
    samples.fill(dbToAmplitude(noiseDb), 0, sampleRate);
    samples.fill(dbToAmplitude(-50), sampleRate);

    const result = inspectMicrophone(samples, sampleRate);

    expect(result.warnings.includes("BACKGROUND_NOISE")).toBe(warns);
    expect(result.ok).toBe(true);
  });

  it("reports RMS and peak values from the supplied PCM samples", () => {
    const samples = new Float32Array([0.5, -0.5, 0, 0]);

    const result = inspectMicrophone(samples, 4);

    expect(result.rmsDb).toBeCloseTo(-9.0309, 3);
    expect(result.peakDb).toBeCloseTo(-6.0206, 3);
  });
});

function constantSamples(db: number, length: number): Float32Array {
  return new Float32Array(length).fill(dbToAmplitude(db));
}

function dbToAmplitude(db: number): number {
  return 10 ** (db / 20);
}
