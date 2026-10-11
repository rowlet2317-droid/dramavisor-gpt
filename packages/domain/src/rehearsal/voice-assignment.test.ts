import { describe, expect, it } from "vitest";

import { assignVoices, buildCharacterDirection, type SceneVoiceCharacter } from "./voice-assignment";

const supportedVoices = ["alloy", "ash", "cedar", "marin", "sage"];
const sceneCharacters: SceneVoiceCharacter[] = [
  { playId: "play-1", characterId: "char_alex", dialogueCount: 12 },
  { playId: "play-1", characterId: "char_bea", dialogueCount: 9 },
  { playId: "play-1", characterId: "char_cleo", dialogueCount: 6 },
];

describe("stable rehearsal voice assignment", () => {
  it("keeps a character's voice stable after reconnect", () => {
    const first = assignVoices(sceneCharacters, [], supportedVoices);
    const second = assignVoices(sceneCharacters, first, supportedVoices);

    expect(second).toEqual(first);
  });

  it("maximizes distinct voices within the scene when enough voices are available", () => {
    const result = assignVoices(sceneCharacters, [], supportedVoices);

    expect(new Set(result.map(({ voice }) => voice)).size).toBe(sceneCharacters.length);
  });

  it("routes only the four roles with the most dialogue through realtime", () => {
    const fiveCharacters = [
      ...sceneCharacters,
      { playId: "play-1", characterId: "char_drew", dialogueCount: 3 },
      { playId: "play-1", characterId: "char_erin", dialogueCount: 1 },
    ];

    const result = assignVoices(fiveCharacters, [], supportedVoices);

    expect(result.filter(({ engine }) => engine === "realtime").map(({ characterId }) => characterId))
      .toEqual(["char_alex", "char_bea", "char_cleo", "char_drew"]);
    expect(result.filter(({ engine }) => engine === "tts").map(({ characterId }) => characterId))
      .toEqual(["char_erin"]);
  });

  it("uses a supported user override for a newly assigned rehearsal", () => {
    const result = assignVoices([{ ...sceneCharacters[0]!, preferredVoice: "marin" }], [], supportedVoices);

    expect(result[0]).toMatchObject({ characterId: "char_alex", voice: "marin" });
  });

  it("rejects a voice override outside the supported list", () => {
    expect(() => assignVoices([{ ...sceneCharacters[0]!, preferredVoice: "invented" }], [], supportedVoices))
      .toThrow("Unsupported voice override: invented");
  });
});

describe("character performance direction", () => {
  it("grounds concise direction while forbidding invented or paraphrased dialogue", () => {
    const direction = buildCharacterDirection({
      relationship: "Bea distrusts Alex but needs Alex's help.",
      immediateObjective: "Keep Alex in the room.",
      tactic: "Mask urgency with dry humor.",
      interpretation: "The apparent confidence conceals fear.",
    });

    expect(direction).toContain("Relationship: Bea distrusts Alex");
    expect(direction).toContain("Objective: Keep Alex in the room.");
    expect(direction).toContain("Tactic: Mask urgency with dry humor.");
    expect(direction).toContain("Interpretation: The apparent confidence conceals fear.");
    expect(direction).toContain("Use only the exact supplied script text; never invent or paraphrase dialogue.");
    expect(direction.length).toBeLessThanOrEqual(300);
  });
});
