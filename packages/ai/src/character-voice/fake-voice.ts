import type { CharacterSpeechInput, CharacterVoice, CharacterVoiceLifecycle } from "./port";

export class FakeCharacterVoice implements CharacterVoice {
  readonly calls: CharacterSpeechInput[] = [];
  stopCalls = 0;

  constructor(private readonly nowMs: () => number = () => 0) {}

  async speak(input: CharacterSpeechInput, lifecycle?: CharacterVoiceLifecycle): Promise<{ startedAtMs: number }> {
    this.calls.push(structuredClone(input));
    const startedAtMs = this.nowMs();
    lifecycle?.onStarted?.(startedAtMs);
    return { startedAtMs };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}
