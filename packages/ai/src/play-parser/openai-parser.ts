import { OpenAiParseProposalSchema, type ParseProposal, validateParseProposal } from "@drama/domain/parse-review";
import type { ExtractedScript } from "@drama/media/scripts/extract";
import { z } from "zod";

import type { PlayParser } from "./port";

type OpenAiPlayParserOptions = {
  model: string;
  apiKey: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
};

export class ModelSchemaFailure extends Error {
  readonly code = "MODEL_SCHEMA_FAILURE";

  constructor(message: string) {
    super(message);
    this.name = "ModelSchemaFailure";
  }
}

export class PlayParseProviderFailure extends Error {
  readonly code = "PLAY_PARSE_PROVIDER_FAILURE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlayParseProviderFailure";
  }
}

export class OpenAiPlayParser implements PlayParser {
  private readonly fetch: typeof globalThis.fetch;
  private readonly endpoint: string;

  constructor(private readonly options: OpenAiPlayParserOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.endpoint = options.endpoint ?? "https://api.openai.com/v1/responses";
  }

  async parse(extracted: ExtractedScript): Promise<ParseProposal> {
    const pages = extracted.pages
      .map((page, index) => `[Page ${page.page ?? index + 1}]\n${page.text}`)
      .join("\n\n");
    const source = `${extracted.titleHint ? `[Title hint: ${extracted.titleHint}]\n\n` : ""}${pages}`;
    let validationErrors: string | undefined;
    let providerFailure: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let raw: unknown;
      try {
        raw = await this.request(source, validationErrors);
      } catch (error) {
        providerFailure = error;
        continue;
      }
      try {
        return validateParseProposal(raw);
      } catch (error) {
        validationErrors = error instanceof z.ZodError ? z.prettifyError(error) : String(error);
      }
    }

    const oneActFallback = conservativeOneActProposal(extracted);
    if (oneActFallback) return validateParseProposal(oneActFallback);

    if (providerFailure) {
      throw new PlayParseProviderFailure("Play analysis provider failed", { cause: providerFailure });
    }

