import { describe, expect, it } from "vitest";

import { FakeCharacterVoice } from "./fake-voice";
import { RealtimeRoleVoice } from "./realtime-role";
import { TtsFallbackVoice, type TtsPlayback } from "./tts-fallback";

const line = { characterId: "char_bea", elementId: "line_0002", exactText: "At last.",
  direction: "Urgent. Use only the exact supplied script text; never invent or paraphrase dialogue." };

describe("character voice adapters", () => {
  it("forwards exact script text and direction to a connected realtime role", async () => {
    const session = new FakeRoleVoiceSession();
    const voice = new RealtimeRoleVoice(session, () => 1_500);

    await expect(voice.speak(line)).resolves.toEqual({ startedAtMs: 1_500 });

    expect(session.speechRequests).toEqual([{ characterId: "char_bea", elementId: "line_0002",
      exactText: "At last.", performanceDirection: line.direction }]);
    await voice.stop();
    expect(session.cancelCalls).toBe(1);
    await voice.close();
    expect(session.closeCalls).toBe(1);
  });

  it("passes exact script text to the selected TTS fallback voice", async () => {
    const playback = new FakeTtsPlayback();
    const voice = new TtsFallbackVoice("marin", playback, () => 2_500);

    await expect(voice.speak(line)).resolves.toEqual({ startedAtMs: 2_500 });

    expect(playback.calls).toEqual([{ voice: "marin", elementId: "line_0002",
      exactText: "At last.", direction: line.direction }]);
    await voice.stop();
    expect(playback.stopCalls).toBe(1);
  });

  it("provides a deterministic fake that records speech and cleanup", async () => {
    const voice = new FakeCharacterVoice(() => 3_500);

    await expect(voice.speak(line)).resolves.toEqual({ startedAtMs: 3_500 });
    await voice.stop();

    expect(voice.calls).toEqual([line]);
    expect(voice.stopCalls).toBe(1);
  });
});

class FakeTtsPlayback implements TtsPlayback {
  readonly calls: Array<{ voice: string; exactText: string; direction: string }> = [];
  stopCalls = 0;
  async speak(input: { voice: string; exactText: string; direction: string; onStarted?: () => void }) {
    const { onStarted, ...speech } = input;
    this.calls.push(speech);
    onStarted?.();
  }
  async stop() { this.stopCalls += 1; }
}

class FakeRoleVoiceSession {
  readonly speechRequests: Array<{ characterId: string; elementId: string; exactText: string;
    performanceDirection: string }> = [];
  cancelCalls = 0;
  closeCalls = 0;
  async speak(input: { characterId: string; elementId: string; exactText: string; performanceDirection: string }) {
    this.speechRequests.push(input);
  }
  async cancelSpeech() { this.cancelCalls += 1; }
  async close() { this.closeCalls += 1; }
}
