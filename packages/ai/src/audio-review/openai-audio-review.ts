import type { CoachingEvidence } from "@drama/domain/coaching";
import { decodeWav } from "@drama/media/audio/decode-wav";
import { z } from "zod";

import type { AudioReviewer, AudioReviewRequest } from "./port";

type OpenAiAudioReviewerOptions = {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
  model?: string;
  maxAudioBytes?: number;
};

const ObservationSchema = z.object({
  startMs: z.coerce.number().finite().nonnegative().transform(Math.round),
  endMs: z.coerce.number().finite().nonnegative().transform(Math.round),
  description: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
  elementIds: z.array(z.string().min(1)).min(1),
});

const AudioReviewResponseSchema = z.object({
  observations: z.array(ObservationSchema),
});

const audioObservationTool = {
  type: "function",
  function: {
    name: "submit_audio_observations",
    description: "Submit only grounded observations from the supplied performance audio.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["observations"],
      properties: {
        observations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["startMs", "endMs", "description", "confidence", "elementIds"],
            properties: {
              startMs: { type: "integer", minimum: 0 },
              endMs: { type: "integer", minimum: 0 },
              description: { type: "string" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              elementIds: { type: "array", items: { type: "string" }, minItems: 1 },
            },
          },
        },
      },
    },
  },
} as const;

export class OpenAiAudioReviewNetworkError extends Error {
  readonly code = "OPENAI_AUDIO_REVIEW_NETWORK_FAILURE";

  constructor(cause: unknown) {
    super("OpenAI audio-review request could not reach the provider", { cause });
    this.name = "OpenAiAudioReviewNetworkError";
  }
}

export class OpenAiAudioReviewHttpError extends Error {
  readonly code: string;

  constructor(status: number) {
    super(`OpenAI audio review failed with HTTP ${status}`);
    this.name = "OpenAiAudioReviewHttpError";
    this.code = `OPENAI_AUDIO_REVIEW_HTTP_${status}`;
  }
}

export class InvalidAudioReviewOutputError extends Error {
  readonly code = "INVALID_AUDIO_REVIEW_OUTPUT";

  constructor(cause: unknown) {
    super("OpenAI audio review returned invalid structured output", { cause });
    this.name = "InvalidAudioReviewOutputError";
  }
}

export class OpenAiAudioReviewer implements AudioReviewer {
  private readonly fetch: typeof globalThis.fetch;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly maxAudioBytes: number;

  constructor(private readonly options: OpenAiAudioReviewerOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.endpoint = options.endpoint ?? "https://api.openai.com/v1/chat/completions";
    this.model = options.model ?? "gpt-audio-1.5";
    this.maxAudioBytes = options.maxAudioBytes ?? 20 * 1024 * 1024;
  }

  async review(request: AudioReviewRequest): Promise<CoachingEvidence[]> {
    if (request.audio.byteLength > this.maxAudioBytes) {
      throw new Error("AUDIO_REVIEW_INPUT_TOO_LARGE");
    }
    if (!Number.isInteger(request.durationMs) || request.durationMs < 0) {
      throw new Error("INVALID_AUDIO_DURATION");
    }

    const chunks = chunkAudioReviewRequest(request);
    const observations: CoachingEvidence[] = [];
    let firstInvalidOutput: InvalidAudioReviewOutputError | null = null;
    let completedChunks = 0;
    for (const chunk of chunks) {
      let reviewed: CoachingEvidence[] | null = null;
      for (let attempt = 0; attempt < 2 && reviewed === null; attempt += 1) {
        try {
          reviewed = await this.reviewChunk(chunk.request);
        } catch (error) {
          if (!(error instanceof InvalidAudioReviewOutputError)) throw error;
          firstInvalidOutput ??= error;
        }
      }
      if (reviewed === null) continue;
      completedChunks += 1;
      const firstIndex = observations.length;
      observations.push(...reviewed.map((observation, index) => ({ ...observation,
        id: `audio-${firstIndex + index + 1}`,
        startMs: observation.startMs! + chunk.offsetMs,
        endMs: observation.endMs! + chunk.offsetMs,
      })));
    }
    if (completedChunks === 0 && firstInvalidOutput) throw firstInvalidOutput;
    return observations;
  }

