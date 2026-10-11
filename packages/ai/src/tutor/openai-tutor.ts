import { TutorResponseSchema, type ContextualTutor, type TutorRequest, type TutorResponse } from "./port";

type Options = { model: string; apiKey: string; endpoint?: string; fetch?: typeof globalThis.fetch };

export class OpenAiTutor implements ContextualTutor {
  private readonly endpoint: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly options: Options) {
    this.endpoint = options.endpoint ?? "https://api.openai.com/v1/responses";
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async answer(request: TutorRequest): Promise<TutorResponse> {
    const repair = request.validationError
      ? `\nPrevious grounding validation error: ${request.validationError}. Return corrected claims.`
      : "";
    const response = await this.fetch(this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.options.model,
        input: [
          "Answer an actor's question using only the approved Play Model, selected context, and supplied study artifacts.",
          "Every factual claim must cite existing stable element IDs. Label uncited possibilities as interpretation.",
          "If the supplied script evidence cannot answer the question, return no claims.",
          repair,
          `Question: ${request.question}`,
          `Approved Play Model: ${JSON.stringify(request.play)}`,
          `Selected context: ${JSON.stringify(request.context)}`,
          `Relevant study artifacts: ${JSON.stringify(request.artifacts)}`,
        ].join("\n\n"),
        text: { format: { type: "json_schema", name: "tutor_answer", strict: true,
          schema: { type: "object", additionalProperties: false, required: ["answer", "claims"], properties: {
            answer: { type: "string", minLength: 1 },
            claims: { type: "array", items: {
              type: "object", additionalProperties: false,
              required: ["id", "text", "epistemicStatus", "reference"],
              properties: {
                id: { type: "string", minLength: 1 }, text: { type: "string", minLength: 1 },
                epistemicStatus: { type: "string", enum: ["explicit", "interpretation"] },
                reference: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false,
                  required: ["playId", "elementIds"], properties: {
                    playId: { type: "string", minLength: 1 },
                    elementIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
                  } }],
                },
              },
            } },
          } } },
        },
      }),
    });
    if (!response.ok) throw new Error(`Tutor request failed with ${response.status}`);
    const body = await response.json();
    return TutorResponseSchema.parse(JSON.parse(extractOutputText(body)));
  }
}

function extractOutputText(body: unknown): string {
  if (!isRecord(body) || body.status === "incomplete" || !Array.isArray(body.output)) {
    throw new Error("Tutor response had no structured output");
  }
  const texts: string[] = [];
  for (const item of body.output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  if (texts.length === 0) throw new Error("Tutor response had no structured output");
  return texts.join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
