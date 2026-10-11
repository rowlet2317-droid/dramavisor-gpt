import { describe, expect, it } from "vitest";

import type { LineAlignment } from "@drama/domain/transcript";

import { decodeWav, WavDecodeError } from "./decode-wav";
import { measureTake } from "./metrics";
import { measurePitch } from "./pitch";
import { detectSpeech } from "./vad";

const sampleRate = 16_000;

describe("decodeWav", () => {
  it("decodes normalized signed 16-bit PCM samples without changing their scale", () => {
    // Break caught: unsigned or big-endian sample conversion changes waveform amplitude and all downstream metrics.
    const wav = pcmWav(new Int16Array([-32_768, 0, 16_384]));

    expect(decodeWav(wav)).toEqual(expect.objectContaining({ sampleRate, channels: 1, bitsPerSample: 16,
      samples: Float32Array.from([-1, 0, 0.5]) }));
  });

  it("rejects a RIFF container whose declared bytes are truncated", () => {
    // Break caught: decoding past the available RIFF container invents samples from absent data.
    const wav = pcmWav(new Int16Array(160));
    new DataView(wav.buffer).setUint32(4, wav.length + 40, true);

    expect(() => decodeWav(wav)).toThrow(WavDecodeError);
  });

  it.each([
    {
      name: "truncated chunk header",
      wav: () => appendRaw(pcmWav(new Int16Array(2)), Uint8Array.of(74, 85, 78, 75)),
    }, {
      name: "missing odd-chunk padding",
      wav: () => appendRaw(pcmWav(new Int16Array(2)), chunkHeader("JUNK", 1), Uint8Array.of(7)),
    }, {
      name: "chunk data beyond the container",
      wav: () => appendRaw(pcmWav(new Int16Array(2)), chunkHeader("JUNK", 2), Uint8Array.of(7)),
    }, {
      name: "invalid PCM block alignment",
      wav: () => {
        const wav = pcmWav(new Int16Array(2));
        new DataView(wav.buffer).setUint16(32, 4, true);
        return wav;
      },
    },
  ])("rejects $name", ({ wav }) => {
    // Break caught: malformed chunks or PCM metadata must not be decoded as a normalized waveform.
    expect(() => decodeWav(wav())).toThrow(WavDecodeError);
  });
});