  private async reviewChunk(request: AudioReviewRequest): Promise<CoachingEvidence[]> {
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
          messages: [{
            role: "user",
            content: [
              { type: "text", text: audioReviewPrompt(request) },
              {
                type: "input_audio",
                input_audio: { data: Buffer.from(request.audio).toString("base64"), format: "wav" },
              },
            ],
          }],
          modalities: ["text"],
          tools: [audioObservationTool],
          tool_choice: { type: "function", function: { name: "submit_audio_observations" } },
          parallel_tool_calls: false,
        }),
      });
    } catch (error) {
      throw new OpenAiAudioReviewNetworkError(error);
    }
    if (!response.ok) throw new OpenAiAudioReviewHttpError(response.status);

    let parsed: z.infer<typeof AudioReviewResponseSchema>;
    try {
      parsed = AudioReviewResponseSchema.parse(normalizeAudioReviewResponse(
        extractMessageContent(await response.json()),
      ));
    } catch (error) {
      throw new InvalidAudioReviewOutputError(error);
    }
    const grounded = groundObservationTimes(parsed.observations, request);
    validateObservations(grounded, request);
    return grounded.map((observation, index) => ({
      ...observation,
      id: `audio-${index + 1}`,
      kind: "audio_observation" as const,
    }));
  }
}

function groundObservationTimes(observations: z.infer<typeof ObservationSchema>[], request: AudioReviewRequest) {
  return observations.map((observation) => {
    const citedLines = request.lines.filter((line) => observation.elementIds.includes(line.elementId)
      && typeof line.startMs === "number" && typeof line.endMs === "number");
    if (citedLines.length === 0) return observation;
    return { ...observation,
      startMs: Math.max(0, Math.min(request.durationMs, Math.min(...citedLines.map(({ startMs }) => startMs!)))),
      endMs: Math.max(0, Math.min(request.durationMs, Math.max(...citedLines.map(({ endMs }) => endMs!)))) };
  });
}

const MAX_REVIEW_CHUNK_MS = 25_000;
const REVIEW_PADDING_MS = 500;

export function chunkAudioReviewRequest(request: AudioReviewRequest): Array<{
  offsetMs: number;
  request: AudioReviewRequest;
}> {
  const timedLines = request.lines.filter((line): line is typeof line & { startMs: number; endMs: number } =>
    typeof line.startMs === "number" && typeof line.endMs === "number" && line.startMs <= line.endMs)
    .sort((left, right) => left.startMs - right.startMs);
  if (request.durationMs <= MAX_REVIEW_CHUNK_MS || timedLines.length === 0) {
    return [{ offsetMs: 0, request }];
  }

  const decoded = decodeWav(request.audio);
  const audioDurationMs = Math.round(decoded.samples.length / decoded.sampleRate * 1_000);
  const boundedLines = timedLines.map((line) => ({ ...line,
    startMs: Math.max(0, Math.min(audioDurationMs, line.startMs)),
    endMs: Math.max(0, Math.min(audioDurationMs, line.endMs)),
  })).filter(({ startMs, endMs }) => startMs < endMs);
  if (boundedLines.length === 0) return [{ offsetMs: 0, request: { ...request, durationMs: audioDurationMs } }];

  const groups: typeof boundedLines[] = [];
  let group: typeof timedLines = [];
  for (const line of boundedLines) {
    if (group.length > 0 && line.endMs - group[0]!.startMs > MAX_REVIEW_CHUNK_MS) {
      groups.push(group);
      group = [];
    }
    group.push(line);
  }
  if (group.length > 0) groups.push(group);

  return groups.map((lines) => {
    const offsetMs = Math.max(0, lines[0]!.startMs - REVIEW_PADDING_MS);
    const endMs = Math.min(audioDurationMs, lines.at(-1)!.endMs + REVIEW_PADDING_MS);
    return { offsetMs, request: { ...request,
      audio: encodeWavSlice(decoded.samples, decoded.sampleRate, offsetMs, endMs),
      durationMs: endMs - offsetMs,
      lines: lines.map((line) => ({ ...line, startMs: line.startMs - offsetMs, endMs: line.endMs - offsetMs })),
    } };
  });
}

function encodeWavSlice(samples: Float32Array, sampleRate: number, startMs: number, endMs: number): Uint8Array {
  const start = Math.max(0, Math.floor(startMs * sampleRate / 1_000));
  const end = Math.min(samples.length, Math.ceil(endMs * sampleRate / 1_000));
  const bytes = new Uint8Array(44 + (end - start) * 2);
  const view = new DataView(bytes.buffer);
  bytes.set([82, 73, 70, 70], 0); view.setUint32(4, bytes.length - 8, true); bytes.set([87, 65, 86, 69], 8);
  bytes.set([102, 109, 116, 32], 12); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); bytes.set([100, 97, 116, 97], 36);
  view.setUint32(40, (end - start) * 2, true);
  for (let index = start; index < end; index += 1) {
    view.setInt16(44 + (index - start) * 2, Math.round(Math.max(-1, Math.min(1, samples[index]!)) * 32_767), true);
  }
  return bytes;
}

