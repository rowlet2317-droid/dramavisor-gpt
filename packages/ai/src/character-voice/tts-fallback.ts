import type { CharacterSpeechInput, CharacterVoice, CharacterVoiceLifecycle } from "./port";

export interface TtsPlayback {
  speak(input: { voice: string; elementId: string; exactText: string; direction: string;
    onStarted?: () => void }): Promise<void>;
  stop(): Promise<void>;
}

export class TtsFallbackVoice implements CharacterVoice {
  constructor(private readonly voice: string, private readonly playback: TtsPlayback,
    private readonly nowMs: () => number = () => performance.now()) {}

  async speak(input: CharacterSpeechInput, lifecycle?: CharacterVoiceLifecycle): Promise<{ startedAtMs: number }> {
    let startedAtMs: number | undefined;
    await this.playback.speak({ voice: this.voice, elementId: input.elementId, exactText: input.exactText,
      direction: input.direction, onStarted: () => {
        if (startedAtMs !== undefined) return;
        startedAtMs = this.nowMs();
        lifecycle?.onStarted?.(startedAtMs);
      } });
    if (startedAtMs === undefined) throw new Error("TTS playback completed without a playback-start signal");
    return { startedAtMs };
  }

  async stop(): Promise<void> {
    await this.playback.stop();
  }
}