describe("measureTake", () => {
  it("measures an inserted two-second pause", () => {
    // Break caught: treating internal silence as speech removes the pause an actor needs explained.
    const samples = concat(tone(440, 400), silence(2_000), tone(440, 400));

    const metrics = measureTake(samples, { sampleRate, alignments: timedAlignments(), wordCount: 4 });

    expect(metrics.pauses.some((pause) => pause.startMs >= 360 && pause.startMs <= 440
      && pause.endMs >= 2_360 && pause.endMs <= 2_440
      && pause.durationMs >= 1_950 && pause.durationMs <= 2_050)).toBe(true);
  });

  it("keeps a continuous voiced tone out of the silence classification", () => {
    // Break caught: estimating noise from voiced frames can make a continuous performance appear silent.
    const metrics = measureTake(tone(220, 1_000), {
      sampleRate, alignments: timedAlignments(0, 1_000), wordCount: 2,
    });

    expect(metrics.speechDurationMs).toBeGreaterThanOrEqual(960);
    expect(metrics.silenceDurationMs).toBeLessThanOrEqual(40);
    expect(metrics.wordsPerMinute).toBeCloseTo(120, 0);
  });

  it("returns no pitch score for mostly unvoiced audio", () => {
    // Break caught: a pitch median based on too few periodic frames is presented as reliable feedback.
    const metrics = measureTake(silence(1_000), {
      sampleRate, alignments: timedAlignments(0, 1_000), wordCount: 2,
    });

    expect(metrics.pitch.confidence).toBe("insufficient_data");
    expect(metrics.pitch.score).toBeNull();
  });

  it("reports a voiced pitch median and range from a real generated waveform", () => {
    // Break caught: using frame RMS as pitch would make a 220 Hz tone report an unrelated value.
    const metrics = measureTake(tone(220, 1_000), {
      sampleRate, alignments: timedAlignments(0, 1_000), wordCount: 2,
    });

    expect(metrics.pitch.medianHz).toBeCloseTo(220, 0);
    expect(metrics.pitch.rangeHz).toBeLessThan(5);
    expect(metrics.pitch.confidence).toBe("high");
  });

  it("maps clipping over five percent to insufficient data and a null score", () => {
    // Break caught: heavily clipped takes must not turn corrupted waveform measurements into a rating.
    const clipped = tone(220, 1_000);
    clipped.fill(1, 0, Math.ceil(clipped.length * 0.06));

    const metrics = measureTake(clipped, {
      sampleRate, alignments: timedAlignments(0, 1_000), wordCount: 2,
    });

    expect(metrics.clippingRatio).toBeCloseTo(0.06, 3);
    expect(metrics.technicalWarnings).toContain("CLIPPING");
    expect(metrics.loudness.confidence).toBe("insufficient_data");
    expect(metrics.loudness.score).toBeNull();
  });

  it("uses only known alignment windows for line metrics and degrades low coverage", () => {
    // Break caught: missing timing must not attach a made-up line window or leave its confidence high.
    const metrics = measureTake(tone(220, 1_000), {
      sampleRate,
      wordCount: 2,
      alignments: [{ ...timedAlignments(0, 400)[0]!, elementId: "known" }, {
        elementId: "unknown", scriptOrdinal: 2, transcriptStartMs: null, transcriptEndMs: null,
        similarity: 0, status: "uncertain",
      }],
    });

    expect(metrics.alignmentCoverage).toBeCloseTo(0.4, 3);
    expect(metrics.lines).toEqual([expect.objectContaining({ elementId: "known", startMs: 0, endMs: 400 })]);
    expect(metrics.pace.confidence).toBe("insufficient_data");
    expect(metrics.pace.score).toBeNull();
  });

  it("measures a line's non-overlapping speech, silence, and RMS", () => {
    // Break caught: summing 20 ms frames at a 10 ms hop double-counts time and energy inside a line.
    const metrics = measureTake(concat(tone(220, 500), silence(500)), {
      sampleRate, wordCount: 2, alignments: timedAlignments(0, 1_000),
    });

    expect(metrics.lines).toEqual([expect.objectContaining({
      speechDurationMs: expect.closeTo(500, 1),
      silenceDurationMs: expect.closeTo(500, 1),
      rmsDb: expect.closeTo(-18.06, 2),
    })]);
  });

  it("counts only matched evidence and a 0.65 paraphrase toward alignment coverage", () => {
    // Break caught: timed uncertain or sub-threshold alignments can falsely clear the 60% evidence gate.
    const samples = tone(220, 1_000);
    const weakEvidence = measureTake(samples, {
      sampleRate, wordCount: 2, alignments: [
        alignment("uncertain", 0, 400, "uncertain", 0.9),
        alignment("below-paraphrase", 400, 800, "uncertain", 0.649),
        alignment("paraphrase", 800, 1_000, "paraphrased", 0.65),
      ],
    });
    const boundaryEvidence = measureTake(samples, {
      sampleRate, wordCount: 2, alignments: [
        alignment("matched", 0, 590, "matched", 0.9),
        alignment("paraphrase", 590, 600, "paraphrased", 0.65),
      ],
    });

    expect(weakEvidence.alignmentCoverage).toBeCloseTo(0.2, 3);
    expect(weakEvidence.pace.confidence).toBe("insufficient_data");
    expect(boundaryEvidence.alignmentCoverage).toBeCloseTo(0.6, 3);
    expect(boundaryEvidence.pace.confidence).toBe("low");
  });

  it("lets mandatory insufficient-data causes override unavailable WPM", () => {
    // Break caught: missing words must not downgrade an insufficient-evidence take to merely low confidence.
    const metrics = measureTake(tone(220, 1_000), {
      sampleRate, alignments: [alignment("unknown", 0, 1_000, "uncertain", 0)],
    });

    expect(metrics.wordsPerMinute).toBeNull();
    expect(metrics.pace.confidence).toBe("insufficient_data");
    expect(metrics.pace.score).toBeNull();
  });
});

