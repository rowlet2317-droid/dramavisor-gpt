import { validateCoachingReport, type CoachingReport } from "@drama/domain/coaching";
import { z } from "zod";

import type { Coach, CoachingSynthesisRequest } from "./port";

type OpenAiCoachOptions = {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
  model?: string;
};

const EvidenceReferenceSchema = z.object({
  text: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)),
}).strict();

const ProposedRatingSchema = z.object({
  category: z.enum(["clarity", "pacing", "vocal_variation"]),
  score: z.number().min(0).max(100).nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  evidenceIds: z.array(z.string().min(1)),
}).strict();

const CoachingSynthesisSchema = z.object({
  ratings: z.array(ProposedRatingSchema).length(3),
  strengths: z.array(EvidenceReferenceSchema),
  priorities: z.array(EvidenceReferenceSchema).max(3),
  exercise: z.object({
    title: z.string().min(1),
    instructions: z.string().min(1),
    targetCategory: z.enum(["line_accuracy", "clarity", "pacing", "cue_responsiveness",
      "vocal_variation"]),
    evidenceIds: z.array(z.string().min(1)),
  }).strict(),
  interpretationNotes: z.array(EvidenceReferenceSchema),
}).strict();

export class OpenAiCoach implements Coach {
  private readonly fetch: typeof globalThis.fetch;
  private readonly endpoint: string;
  private readonly model: string;

  constructor(private readonly options: OpenAiCoachOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.endpoint = options.endpoint ?? "https://api.openai.com/v1/responses";
    this.model = options.model ?? "gpt-5.6";
  }

  async synthesize(request: CoachingSynthesisRequest): Promise<CoachingReport> {
    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: coachingPrompt(request),
          text: {
            format: {
              type: "json_schema",
              name: "coaching_synthesis",
              strict: true,
              schema: z.toJSONSchema(CoachingSynthesisSchema),
            },
          },
        }),
      });
    } catch (error) {
      throw new OpenAiCoachingNetworkError(error);
    }
    if (!response.ok) throw new OpenAiCoachingHttpError(response.status);

    try {
      const candidate = sanitizeSynthesis(
        CoachingSynthesisSchema.parse(JSON.parse(extractOutputText(await response.json()))),
        request.evidence,
      );
      const report: CoachingReport = {
        ...candidate,
        ratings: [
          { category: "line_accuracy", ...request.lineAccuracy },
          ...candidate.ratings,
          { category: "cue_responsiveness", score: null, confidence: "low", evidenceIds: [] },
        ],
      };
      return validateCoachingReport(report, request.evidence, {
        soloCompleteTake: request.soloCompleteTake,
      });
    } catch (error) {
      throw new InvalidCoachOutputError(error);
    }
  }
}

function sanitizeSynthesis(candidate: z.infer<typeof CoachingSynthesisSchema>,
  evidence: CoachingSynthesisRequest["evidence"]): z.infer<typeof CoachingSynthesisSchema> {
  const knownEvidenceIds = new Set(evidence.map(({ id }) => id));
  const scoreableEvidenceIds = new Set(evidence
    .filter(({ confidence }) => confidence !== "low")
    .map(({ id }) => id));
  const groundedIds = (ids: string[]) => [...new Set(ids.filter((id) => knownEvidenceIds.has(id)))];
  const scoreableIds = (ids: string[]) => [...new Set(ids.filter((id) => scoreableEvidenceIds.has(id)))];
  const groundedReferences = (references: Array<z.infer<typeof EvidenceReferenceSchema>>) => references
    .map((reference) => ({ ...reference, evidenceIds: groundedIds(reference.evidenceIds) }))
    .filter(({ evidenceIds }) => evidenceIds.length > 0);
  const ratings = (["clarity", "pacing", "vocal_variation"] as const).map((category) => {
    const proposed = candidate.ratings.find((rating) => rating.category === category);
    if (!proposed) return { category, score: null, confidence: "low" as const, evidenceIds: [] };
    const evidenceIds = scoreableIds(proposed.evidenceIds);
    if (proposed.score === null || proposed.confidence === "low" || evidenceIds.length === 0) {
      return { category, score: null, confidence: "low" as const, evidenceIds };
    }
    return { ...proposed, evidenceIds };
  });
  return {
    ...candidate,
    ratings,
    strengths: groundedReferences(candidate.strengths),
    priorities: groundedReferences(candidate.priorities),
    exercise: { ...candidate.exercise, evidenceIds: groundedIds(candidate.exercise.evidenceIds) },
    interpretationNotes: groundedReferences(candidate.interpretationNotes),
  };
}

export class OpenAiCoachingNetworkError extends Error {
  readonly code = "OPENAI_COACHING_NETWORK_FAILURE";

  constructor(cause: unknown) {
    super("OpenAI coaching request could not reach the provider", { cause });
    this.name = "OpenAiCoachingNetworkError";
  }
}

export class OpenAiCoachingHttpError extends Error {
  readonly code: string;

  constructor(status: number) {
    super(`OpenAI coaching failed with HTTP ${status}`);
    this.name = "OpenAiCoachingHttpError";
    this.code = `OPENAI_COACHING_HTTP_${status}`;
  }
}

export class InvalidCoachOutputError extends Error {
  readonly code = "INVALID_COACHING_SYNTHESIS";

  constructor(cause: unknown) {
    super(`INVALID_COACHING_SYNTHESIS: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "InvalidCoachOutputError";
  }
}

function coachingPrompt(request: CoachingSynthesisRequest): string {
  return [
    "Create concise, playable coaching grounded only in the supplied evidence.",
    "Propose ratings only for clarity, pacing, and vocal_variation. Use null for a score unless its cited evidence is medium or high confidence.",
    "Include each proposed rating category exactly once. Cite only evidence IDs copied exactly from the supplied evidence; never invent an ID.",
    "Do not alter deterministic line accuracy. Do not score cue responsiveness.",
    "Return strengths, at most three priorities, one exercise, and interpretation notes.",
    `Scene objective: ${request.sceneObjective ?? "not provided"}`,
    `Selected interpretation: ${request.selectedInterpretation ?? "not provided"}`,
    `Exact lines: ${JSON.stringify(request.lines)}`,
    `Evidence: ${JSON.stringify(request.evidence)}`,
    `Previous comparable take: ${request.previousComparableTakeSummary ?? "not available"}`,
  ].join("\n");
}

function extractOutputText(body: unknown): string {
  if (!isRecord(body)) throw new Error("Coaching response had no structured output");
  if (body.status === "incomplete") throw new Error("Coaching response was incomplete");
  const texts: string[] = [];
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
          texts.push(part.text);
        }
      }
    }
  }
  const outputText = texts.join("");
  if (!outputText.trim()) throw new Error("Coaching response had no structured output");
  return outputText;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
