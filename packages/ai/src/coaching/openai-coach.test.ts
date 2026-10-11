import { describe, expect, it, vi } from "vitest";

import type { CoachingEvidence } from "@drama/domain/coaching";

import { OpenAiCoach } from "./openai-coach";

const evidence: CoachingEvidence[] = [
  { id: "line-accuracy", kind: "transcript_alignment", confidence: "high",
    description: "Aligned token edit distance is 90%.", startMs: null, endMs: null,
    elementIds: ["line-1"] },
  { id: "pace", kind: "deterministic_metric", confidence: "medium",
    description: "Pace is 118 words per minute.", startMs: null, endMs: null,
    elementIds: ["line-1"] },
];

const request = {
  sceneObjective: "Make Jordan stay.",
  selectedInterpretation: "The plea is disguised as a joke.",
  lines: [{ elementId: "line-1", text: "You could stay a little longer." }],
  evidence,
  lineAccuracy: { score: 90, confidence: "high" as const, evidenceIds: ["line-accuracy"] },
  previousComparableTakeSummary: "Previous line accuracy: 82.",
  soloCompleteTake: true,
};

describe("OpenAiCoach", () => {
  it("grounds GPT-5.6 synthesis and preserves deterministic ratings", async () => {
    const fetch = coachFetch(validSynthesis());

    const report = await new OpenAiCoach({ apiKey: "test-key", fetch }).synthesize(request);

    expect(report.ratings).toContainEqual({
      category: "line_accuracy", score: 90, confidence: "high", evidenceIds: ["line-accuracy"],
    });
    expect(report.ratings).toContainEqual({
      category: "cue_responsiveness", score: null, confidence: "low", evidenceIds: [],
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("gpt-5.6");
    expect(body.input).toContain(request.sceneObjective);
    expect(body.input).toContain(request.selectedInterpretation);
    expect(body.input).toContain(request.previousComparableTakeSummary);
    expect(body.input).toContain(JSON.stringify(evidence));
    expect(body.text.format.type).toBe("json_schema");
  });

  it("retains a safe code for an OpenAI HTTP failure", async () => {
    const fetch = vi.fn(async () => new Response("bad request", { status: 400 })) as unknown as typeof globalThis.fetch;

    await expect(new OpenAiCoach({ apiKey: "test-key", fetch }).synthesize(request))
      .rejects.toMatchObject({ name: "OpenAiCoachingHttpError", code: "OPENAI_COACHING_HTTP_400" });
  });

  it("retains a safe code when the OpenAI request cannot connect", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof globalThis.fetch;

    await expect(new OpenAiCoach({ apiKey: "test-key", fetch }).synthesize(request))
      .rejects.toMatchObject({
        name: "OpenAiCoachingNetworkError", code: "OPENAI_COACHING_NETWORK_FAILURE",
      });
  });

  it("downgrades a score cited only to low-confidence evidence without discarding the analysis", async () => {
    const lowEvidence = [{ ...evidence[1]!, confidence: "low" as const }];
    const synthesis = validSynthesis();
    synthesis.ratings.find(({ category }) => category === "pacing")!.evidenceIds = ["pace"];

    const report = await new OpenAiCoach({ apiKey: "test-key", fetch: coachFetch(synthesis) }).synthesize({
      ...request,
      evidence: [evidence[0]!, ...lowEvidence],
    });

    expect(report.ratings).toContainEqual({
      category: "pacing", score: null, confidence: "low", evidenceIds: [],
    });
    expect(report.strengths).toEqual([{ text: "The pace stays controlled.", evidenceIds: ["pace"] }]);
    expect(report.priorities).toEqual([{ text: "Use one deliberate pause.", evidenceIds: ["pace"] }]);
  });

  it("removes hallucinated citations while preserving grounded coaching", async () => {
    const synthesis = validSynthesis();
    synthesis.ratings.find(({ category }) => category === "pacing")!.evidenceIds = ["pace", "invented"];
    synthesis.strengths.push({ text: "An unsupported claim.", evidenceIds: ["invented"] });
    synthesis.interpretationNotes[0]!.evidenceIds = ["invented"];

    const report = await new OpenAiCoach({ apiKey: "test-key", fetch: coachFetch(synthesis) }).synthesize(request);

    expect(report.ratings).toContainEqual({
      category: "pacing", score: 80, confidence: "medium", evidenceIds: ["pace"],
    });
    expect(report.strengths).toEqual([{ text: "The pace stays controlled.", evidenceIds: ["pace"] }]);
    expect(report.interpretationNotes).toEqual([]);
  });

  it("rejects incomplete Responses output", async () => {
    const fetch = vi.fn(async () => Response.json({
      status: "incomplete",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(validSynthesis()) }] }],
    })) as unknown as typeof globalThis.fetch;

    await expect(new OpenAiCoach({ apiKey: "test-key", fetch }).synthesize(request))
      .rejects.toThrow("Coaching response was incomplete");
  });
});

function validSynthesis() {
  return {
    ratings: [
      { category: "clarity" as const, score: null, confidence: "low" as const, evidenceIds: [] },
      { category: "pacing" as const, score: 80, confidence: "medium" as const, evidenceIds: ["pace"] },
      { category: "vocal_variation" as const, score: null, confidence: "low" as const, evidenceIds: [] },
    ],
    strengths: [{ text: "The pace stays controlled.", evidenceIds: ["pace"] }],
    priorities: [{ text: "Use one deliberate pause.", evidenceIds: ["pace"] }],
    exercise: { title: "Pause ladder", instructions: "Repeat with one marked pause.",
      targetCategory: "pacing" as const, evidenceIds: ["pace"] },
    interpretationNotes: [{ text: "The restraint supports the chosen interpretation.",
      evidenceIds: ["pace"] }],
  };
}

function coachFetch(value: unknown) {
  return vi.fn(async () => Response.json({ status: "completed", output: [{ type: "message", content: [
    { type: "output_text", text: JSON.stringify(value) },
  ] }] })) as unknown as ReturnType<typeof vi.fn> & typeof globalThis.fetch;
}
