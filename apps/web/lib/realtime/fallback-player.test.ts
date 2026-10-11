import { describe, expect, it, vi } from "vitest";

import type { TtsPlayback } from "@drama/ai/character-voice/tts-fallback";

import { BrowserSpeechSynthesisPlayback, fallbackReadiness, ScriptedFallbackPlayer, ServerConfiguredTtsPlayback,
  scriptedVoiceCapability } from "./fallback-player";

describe("ScriptedFallbackPlayer", () => {
  it("offers honest configured-TTS progress with a manual actor completion path", () => {
    expect(fallbackReadiness({ tts: true, realtimeTranscript: false, browserRecognition: false }))
      .toEqual({ aiSpeech: "configured_tts", actorProgress: "manual", canContinue: true });
  });

  it("does not advertise continuation when no AI speech path is actually ready", () => {
    expect(fallbackReadiness({ tts: false, browserDistinctVoices: false,
      realtimeTranscript: true, browserRecognition: true }))
      .toEqual({ aiSpeech: "unavailable", actorProgress: "realtime_transcription", canContinue: false });
  });

  it("reports distinct browser voices and browser recognition without claiming realtime transcription", () => {
    expect(fallbackReadiness({ tts: false, browserDistinctVoices: true,
      realtimeTranscript: false, browserRecognition: true }))
      .toEqual({ aiSpeech: "browser_distinct_voices", actorProgress: "browser_recognition", canContinue: true });
  });

  it("starts at the current uncompleted line and never replays acknowledged dialogue", async () => {
    const playback = new FakePlayback();
    const events: string[] = [];
    const player = new ScriptedFallbackPlayer({ assignments: [
      { characterId: "alex", voice: "cedar", engine: "realtime" },
    ], createPlayback: () => playback, acknowledgedElementIds: ["line_1"],
    onSpeechStarted: ({ elementId }) => events.push(`started:${elementId}`),
    onSpeechFinished: ({ elementId }) => events.push(`finished:${elementId}`) });

    await expect(player.speak({ characterId: "alex", elementId: "line_1", exactText: "Already heard.",
      performanceDirection: "quiet" })).resolves.toEqual({ skipped: true });
    await expect(player.speak({ characterId: "alex", elementId: "line_3", exactText: "Continue here.",
      performanceDirection: "urgent" })).resolves.toEqual({ skipped: false });
    await expect(player.speak({ characterId: "alex", elementId: "line_3", exactText: "Continue here.",
      performanceDirection: "urgent" })).resolves.toEqual({ skipped: true });

    expect(playback.spoken).toEqual([{ voice: "cedar", elementId: "line_3",
      exactText: "Continue here.", direction: "urgent" }]);
    expect(events).toEqual(["started:line_3", "finished:line_3"]);
  });

  it("only enables browser synthesis when every assigned voice maps to a distinct suitable local voice", () => {
    const assignments = [
      { characterId: "alex", voice: "cedar", engine: "realtime" as const },
      { characterId: "bea", voice: "marin", engine: "tts" as const },
    ];

    expect(scriptedVoiceCapability(assignments, { configuredTts: false, browserVoices: [
      { name: "Cedar (English)", lang: "en-US", localService: true },
      { name: "Marin (English)", lang: "en-GB", localService: true },
    ] })).toEqual({ ready: true, mode: "browser_distinct_voices" });
    expect(scriptedVoiceCapability(assignments, { configuredTts: false, browserVoices: [
      { name: "Cedar (English)", lang: "en-US", localService: true },
      { name: "Cedar backup", lang: "en-US", localService: true },
    ] })).toEqual({ ready: false, reason: "distinct_browser_voices_unavailable" });
  });

  it("reports configured TTS as ready without accepting an ambiguous browser voice mapping", () => {
    expect(scriptedVoiceCapability([
      { characterId: "alex", voice: "cedar", engine: "realtime" },
      { characterId: "bea", voice: "marin", engine: "tts" },
    ], { configuredTts: true, browserVoices: [] })).toEqual({ ready: true, mode: "configured_tts" });
  });

  it("forwards configured TTS playback into the rehearsal recording", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const audio = { currentTime: 0, onended: null as (() => void) | null, onerror: null as (() => void) | null,
      onplaying: null as (() => void) | null, pause: vi.fn(), play: vi.fn(async () => undefined),
      preload: "" as HTMLMediaElement["preload"],
      remove: vi.fn(), src: "", captureStream: vi.fn(() => stream) };
    const onAudioStream = vi.fn();
    const playback = new ServerConfiguredTtsPlayback({ rehearsalSessionId: "session_1",
      fetch: async () => new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } }),
      createAudio: () => audio, createObjectUrl: () => "blob:speech", revokeObjectUrl: () => undefined,
      onAudioStream });

    const speaking = playback.speak({ elementId: "line_1" });
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
    audio.onplaying?.();
    expect(onAudioStream).toHaveBeenCalledWith(stream);
    audio.onended?.();
    await speaking;
  });

  it("reports unconfigured TTS when browser synthesis is unavailable", () => {
    expect(scriptedVoiceCapability([
      { characterId: "alex", voice: "cedar", engine: "realtime" },
    ], { configuredTts: false })).toEqual({ ready: false, reason: "tts_unconfigured" });
  });

  it("never substitutes the first browser voice when the assigned voice is unavailable", async () => {
    class FakeUtterance {
      voice: SpeechSynthesisVoice | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly text: string) {}
    }
    const synthesis = { getVoices: () => [{ name: "Unrelated", lang: "en-US", localService: true }],
      speak: vi.fn(), cancel: vi.fn() };
    vi.stubGlobal("speechSynthesis", synthesis);
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    try {
      const playback = new BrowserSpeechSynthesisPlayback();
      await expect(playback.speak({ voice: "cedar", exactText: "Pinned text.", direction: direction }))
        .rejects.toThrow("No suitable browser voice is available for cedar");
      expect(synthesis.speak).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("settles an active browser utterance when cancel emits no browser callback", async () => {
    class FakeUtterance {
      voice: SpeechSynthesisVoice | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly text: string) {}
    }
    let markSpoken: () => void = () => undefined;
    const spoken = new Promise<void>((resolve) => { markSpoken = resolve; });
    const synthesis = { getVoices: () => [{ name: "Cedar", lang: "en-US", localService: true }],
      speak: vi.fn(() => markSpoken()), cancel: vi.fn() };
    vi.stubGlobal("speechSynthesis", synthesis);
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    try {
      const playback = new BrowserSpeechSynthesisPlayback();
      const speaking = playback.speak({ voice: "cedar", exactText: "Pinned text.", direction });
      await spoken;
      const settled = expect(speaking).rejects.toThrow("Scripted voice playback was cancelled");

      await playback.stop();
      await playback.stop();
      await settled;
      expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports playback start only from the browser utterance onstart event", async () => {
    class FakeUtterance {
      voice: SpeechSynthesisVoice | null = null;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly text: string) {}
    }
    let utterance: FakeUtterance | null = null;
    const synthesis = { getVoices: () => [{ name: "Cedar", lang: "en-US", localService: true }],
      speak: vi.fn((value: FakeUtterance) => { utterance = value; }), cancel: vi.fn() };
    vi.stubGlobal("speechSynthesis", synthesis);
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    try {
      const onStarted = vi.fn();
      const playback = new BrowserSpeechSynthesisPlayback();
      const speaking = playback.speak({ voice: "cedar", exactText: "Pinned text.", direction,
        onStarted });
      await vi.waitFor(() => expect(synthesis.speak).toHaveBeenCalledTimes(1));

      expect(onStarted).not.toHaveBeenCalled();
      (utterance as FakeUtterance | null)?.onstart?.();
      expect(onStarted).toHaveBeenCalledTimes(1);
      (utterance as FakeUtterance | null)?.onend?.();
      await speaking;
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const direction = "Objective: win the argument. Use only the exact supplied script text; never invent or paraphrase dialogue.";

class FakePlayback implements TtsPlayback {
  readonly spoken: Array<{ voice: string; exactText: string; direction: string }> = [];
  async speak(input: { voice: string; exactText: string; direction: string; onStarted?: () => void }) {
    const { onStarted, ...speech } = input;
    this.spoken.push(speech);
    onStarted?.();
  }
  async stop() {}
}
