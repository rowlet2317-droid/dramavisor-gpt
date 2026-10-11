import { describe, expect, it } from "vitest";

import type { VadFrame } from "./vad";
import { measurePitch } from "./pitch";

describe("measurePitch", () => {
  it("bounds expensive pitch analysis for long fully voiced rehearsal tracks", () => {
    const sampleRate = 16_000;
    const samples = Float32Array.from({ length: sampleRate }, (_, index) =>
      Math.sin(2 * Math.PI * 220 * index / sampleRate));
    const frames: VadFrame[] = Array.from({ length: 120_000 }, (_, index) => ({
      startSample: index * 160, endSample: index * 160 + 320, rms: 0.5, rmsDb: -6, speech: true,
    }));

    const result = measurePitch(samples, sampleRate, frames);

    expect(result.valuesHz.length).toBeLessThanOrEqual(600);
    expect(result.medianHz).toBeGreaterThan(200);
    expect(result.medianHz).toBeLessThan(240);
  });
});
