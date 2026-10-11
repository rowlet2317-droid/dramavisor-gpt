import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import type { ParseProposal } from "@drama/domain/parse-review";
import type { ExtractedScript } from "@drama/media/scripts/extract";

import { loadAiConfig } from "../config";
import { ModelSchemaFailure, OpenAiPlayParser } from "./openai-parser";

const extracted: ExtractedScript = {
  titleHint: "The First Step",
  pages: [
    { page: 1, text: "ACT I", extraction: "native" },
    { page: 2, text: "ALEX: We begin.", extraction: "ocr" },
  ],
  warnings: ["OCR_USED"],
};

const validProposal: ParseProposal = {
  playModel: {
    id: "ignored",
    title: "The First Step",
    language: "en",
    characters: [{ id: "alex", name: "Alex", aliases: [] }],
    acts: [{
      id: "act-1",
      ordinal: 1,
      title: "Act I",
      scenes: [{
        id: "scene-1",
        ordinal: 1,
        title: "Scene 1",
        characterIds: ["alex"],
        elements: [{
          id: "line-1",
          ordinal: 1,
          kind: "dialogue",
          characterId: "alex",
          text: "We begin.",
          sourcePage: 2,
        }],
      }],
    }],
  },
  issues: [],
};

describe("OpenAiPlayParser", () => {
  it("numbers pages, uses the configured model, and retries once with schema errors", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      { output_text: JSON.stringify({ playModel: { title: "invalid" }, issues: [] }) },
      { output_text: JSON.stringify(validProposal) },
    ];
    const parser = new OpenAiPlayParser({
      model: "analysis-model-from-env",
      apiKey: "test-key",
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json(responses.shift());
      },
    });

    await expect(parser.parse(extracted)).resolves.toEqual(validProposal);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ model: "analysis-model-from-env" });
    const providerSchema = (requests[0]!.text as { format: { schema: unknown } }).format.schema;
    expect(JSON.stringify(providerSchema)).not.toContain("\"oneOf\"");
    expect(JSON.stringify(providerSchema)).toContain("\"characterId\":");
    expect(requests[0]!.input).toEqual(expect.stringContaining("[Page 1]\nACT I"));
    expect(requests[0]!.input).toEqual(expect.stringContaining("[Page 2]\nALEX: We begin."));
    expect(JSON.stringify(requests[1])).toContain("Validation errors");
  });

  it("instructs the model how to normalize one-act and joint-speaker scripts", async () => {
    let request!: Record<string, unknown>;
    const parser = new OpenAiPlayParser({ model: "model", apiKey: "key", fetch: async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ output_text: JSON.stringify(validProposal) });
    } });

    await parser.parse({ titleHint: "riders to the sea", warnings: [], pages: [{ page: null,
      extraction: "native", text: "SCENE.\nCATHLEEN AND NORA: Uah!" }] });

    expect(request.input).toEqual(expect.stringContaining("create Act 1 and Scene 1"));
    expect(request.input).toEqual(expect.stringContaining("[Title hint: riders to the sea]"));
    expect(request.input).toEqual(expect.stringContaining("CATHLEEN AND NORA"));
    expect(request.input).toEqual(expect.stringContaining("never emit an unknown character reference"));
  });

  it("publishes a conservative review model when a one-act SCENE play fails structured output twice", async () => {
    const text = await readFile(new URL("../../../../fixtures/plays/riders-to-the-sea.txt", import.meta.url), "utf8");
    const start = text.search(/^SCENE\.\r?$/m);
    expect(start).toBeGreaterThan(0);
    const parser = new OpenAiPlayParser({ model: "model", apiKey: "key",
      fetch: async () => Response.json({ output_text: "{}" }) });

    const proposal = await parser.parse({ titleHint: "Riders to the Sea", warnings: [],
      pages: [{ page: null, extraction: "native", text: text.slice(start) }] });

    expect(proposal.playModel.title).toBe("Riders to the Sea");
    expect(proposal.playModel.acts).toHaveLength(1);
    expect(proposal.playModel.acts[0]!.scenes).toHaveLength(1);
    expect(proposal.playModel.characters.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "NORA", "CATHLEEN", "MAURYA", "BARTLEY",
    ]));
    expect(proposal.playModel.characters.map(({ name }) => name)).not.toEqual(expect.arrayContaining([
      "CATHLEEN I", "THE FULL PROJECT GUTENBERG",
    ]));
    expect(proposal.playModel.acts[0]!.scenes[0]!.elements.length).toBeGreaterThan(20);
    expect(proposal.playModel.acts[0]!.scenes[0]!.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "dialogue", text: "Where is she?" }),
    ]));
  });

  it("publishes the Riders fallback when the provider rejects both requests", async () => {
    const text = await readFile(new URL("../../../../fixtures/plays/riders-to-the-sea.txt", import.meta.url), "utf8");
    const start = text.search(/^SCENE\.\r?$/m);
    let calls = 0;
    const parser = new OpenAiPlayParser({ model: "model", apiKey: "key", fetch: async () => {
      calls += 1;
      return Response.json({ error: "request rejected" }, { status: 400 });
    } });

    const proposal = await parser.parse({ titleHint: "Riders to the Sea", warnings: [],
      pages: [{ page: null, extraction: "native", text: text.slice(start) }] });

    expect(calls).toBe(2);
    expect(proposal.playModel.title).toBe("Riders to the Sea");
    expect(proposal.playModel.acts[0]!.scenes[0]!.elements.length).toBeGreaterThan(20);
  });

  it("accepts null character IDs for non-dialogue provider elements", async () => {
    const providerOutput = JSON.parse(JSON.stringify(validProposal)) as {
      playModel: { acts: Array<{ scenes: Array<{ elements: unknown[] }> }> };
    };
    providerOutput.playModel.acts[0]!.scenes[0]!.elements.push({
      id: "heading-1",
      ordinal: 2,
      kind: "heading",
      characterId: null,
      text: "Later that day",
      sourcePage: 2,
    });
    const parser = new OpenAiPlayParser({
      model: "analysis-model-from-env",
      apiKey: "test-key",
      fetch: async () => Response.json({ output_text: JSON.stringify(providerOutput) }),
    });

    const proposal = await parser.parse(extracted);

    expect(proposal.playModel.acts[0]!.scenes[0]!.elements[1]).toMatchObject({
      id: "heading-1",
      kind: "heading",
      text: "Later that day",
    });
    expect(proposal.playModel.acts[0]!.scenes[0]!.elements[1]).not.toHaveProperty("characterId");
  });

  it("throws MODEL_SCHEMA_FAILURE after the repair response is invalid", async () => {
    const parser = new OpenAiPlayParser({
      model: "analysis-model-from-env",
      apiKey: "test-key",
      fetch: async () => Response.json({ output_text: "{}" }),
    });

    await expect(parser.parse(extracted)).rejects.toMatchObject({
      code: "MODEL_SCHEMA_FAILURE",
    } satisfies Partial<ModelSchemaFailure>);
  });

  it("retries semantic reference failures with validation feedback", async () => {
    const invalid = structuredClone(validProposal);
    const dialogue = invalid.playModel.acts[0]!.scenes[0]!.elements[0]!;
    if (dialogue.kind === "dialogue") dialogue.characterId = "missing-character";
    const requests: Array<Record<string, unknown>> = [];
    const responses = [invalid, validProposal];
    const parser = new OpenAiPlayParser({
      model: "analysis-model-from-env",
      apiKey: "test-key",
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ output_text: JSON.stringify(responses.shift()) });
      },
    });

    await expect(parser.parse(extracted)).resolves.toEqual(validProposal);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.input).toEqual(expect.stringContaining("unknown character"));
  });

  it("uses the repair attempt when output_text is missing", async () => {
    let calls = 0;
    const parser = new OpenAiPlayParser({
      model: "analysis-model-from-env",
      apiKey: "test-key",
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? Response.json({ output: [] })
          : Response.json({ output_text: JSON.stringify(validProposal) });
      },
    });

    await expect(parser.parse(extracted)).resolves.toEqual(validProposal);
    expect(calls).toBe(2);
  });

  it("reads structured output from a raw Responses API message", async () => {
    const parser = new OpenAiPlayParser({
      model: "analysis-model-from-env",
      apiKey: "test-key",
      fetch: async () => Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [
        { type: "output_text", text: JSON.stringify(validProposal) },
      ] }] }),
    });

    await expect(parser.parse(extracted)).resolves.toEqual(validProposal);
  });

  it.each([
    { status: "incomplete", output: [{ type: "message", status: "completed", content: [
      { type: "output_text", text: JSON.stringify(validProposal) },
    ] }] },
    { status: "completed", output: [{ type: "message", status: "completed", content: [
      { type: "refusal", refusal: "cannot comply" },
    ] }] },
    { status: "completed", output: [{ type: "message", status: "incomplete", content: [
      { type: "output_text", text: JSON.stringify(validProposal) },
    ] }] },
  ])("rejects non-completed raw Responses payload %#", async (payload) => {
    const parser = new OpenAiPlayParser({ model: "model", apiKey: "key",
      fetch: async () => Response.json(payload) });
    await expect(parser.parse(extracted)).rejects.toMatchObject({ code: "MODEL_SCHEMA_FAILURE" });
  });

  it("joins completed text from multiple completed message items", async () => {
    const json = JSON.stringify(validProposal);
    const parser = new OpenAiPlayParser({ model: "model", apiKey: "key", fetch: async () => Response.json({
      status: "completed", output: [
        { type: "message", status: "completed", content: [{ type: "output_text", text: json.slice(0, 50) }] },
        { type: "message", status: "completed", content: [{ type: "output_text", text: json.slice(50) }] },
      ],
    }) });
    await expect(parser.parse(extracted)).resolves.toEqual(validProposal);
  });

  it("ignores non-message output items around a completed message", async () => {
    const parser = new OpenAiPlayParser({ model: "model", apiKey: "key", fetch: async () => Response.json({
      status: "completed", output: [
        { type: "reasoning", summary: [] },
        { type: "message", status: "completed", content: [
          { type: "output_text", text: JSON.stringify(validProposal) },
        ] },
        { type: "custom_tool_call", name: "unused" },
      ],
    }) });
    await expect(parser.parse(extracted)).resolves.toEqual(validProposal);
  });

  it("reports semantic failures twice as MODEL_SCHEMA_FAILURE", async () => {
    const invalid = structuredClone(validProposal);
    invalid.playModel.acts.push({ ...structuredClone(invalid.playModel.acts[0]!), id: "act-duplicate" });
    const parser = new OpenAiPlayParser({
      model: "analysis-model-from-env",
      apiKey: "test-key",
      fetch: async () => Response.json({ output_text: JSON.stringify(invalid) }),
    });

    await expect(parser.parse(extracted)).rejects.toMatchObject({ code: "MODEL_SCHEMA_FAILURE" });
  });
});

describe("loadAiConfig", () => {
  it("requires the analysis model to come from the environment", () => {
    expect(loadAiConfig({ ANALYSIS_MODEL: "gpt-analysis-current", OPENAI_API_KEY: "secret" })).toEqual({
      analysisModel: "gpt-analysis-current",
      openAiApiKey: "secret",
    });
    expect(() => loadAiConfig({})).toThrow("ANALYSIS_MODEL is required");
  });
});
