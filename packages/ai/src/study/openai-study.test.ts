import { describe, expect, it, vi } from "vitest";

import type { PlayModel } from "@drama/domain/play-model";
import type { RoleWorkbook, StudyArtifact } from "@drama/domain/study";

import { OpenAiStudyGenerator } from "./openai-study";

const playId = "11111111-1111-4111-8111-111111111111";
const characterId = `${playId}:v2:character:1`;
const dialogueId = `${playId}:v2:element:1`;
const directionId = `${playId}:v2:element:2`;
const play: PlayModel = {
  id: `${playId}:v2`,
  title: "The First Step",
  language: "en",
  characters: [{ id: characterId, name: "Alex", aliases: [] }],
  acts: [{
    id: `${playId}:v2:act:1`, ordinal: 1, title: "Act I",
    scenes: [{
      id: `${playId}:v2:act:1:scene:1`, ordinal: 1, title: "Scene 1", characterIds: [characterId],
      elements: [
        { id: dialogueId, ordinal: 1, kind: "dialogue", characterId, text: "We begin.", sourcePage: 1 },
        { id: directionId, ordinal: 2, kind: "stage_direction", text: "[Alex crosses.]", sourcePage: 1 },
      ],
    }],
  }],
};

describe("OpenAiStudyGenerator raw Responses output", () => {
  it("finds a study artifact after a non-message output item", async () => {
    const artifact: StudyArtifact = {
      id: "overview-1", kind: "overview", scopeId: null,
      claims: [{ id: "claim-1", text: "Alex begins.", epistemicStatus: "explicit",
        reference: { playId, elementIds: [dialogueId] } }],
    };
    const fetch = rawResponsesFetch(artifact);

    const result = await generator(fetch).generateStudySection({ play, kind: "overview", scopeId: null });

    expect(result).toEqual(artifact);
  });

  it("keeps the study provider schema compact for long approved plays", async () => {
    const artifact: StudyArtifact = {
      id: "overview-1", kind: "overview", scopeId: null,
      claims: [{ id: "claim-1", text: "Alex begins.", epistemicStatus: "explicit",
        reference: { playId, elementIds: [dialogueId] } }],
    };
    const requests: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(artifact) }] }],
      });
    }) as typeof globalThis.fetch;

    await generator(fetch).generateStudySection({ play, kind: "overview", scopeId: null });

    const schema = (requests[0]!.text as { format: { schema: unknown } }).format.schema;
    expect(JSON.stringify(schema)).not.toContain(`"enum":["${dialogueId}","${directionId}"]`);
    expect(JSON.stringify(schema)).toContain(`"const":"${playId}"`);
  });

  it("uses the same raw output parser for a role workbook", async () => {
    const explicit = (id: string) => ({ id, text: "Alex begins.", epistemicStatus: "explicit" as const,
      reference: { playId, elementIds: [dialogueId] } });
    const workbook: RoleWorkbook = {
      id: "role-1", characterId, directorConcept: null,
      circumstances: [explicit("circumstance")], relationships: [explicit("relationship")],
      superObjectiveOptions: [explicit("super-objective")], sceneObjectives: [explicit("scene-objective")],
      obstacles: [explicit("obstacle")], stakes: [explicit("stakes")], tactics: [explicit("tactic")],
      entranceExitStates: [explicit("state")], beats: [explicit("beat")],
      subtextOptions: [explicit("subtext")], referencedStageDirections: [{ ...explicit("direction"),
        reference: { playId, elementIds: [directionId] } }],
    };
    const fetch = rawResponsesFetch(workbook);

    const result = await generator(fetch).generateRoleWorkbook({ play, characterId, directorConcept: null });

    expect(result).toEqual(workbook);
  });


  it("restricts the requested character without expanding every script ID into the provider schema", async () => {
    const explicit = (id: string) => ({ id, text: "Alex begins.", epistemicStatus: "explicit" as const,
      reference: { playId, elementIds: [dialogueId] } });
    const workbook: RoleWorkbook = {
      id: "role-1", characterId, directorConcept: null,
      circumstances: [explicit("circumstance")], relationships: [explicit("relationship")],
      superObjectiveOptions: [explicit("super-objective")], sceneObjectives: [explicit("scene-objective")],
      obstacles: [explicit("obstacle")], stakes: [explicit("stakes")], tactics: [explicit("tactic")],
      entranceExitStates: [explicit("state")], beats: [explicit("beat")], subtextOptions: [explicit("subtext")],
      referencedStageDirections: [{ ...explicit("direction"), reference: { playId, elementIds: [directionId] } }],
    };
    const requests: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(workbook) }] }],
      });
    }) as typeof globalThis.fetch;

    await generator(fetch).generateRoleWorkbook({ play, characterId, directorConcept: null });

    const schema = JSON.stringify((requests[0]!.text as { format: { schema: unknown } }).format.schema);
    expect(schema).toContain(`"const":"${characterId}"`);
    expect(schema).not.toContain(`"enum":["${dialogueId}","${directionId}"]`);
    expect(schema).not.toContain(`"enum":["${directionId}"]`);
    expect(schema.length).toBeLessThan(10_000);
  });

  it("rejects an incomplete response even when it contains partial output text", async () => {
    const artifact: StudyArtifact = {
      id: "overview-1", kind: "overview", scopeId: null, claims: [],
    };
    const fetch = vi.fn(async () => Response.json({
      id: "resp_incomplete", status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ id: "message_partial", type: "message", role: "assistant", status: "incomplete",
        content: [{ type: "output_text", text: JSON.stringify(artifact), annotations: [] }] }],
    })) as typeof globalThis.fetch;

    await expect(generator(fetch).generateStudySection({ play, kind: "overview", scopeId: null }))
      .rejects.toThrow("Analysis response was incomplete");
  });
});

function generator(fetch: typeof globalThis.fetch) {
  return new OpenAiStudyGenerator({ model: "gpt-test", apiKey: "test-key", fetch });
}

function rawResponsesFetch(value: unknown): typeof globalThis.fetch {
  return vi.fn(async () => Response.json({
    id: "resp_test",
    status: "completed",
    output: [
      { id: "reasoning_test", type: "reasoning", summary: [] },
      { id: "message_test", type: "message", role: "assistant", status: "completed", content: [
        { type: "refusal", refusal: "" },
        { type: "output_text", text: JSON.stringify(value), annotations: [] },
      ] },
    ],
  })) as typeof globalThis.fetch;
}
