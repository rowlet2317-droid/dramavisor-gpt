import type { RealtimeSpeechRequest } from "../realtime/port";
import type { CharacterSpeechInput, CharacterVoice, CharacterVoiceLifecycle } from "./port";

export interface RealtimeRoleSession {
  speak(input: RealtimeSpeechRequest): Promise<void>;
  cancelSpeech(): Promise<void>;
  close(): Promise<void>;
}

export class RealtimeRoleVoice implements CharacterVoice {
  constructor(private readonly session: RealtimeRoleSession,
    private readonly nowMs: () => number = () => performance.now()) {}

  async speak(input: CharacterSpeechInput, lifecycle?: CharacterVoiceLifecycle): Promise<{ startedAtMs: number }> {
    await this.session.speak({ characterId: input.characterId, elementId: input.elementId,
      exactText: input.exactText, performanceDirection: input.direction });
    const startedAtMs = this.nowMs();
    lifecycle?.onStarted?.(startedAtMs);
    return { startedAtMs };
  }

  async stop(): Promise<void> {
    await this.session.cancelSpeech();
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}