function audioReviewPrompt(request: AudioReviewRequest): string {
  const lines = request.lines.map(({ elementId, text, startMs, endMs }) =>
    `${elementId} [${startMs ?? "?"}-${endMs ?? "?"} ms]: ${text}`).join("\n");
  return [
    "Describe only directly observable vocal events in this bounded audio take.",
    "Call submit_audio_observations exactly once with only grounded observations.",
    "Return start/end milliseconds, an observable description, confidence, and related element IDs. Use whole-number milliseconds.",
    "Do not assign a global acting-quality score or infer the actor's internal state.",
    `Audio duration: ${request.durationMs} ms`,
    `Scene objective: ${request.sceneObjective ?? "not provided"}`,
    `Selected interpretation: ${request.selectedInterpretation ?? "not provided"}`,
    `Exact scene lines:\n${lines}`,
  ].join("\n");
}

function validateObservations(
  observations: z.infer<typeof ObservationSchema>[],
  request: AudioReviewRequest,
): void {
  const elementIds = new Set(request.lines.map(({ elementId }) => elementId));
  for (const observation of observations) {
    if (observation.startMs > observation.endMs || observation.endMs > request.durationMs) {
      throw new Error("OBSERVATION_OUT_OF_BOUNDS");
    }
    if (observation.elementIds.some((elementId) => !elementIds.has(elementId))) {
      throw new Error("UNKNOWN_OBSERVATION_ELEMENT");
    }
  }
}

function extractMessageContent(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.choices)) {
    throw new Error("Audio review response had no structured output");
  }
  const first = body.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new Error("Audio review response had no structured output");
  }
  const calls = first.message.tool_calls;
  if (Array.isArray(calls)) {
    const call = calls.find((candidate) => isRecord(candidate) && candidate.type === "function"
      && isRecord(candidate.function) && candidate.function.name === "submit_audio_observations");
    if (call && isRecord(call.function) && call.function.arguments !== undefined) {
      return call.function.arguments;
    }
  }
  if (typeof first.message.content === "string" && first.message.content.trim()) {
    return first.message.content;
  }
  if (Array.isArray(first.message.content)) {
    const texts = first.message.content.flatMap((part) => isRecord(part)
      && (part.type === "text" || part.type === "output_text") && typeof part.text === "string"
      ? [part.text] : []);
    if (texts.length > 0) return texts.join("");
  }
  throw new Error("Audio review response had no structured output");
}

function parseJsonResponse(content: string): unknown {
  const fenced = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/iu.exec(content);
  return JSON.parse(fenced?.[1] ?? content);
}

export function normalizeAudioReviewResponse(value: unknown): unknown {
  const parsed = typeof value === "string" ? parseJsonResponse(value) : value;
  const rawObservations = Array.isArray(parsed) ? parsed : isRecord(parsed)
    ? parsed.observations ?? parsed.audioObservations ?? parsed.audio_observations : undefined;
  if (!Array.isArray(rawObservations)) return parsed;
  return { observations: rawObservations.map((value) => {
    if (!isRecord(value)) return value;
    return {
      startMs: timestamp(value, "startMs", "start_ms", "start", "startSeconds", "start_seconds"),
      endMs: timestamp(value, "endMs", "end_ms", "end", "endSeconds", "end_seconds"),
      description: value.description ?? value.observation ?? value.text,
      confidence: typeof value.confidence === "string" ? value.confidence.toLowerCase() : value.confidence,
      elementIds: value.elementIds ?? value.element_ids ?? value.lineIds ?? value.line_ids
        ?? (typeof value.elementId === "string" ? [value.elementId] : undefined),
    };
  }) };
}

function timestamp(value: Record<string, unknown>, ...keys: string[]): unknown {
  const key = keys.find((candidate) => value[candidate] !== undefined);
  if (!key) return undefined;
  const raw = value[key];
  if ((key === "startSeconds" || key === "start_seconds" || key === "endSeconds" || key === "end_seconds")
    && (typeof raw === "number" || typeof raw === "string" && raw.trim() !== "")) {
    return Number(raw) * 1_000;
  }
  if (typeof raw === "string") {
    const seconds = /^([0-9]+(?:\.[0-9]+)?)\s*s(?:ec(?:onds?)?)?$/iu.exec(raw.trim());
    if (seconds) return Number(seconds[1]) * 1_000;
  }
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