describe("detectSpeech", () => {
  it("accepts eleven overlapping frames that span the 120 ms speech minimum", () => {
    // Break caught: treating hop count as elapsed duration rejects an 11-frame, 120 ms run.
    const samples = constant(-60, 1_000);
    samples.set(tone(220, 100), 200 / 1_000 * sampleRate);

    expect(detectSpeech(samples, sampleRate).frames.filter((frame) => frame.speech)).toHaveLength(11);
  });

  it("does not call a continuous DC signal speech without a 12 dB noise-floor margin", () => {
    // Break caught: a voiced fallback must not convert uniform electrical noise into speech.
    const samples = new Float32Array(sampleRate).fill(0.1);

    expect(detectSpeech(samples, sampleRate).frames.some((frame) => frame.speech)).toBe(false);
  });
});

describe("measurePitch", () => {
  it("measures the documented 60 Hz lower pitch boundary from voiced audio", () => {
    // Break caught: a 20 ms YIN window cannot observe the 60 Hz period it claims to support.
    const metrics = measureTake(tone(60, 1_000), {
      sampleRate, wordCount: 2, alignments: timedAlignments(0, 1_000),
    });

    expect(metrics.pitch.medianHz).toBeCloseTo(60, 0);
    expect(metrics.pitch.confidence).toBe("high");
  });

  it("rejects a DC frame instead of reporting a false 500 Hz pitch", () => {
    // Break caught: zero YIN differences are non-periodic DC, not the maximum supported pitch.
    const pitch = measurePitch(new Float32Array(640).fill(0.1), sampleRate, [{
      startSample: 0, endSample: 320, rms: 0.1, rmsDb: -20, speech: true,
    }]);

    expect(pitch).toEqual({ valuesHz: [], medianHz: null, rangeHz: null });
  });
});

function tone(frequencyHz: number, durationMs: number): Float32Array {
  const length = Math.round(sampleRate * durationMs / 1_000);
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) samples[index] = 0.25 * Math.sin(2 * Math.PI * frequencyHz * index / sampleRate);
  return samples;
}

function silence(durationMs: number): Float32Array {
  return new Float32Array(Math.round(sampleRate * durationMs / 1_000));
}

function constant(db: number, durationMs: number): Float32Array {
  return new Float32Array(Math.round(sampleRate * durationMs / 1_000)).fill(10 ** (db / 20));
}

function concat(...segments: Float32Array[]): Float32Array {
  const samples = new Float32Array(segments.reduce((length, segment) => length + segment.length, 0));
  let offset = 0;
  for (const segment of segments) {
    samples.set(segment, offset);
    offset += segment.length;
  }
  return samples;
}

function timedAlignments(startMs = 0, endMs = 1_000): LineAlignment[] {
  return [alignment("line", startMs, endMs, "matched", 1)];
}

function alignment(elementId: string, startMs: number, endMs: number, status: LineAlignment["status"],
  similarity: number): LineAlignment {
  return { elementId, scriptOrdinal: 1, transcriptStartMs: startMs, transcriptEndMs: endMs, similarity, status };
}

function pcmWav(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.byteLength);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, samples.byteLength, true);
  for (let index = 0; index < samples.length; index += 1) view.setInt16(44 + index * 2, samples[index]!, true);
  return bytes;
}

function appendRaw(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  return bytes;
}

function chunkHeader(id: string, size: number): Uint8Array {
  const bytes = new Uint8Array(8);
  writeAscii(bytes, 0, id);
  new DataView(bytes.buffer).setUint32(4, size, true);
  return bytes;
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
}
