import { describe, expect, it } from "vitest";

import { OpenAiTutor } from "./openai-tutor";

const request = {
  question: "What happens?",
  play: { id: "play-1:v1", title: "Play", language: "en" as const, characters: [], acts: [] },
  context: { scene: null, character: null, elements: [] },
  artifacts: [],
};
const answer = { answer: "The door opens.", claims: [{ id: "c1", text: "The door opens.",
  epistemicStatus: "explicit" as const, reference: { playId: "play-1", elementIds: ["line-1"] } }] };

describe("OpenAiTutor", () => {
  it("joins nested output_text while ignoring non-message and non-text response items", async () => {
    const serialized = JSON.stringify(answer);
    const tutor = new OpenAiTutor({ model: "tutor-model", apiKey: "secret", fetch: async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "tutor-model" });
      return Response.json({ output: [
        { type: "reasoning", content: [] },
        { type: "message", content: [{ type: "refusal", refusal: "ignored" },
          { type: "output_text", text: serialized.slice(0, 20) }] },
        { type: "message", content: [{ type: "output_text", text: serialized.slice(20) }] },
      ] });
    } });

    await expect(tutor.answer(request)).resolves.toEqual(answer);
  });

  it("rejects an incomplete response", async () => {
    const tutor = new OpenAiTutor({ model: "tutor-model", apiKey: "secret",
      fetch: async () => Response.json({ status: "incomplete", output: [] }) });

    await expect(tutor.answer(request)).rejects.toThrow("Tutor response had no structured output");
  });

  it("rejects malformed JSON output", async () => {
    const tutor = new OpenAiTutor({ model: "tutor-model", apiKey: "secret", fetch: async () => Response.json({
      output: [{ type: "message", content: [{ type: "output_text", text: "{not-json" }] }],
    }) });

    await expect(tutor.answer(request)).rejects.toBeInstanceOf(SyntaxError);
  });
});
