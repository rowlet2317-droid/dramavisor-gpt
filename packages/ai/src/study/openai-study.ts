import type { PlayModel } from "@drama/domain/play-model";
import { type RoleWorkbook, type StudyArtifact } from "@drama/domain/study";
import { z } from "zod";

import type { RoleWorkbookRequest, StudyGenerator, StudySectionRequest } from "./port";

type Options = { model: string; apiKey: string; endpoint?: string; fetch?: typeof globalThis.fetch };

export class OpenAiStudyGenerator implements StudyGenerator {
  private readonly fetch: typeof globalThis.fetch;
  private readonly endpoint: string;

  constructor(private readonly options: Options) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.endpoint = options.endpoint ?? "https://api.openai.com/v1/responses";
  }

  async generateStudySection(request: StudySectionRequest): Promise<StudyArtifact> {
    const target = request.kind === "scene" ? `scene ${request.scopeId}` : request.kind;
    return this.request(
      `Generate the ${target} study section. Every explicit claim must cite stable element IDs from the Play Model. Uncited ideas must be labeled interpretation.`,
      request.play,
      studyArtifactResponseSchema(request.play),
      "study_artifact",
      request.validationError,
    );
  }

  async generateRoleWorkbook(request: RoleWorkbookRequest): Promise<RoleWorkbook> {
    return this.request(
      `Generate a complete actor role workbook for character ${request.characterId}. Director concept: ${request.directorConcept ?? "none"}. Every explicit claim must cite stable element IDs; uncited options must be labeled interpretation.`,
      request.play,
      roleWorkbookResponseSchema(request.play, request.characterId, request.directorConcept),
      "role_workbook",
      request.validationError,
    );
  }

  private async request<T>(instruction: string, play: unknown, schema: z.ZodType<T>, name: string,
    validationError?: string): Promise<T> {
    const repair = validationError ? `\nPrevious validation error: ${validationError}. Return a corrected complete object.` : "";
    const response = await this.fetch(this.endpoint, { method: "POST", headers: {
      authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json",
    }, body: JSON.stringify({ model: this.options.model,
      input: `${instruction}${repair}\n\nApproved Play Model:\n${JSON.stringify(play)}`,
      text: { format: { type: "json_schema", name, strict: true, schema: z.toJSONSchema(schema) } },
    }) });
    if (!response.ok) throw new Error(`Analysis request failed with ${response.status}`);
    const outputText = extractOutputText(await response.json());
    return schema.parse(JSON.parse(outputText));
  }
}

function studyArtifactResponseSchema(play: PlayModel): z.ZodType<StudyArtifact> {
  // Keep the provider schema independent of script length. Embedding every
  // element ID in enums made long plays exceed provider request-rate limits;
  // the domain validation boundary still rejects invented references.
  const elementId = z.string().min(1);
  const sourcePlayId = play.id.replace(/:v\d+$/, "");
  const claim = z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    epistemicStatus: z.enum(["explicit", "interpretation"]),
    reference: z.object({
      playId: z.literal(sourcePlayId),
      elementIds: z.array(elementId).min(1),
    }).nullable(),
  });
  return z.object({
    id: z.string().min(1),
    kind: z.enum(["overview", "themes", "dramatic_structure", "characters", "relationships", "scene"]),
    scopeId: z.string().min(1).nullable(),
    claims: z.array(claim),
  });
}

function roleWorkbookResponseSchema(
  play: PlayModel, characterId: string, directorConcept: string | null,
): z.ZodType<RoleWorkbook> {
  const stageDirectionIds = play.acts.flatMap((act) => (
    act.scenes.flatMap((scene) => scene.elements
      .filter((element) => element.kind === "stage_direction").map((element) => element.id))
  ));
  const elementId = z.string().min(1);
  const stageDirectionElementId = z.string().min(1);
  const sourcePlayId = play.id.replace(/:v\d+$/, "");
  const claim = z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    epistemicStatus: z.enum(["explicit", "interpretation"]),
    reference: z.object({
      playId: z.literal(sourcePlayId),
      elementIds: z.array(elementId).min(1),
    }).nullable(),
  });
  const stageDirectionClaim = z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    epistemicStatus: z.enum(["explicit", "interpretation"]),
    reference: z.object({
      playId: z.literal(sourcePlayId),
      elementIds: z.array(stageDirectionElementId).min(1),
    }),
  });
  const claims = z.array(claim);
  return z.object({
    id: z.string().min(1),
    characterId: z.literal(characterId),
    directorConcept: z.literal(directorConcept),
    circumstances: claims,
    relationships: claims,
    superObjectiveOptions: claims,
    sceneObjectives: claims,
    obstacles: claims,
    stakes: claims,
    tactics: claims,
    entranceExitStates: claims,
    beats: claims,
    subtextOptions: claims,
    referencedStageDirections: stageDirectionIds.length
      ? z.array(stageDirectionClaim)
      : z.array(claim).max(0),
  });
}

function extractOutputText(body: unknown): string {
  if (!isRecord(body)) throw new Error("Analysis response had no structured output");
  if (body.status === "incomplete") throw new Error("Analysis response was incomplete");
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
  if (!outputText.trim()) throw new Error("Analysis response had no structured output");
  return outputText;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
