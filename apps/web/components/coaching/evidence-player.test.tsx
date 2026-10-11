import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CoachingEvidence } from "@drama/domain/coaching";

import { EvidencePlayer, formatEvidenceDescription, resolveAudioDuration, startEvidencePlayback,
  type EvidenceAudio } from "./evidence-player";

const evidence: CoachingEvidence = { id: "audio-1", kind: "audio_observation", confidence: "high",
  description: "The final word becomes audibly quieter.", startMs: 200, endMs: 900,
  elementIds: ["line-1"] };

describe("EvidencePlayer", () => {
  it("seeks, plays through the evidence end, and highlights linked script elements", async () => {
    const listeners = new Map<string, () => void>();
    const audio: EvidenceAudio = { currentTime: 0, readyState: 1,
      play: vi.fn(async () => undefined), pause: vi.fn(),
      addEventListener: vi.fn((name, listener) => listeners.set(name, listener)),
      removeEventListener: vi.fn((name) => listeners.delete(name)) };
    const highlight = vi.fn();

    const stop = startEvidencePlayback(audio, evidence, highlight);
    await Promise.resolve();

    expect(audio.currentTime).toBe(0.2);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(highlight).toHaveBeenCalledWith(["line-1"]);
    audio.currentTime = 0.9;
    listeners.get("timeupdate")?.();
    expect(audio.pause).toHaveBeenCalledOnce();
    stop();
    expect(highlight).toHaveBeenLastCalledWith([]);
  });

  it("waits for metadata before seeking so evidence does not restart at the beginning", async () => {
    const listeners = new Map<string, () => void>();
    const audio: EvidenceAudio = { currentTime: 0, readyState: 0,
      play: vi.fn(async () => undefined), pause: vi.fn(),
      addEventListener: vi.fn((name, listener) => listeners.set(name, listener)),
      removeEventListener: vi.fn((name) => listeners.delete(name)) };

    startEvidencePlayback(audio, evidence, vi.fn());
    expect(audio.play).not.toHaveBeenCalled();
    listeners.get("loadedmetadata")?.();
    await Promise.resolve();

    expect(audio.currentTime).toBe(0.2);
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it("renders observable evidence and its linked script passage", () => {
    const markup = renderToStaticMarkup(<EvidencePlayer audioUrl="/private/audio" durationMs={360_000}
      evidence={[evidence]} lines={[{ elementId: "line-1", text: "You could stay.", startMs: 200, endMs: 900 }]} />);

    expect(markup).toContain("The final word becomes audibly quieter.");
    expect(markup).toContain("You could stay.");
    expect(markup).toContain("Play evidence");
    expect(markup).toContain("Play line");
    expect(markup).toContain("6:00");
    expect(markup).toContain("Recording position");
  });

  it("uses the media metadata duration instead of an inaccurate recorded duration", () => {
    expect(resolveAudioDuration(72.4, 360_000)).toBe(72.4);
    expect(resolveAudioDuration(null, 360_000)).toBe(360);
    expect(resolveAudioDuration(Number.POSITIVE_INFINITY, 360_000)).toBe(360);
  });

  it("presents measurement evidence as readable text instead of raw JSON", () => {
    expect(formatEvidenceDescription({ id: "metric-pace", kind: "deterministic_metric", confidence: "low",
      description: 'pace measurement: {"score":null,"confidence":"insufficient_data","wordsPerMinute":null}',
      startMs: null, endMs: null, elementIds: [] }))
      .toBe("Pace could not be measured reliably for this recording.");
    expect(formatEvidenceDescription({ id: "metric-loudness", kind: "deterministic_metric", confidence: "high",
      description: 'loudness measurement: {"rmsDb":-18.25,"confidence":"high"}',
      startMs: null, endMs: null, elementIds: [] }))
      .toBe("Measured average loudness: -18.3 dB.");
  });
});
