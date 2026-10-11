import { describe, expect, it } from "vitest";
import { PlayModelSchema } from "./play-model";

describe("PlayModelSchema", () => {
  it("accepts ordered, stably identified stage-play elements", () => {
    const play = PlayModelSchema.parse({
      id: "play_1",
      title: "The Test Play",
      language: "en",
      acts: [{
        id: "act_1", ordinal: 1, title: "Act I", scenes: [{
          id: "scene_1", ordinal: 1, title: "Scene 1",
          characterIds: ["char_alex"],
          elements: [{
            id: "line_0001", ordinal: 1, kind: "dialogue",
            characterId: "char_alex", text: "We begin.", sourcePage: 1,
          }],
        }],
      }],
      characters: [{ id: "char_alex", name: "ALEX", aliases: [] }],
    });
    expect(play.acts[0].scenes[0].elements[0].id).toBe("line_0001");
  });
});
