export type CharacterSpeechInput = {
  characterId: string;
  elementId: string;
  exactText: string;
  direction: string;
};

export type CharacterVoiceLifecycle = {
  onStarted?: (startedAtMs: number) => void;
};

export interface CharacterVoice {
  speak(input: CharacterSpeechInput, lifecycle?: CharacterVoiceLifecycle): Promise<{ startedAtMs: number }>;
  stop(): Promise<void>;
}
