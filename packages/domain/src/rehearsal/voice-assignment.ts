export type VoiceEngine = "realtime" | "tts";

export type SceneVoiceCharacter = {
  playId: string;
  characterId: string;
  dialogueCount: number;
  preferredVoice?: string;
};

export type VoiceAssignment = {
  characterId: string;
  voice: string;
  engine: VoiceEngine;
};

export type CharacterDirectionInput = {
  relationship?: string | null;
  immediateObjective?: string | null;
  tactic?: string | null;
  interpretation?: string | null;
};

export function assignVoices(characters: SceneVoiceCharacter[], existing: VoiceAssignment[],
  supportedVoices: string[], options: { realtimeLimit?: number } = {}): VoiceAssignment[] {
  if (supportedVoices.length === 0) throw new Error("At least one supported voice is required");
  const supported = new Set(supportedVoices);
  const persisted = new Map(existing.map((assignment) => [assignment.characterId, assignment]));
  const ranked = [...characters].sort((left, right) => right.dialogueCount - left.dialogueCount
    || left.characterId.localeCompare(right.characterId));
  if (new Set(ranked.map(({ characterId }) => characterId)).size !== ranked.length) {
    throw new Error("Scene voice characters require unique character IDs");
  }
  const realtimeLimit = Math.max(0, options.realtimeLimit ?? 4);
  const used = new Set(existing.filter(({ voice }) => supported.has(voice)).map(({ voice }) => voice));

  return ranked.map((character, index) => {
    const previous = persisted.get(character.characterId);
    if (previous && supported.has(previous.voice)) return { ...previous };
    if (character.preferredVoice && !supported.has(character.preferredVoice)) {
      throw new Error(`Unsupported voice override: ${character.preferredVoice}`);
    }
    const voice = character.preferredVoice
      ?? chooseVoice(`${character.playId}:${character.characterId}`, supportedVoices, used);
    used.add(voice);
    return { characterId: character.characterId, voice, engine: index < realtimeLimit ? "realtime" : "tts" };
  });
}

const exactTextConstraint = "Use only the exact supplied script text; never invent or paraphrase dialogue.";

export function buildCharacterDirection(input: CharacterDirectionInput): string {
  const details = [
    labeled("Relationship", input.relationship),
    labeled("Objective", input.immediateObjective),
    labeled("Tactic", input.tactic),
    labeled("Interpretation", input.interpretation),
  ].filter((value): value is string => value !== null).join(" ");
  const available = 300 - exactTextConstraint.length - (details ? 1 : 0);
  const boundedDetails = details.length <= available ? details
    : `${details.slice(0, Math.max(0, available - 1)).trimEnd()}…`;
  return boundedDetails ? `${boundedDetails} ${exactTextConstraint}` : exactTextConstraint;
}

function chooseVoice(key: string, voices: string[], used: Set<string>): string {
  const start = stableHash(key) % voices.length;
  for (let offset = 0; offset < voices.length; offset += 1) {
    const candidate = voices[(start + offset) % voices.length]!;
    if (!used.has(candidate)) return candidate;
  }
  return voices[start]!;
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function labeled(label: string, value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? `${label}: ${normalized}` : null;
}