    throw new ModelSchemaFailure(`Model returned invalid structured data twice. ${validationErrors ?? ""}`.trim());
  }

  private async request(source: string, validationErrors?: string): Promise<unknown> {
    const repair = validationErrors
      ? `\n\nValidation errors from the previous response:\n${validationErrors}\nReturn a corrected complete object.`
      : "";
    const response = await this.fetch(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        input: `Parse this English stage play into acts, scenes, characters, and ordered elements. Preserve source page numbers. IDs are temporary reference tokens and will be replaced locally.

Structural rules:
- If the play has a SCENE heading but no ACT heading, create Act 1 and Scene 1; do not reject a one-act play.
- Treat Roman-numeral and word-number headings (for example, Scene I or First Act) as structural headings.
- Every dialogue characterId and every scene characterId must exactly match an ID in playModel.characters.
- When a speech label names a group or joint speakers (for example, "CATHLEEN AND NORA"), create a matching collective character or represent the line as a stage direction; never emit an unknown character reference.
- Keep all IDs globally unique, keep ordinals positive and ordered, and reference only existing element IDs in issues.
- Use the supplied title hint or script title for playModel.title rather than a generic SCENE heading.

${source}${repair}`,
        text: {
          format: {
            type: "json_schema",
            name: "parse_proposal",
            strict: true,
            schema: z.toJSONSchema(OpenAiParseProposalSchema),
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`Analysis request failed with ${response.status}`);
    const body = await response.json();
    const outputText = extractOutputText(body);
    if (!outputText) return undefined;
    try {
      return JSON.parse(outputText) as unknown;
    } catch {
      return outputText;
    }
  }
}

function conservativeOneActProposal(extracted: ExtractedScript): ParseProposal | null {
  const source = extracted.pages.map((page) => page.text).join("\n");
  // The fallback can also be called directly with an unprepared public-domain
  // file, so do not let a publisher license become dialogue and characters.
  const text = source.split(/^\s*\**\s*end of (?:this\s+|the\s+)?project gutenberg\b/im, 1)[0]!;
  if (!/^\s*scene\s*[.:—-]?\s*$/im.test(text) || /^\s*act\s+(?:\d+|[ivxlcdm]+)\b/im.test(text)) return null;
  const speeches = conservativeSpeeches(text);
  const speakers = [...new Set(speeches.map(({ name }) => name))];
  if (speakers.length === 0) return null;
  const characters = speakers.map((name, index) => ({ id: `character-${index + 1}`, name, aliases: [] }));
  const characterIds = new Map(characters.map(({ id, name }) => [name, id]));
  const elements = speeches.map(({ name, text }, index) => ({ id: `element-${index + 1}`, ordinal: index + 1,
    kind: "dialogue" as const, characterId: characterIds.get(name)!, text, sourcePage: null }));
  if (elements.length === 0) return null;
  return { playModel: { id: "play", title: extracted.titleHint ?? "Untitled play", language: "en", characters,
    acts: [{ id: "act-1", ordinal: 1, title: "Act 1", scenes: [{ id: "scene-1", ordinal: 1,
      title: "Scene 1", characterIds: characters.map(({ id }) => id), elements }] }] }, issues: [] };
}

function conservativeSpeeches(text: string): Array<{ name: string; text: string }> {
  const speeches: Array<{ name: string; text: string }> = [];
  const label = /^([A-Z][A-Z .'-]{1,48}?)(?:\s+\[[^\]]*\])?\s*$/;
  const directed = /^([A-Z][A-Z .'-]{1,48})\s+\[[^\]]*\]\s*(.*)$/;
  const colon = /^([A-Z][A-Z .'-]{1,48})\s*:\s*(\S.*)$/;
  const inline = /^([A-Z][A-Z .'-]{1,48})\s+((?:[A-Z][a-z]|I(?:\b|'))\S*.*)$/;
  let pendingSpeaker: string | undefined;

  for (const block of text.split(/(?:\r?\n){2,}/)) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const joined = lines.join(" ");
    const inlineMatch = directed.exec(joined) ?? colon.exec(joined) ?? inline.exec(joined);
    if (inlineMatch) {
      const name = normalizeSpeaker(inlineMatch[1]!);
      const dialogue = inlineMatch[2]!.trim();
      if (dialogue && !dialogue.startsWith("[")) speeches.push({ name, text: dialogue });
      pendingSpeaker = name;
      continue;
    }
    const labelMatch = label.exec(lines[0]!);
    if (labelMatch) {
      pendingSpeaker = normalizeSpeaker(labelMatch[1]!);
      if (/^(?:SCENE|ACT)(?:\s|$)/.test(pendingSpeaker)) {
        pendingSpeaker = undefined;
        continue;
      }
      const dialogue = lines.slice(1).join(" ").trim();
      if (dialogue && !dialogue.startsWith("[")) speeches.push({ name: pendingSpeaker, text: dialogue });
      continue;
    }
    if (pendingSpeaker && !joined.startsWith("[") && !/^SCENE\b/i.test(joined)) {
      speeches.push({ name: pendingSpeaker, text: joined });
    }
  }
  return speeches;
}

function normalizeSpeaker(name: string): string {
  return name.trim().replace(/[.]$/, "");
}

function extractOutputText(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = body as { status?: unknown; output_text?: unknown; output?: unknown };
  if (value.status !== undefined && value.status !== "completed") return undefined;
  if (typeof value.output_text === "string") return value.output_text;
  if (!Array.isArray(value.output)) return undefined;
  const texts: string[] = [];
  for (const item of value.output) {
    if (!item || typeof item !== "object") continue;
    const message = item as { type?: unknown; status?: unknown; content?: unknown };
    if (message.type !== "message") continue;
    if (message.status !== "completed" || !Array.isArray(message.content)) return undefined;
    for (const part of message.content) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "refusal") return undefined;
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "output_text"
        && typeof (part as { text?: unknown }).text === "string") {
        texts.push((part as { text: string }).text);
      }
    }
  }
  return texts.length ? texts.join("") : undefined;
}
