import { z } from "zod";

import { CharacterSchema, PlayModelSchema, type PlayModel, type ScriptElement } from "./play-model";

export const ParseIssueSchema = z.object({
  id: z.string(),
  kind: z.enum(["character_name", "dialogue_owner", "scene_boundary", "unreadable_text"]),
  elementIds: z.array(z.string()),
  message: z.string().min(1),
});

export const ParseProposalSchema = z.object({
  playModel: PlayModelSchema,
  issues: z.array(ParseIssueSchema),
});

// Responses API strict schemas do not permit a nested `oneOf`. ScriptElementSchema
// is a discriminated union, so the provider-facing form represents every element
// with the same required fields and uses null for non-dialogue characterId values.
// ParseProposalSchema remains the canonical local validation boundary.
const OpenAiScriptElementSchema = z.object({
  id: z.string(),
  ordinal: z.number().int().positive(),
  kind: z.enum(["dialogue", "stage_direction", "heading"]),
  characterId: z.string().nullable(),
  text: z.string().min(1),
  sourcePage: z.number().int().positive().nullable(),
});

const OpenAiSceneSchema = z.object({
  id: z.string(),
  ordinal: z.number().int().positive(),
  title: z.string(),
  characterIds: z.array(z.string()),
  elements: z.array(OpenAiScriptElementSchema),
});

const OpenAiActSchema = z.object({
  id: z.string(),
  ordinal: z.number().int().positive(),
  title: z.string(),
  scenes: z.array(OpenAiSceneSchema),
});

export const OpenAiParseProposalSchema = z.object({
  playModel: z.object({
    id: z.string(),
    title: z.string().min(1),
    language: z.literal("en"),
    acts: z.array(OpenAiActSchema),
    characters: z.array(CharacterSchema),
  }),
  issues: z.array(ParseIssueSchema),
});

export type ParseIssue = z.infer<typeof ParseIssueSchema>;
export type ParseProposal = z.infer<typeof ParseProposalSchema>;

export function validateParseProposal(input: unknown): ParseProposal {
  const proposal = ParseProposalSchema.parse(input);
  const providerIds = new Set<string>();
  const characterIds = new Set<string>();
  const elementIds = new Set<string>();
  const actOrdinals = new Set<number>();

  addProviderId(providerIds, proposal.playModel.id);
  for (const character of proposal.playModel.characters) {
    addProviderId(providerIds, character.id);
    characterIds.add(character.id);
  }
  for (const act of proposal.playModel.acts) {
    addProviderId(providerIds, act.id);
    if (actOrdinals.has(act.ordinal)) throw new Error(`duplicate act ordinal: ${act.ordinal}`);
    actOrdinals.add(act.ordinal);
    const sceneOrdinals = new Set<number>();
    for (const scene of act.scenes) {
      addProviderId(providerIds, scene.id);
      if (sceneOrdinals.has(scene.ordinal)) throw new Error(`duplicate scene ordinal: ${scene.ordinal}`);
      sceneOrdinals.add(scene.ordinal);
      for (const characterId of scene.characterIds) requiredProviderCharacter(characterIds, characterId);
      for (const element of scene.elements) {
        addProviderId(providerIds, element.id);
        elementIds.add(element.id);
        if (element.kind === "dialogue") {
          if (!element.characterId) throw new Error("dialogue owner is required");
          requiredProviderCharacter(characterIds, element.characterId);
        }
      }
    }
  }
  for (const issue of proposal.issues) {
    addProviderId(providerIds, issue.id);
    for (const elementId of issue.elementIds) {
      if (!elementIds.has(elementId)) throw new Error(`issue references unknown element: ${elementId}`);
    }
  }
  return proposal;
}

export const ReviewCorrectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("unreadable_text"),
    issueId: z.string().min(1),
    elementId: z.string().min(1),
    text: z.string().min(1),
  }),
  z.object({
    kind: z.literal("dialogue_owner"),
    issueId: z.string().min(1),
    elementId: z.string().min(1),
    characterId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("character_name"),
    issueId: z.string().min(1),
    characterId: z.string().min(1),
    name: z.string().min(1),
    elementIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal("scene_boundary"),
    issueId: z.string().min(1),
    operation: z.literal("split_scene"),
    sourceSceneId: z.string().min(1),
    beforeElementId: z.string().min(1),
    newSceneTitle: z.string().min(1),
  }),
]);

export const ReviewPatchSchema = z.object({
  expectedModelId: z.string().min(1),
  expectedModelVersion: z.number().int().positive(),
  corrections: z.array(ReviewCorrectionSchema),
  approve: z.boolean(),
});

export type ReviewCorrection = z.infer<typeof ReviewCorrectionSchema>;

export function applyReviewCorrections(
  current: ParseProposal,
  corrections: ReviewCorrection[],
  playId: string,
  nextVersion: number,
): ParseProposal {
  const model = structuredClone(current.playModel);
  const issues = structuredClone(current.issues);
  const elements = new Map<string, ScriptElement>();
  for (const act of model.acts) {
    for (const scene of act.scenes) {
      for (const element of scene.elements) elements.set(element.id, element);
    }
  }
  const characters = new Map(model.characters.map((character) => [character.id, character]));

  for (const correction of corrections) {
    const issue = issues.find((candidate) => candidate.id === correction.issueId);
    if (!issue || issue.kind !== correction.kind) {
      throw new Error("Correction does not match the review issue kind");
    }
    let resolvedElementIds: string[];
    if (correction.kind === "character_name") {
      const character = characters.get(correction.characterId);
      if (!character) throw new Error("Correction references unknown character");
      const implicatedElements = correction.elementIds.map((elementId) => elements.get(elementId));
      if (implicatedElements.some((element) => (
        !element || element.kind !== "dialogue" || element.characterId !== correction.characterId
      ))) {
        throw new Error("Correction character is not implicated by the issue passages");
      }
      character.name = correction.name;
      resolvedElementIds = correction.elementIds;
    } else if (correction.kind === "scene_boundary") {
      if (!issue.elementIds.includes(correction.beforeElementId)) {
        throw new Error("Correction does not match a review issue and source element");
      }
      const location = findScene(model, correction.sourceSceneId);
      if (!location) throw new Error("Correction source scene was not found");
      const splitIndex = location.scene.elements.findIndex((element) => element.id === correction.beforeElementId);
      if (splitIndex <= 0) throw new Error("Correction scene split must leave elements in the source scene");
      const movedElements = location.scene.elements.splice(splitIndex);
      location.scene.characterIds = dialogueCharacterIds(location.scene.elements);
      for (let index = location.sceneIndex + 1; index < location.act.scenes.length; index += 1) {
        location.act.scenes[index]!.ordinal += 1;
      }
      location.act.scenes.splice(location.sceneIndex + 1, 0, {
        id: `review-split:${location.scene.id}:${correction.beforeElementId}`,
        ordinal: location.scene.ordinal + 1,
        title: correction.newSceneTitle,
        characterIds: dialogueCharacterIds(movedElements),
        elements: movedElements,
      });
      resolvedElementIds = [correction.beforeElementId];
    } else {
      const element = elements.get(correction.elementId);
      if (!element) throw new Error("Correction source element was not found");
      resolvedElementIds = [correction.elementId];
      if (correction.kind === "unreadable_text") element.text = correction.text;
      if (correction.kind === "dialogue_owner") {
        if (element.kind !== "dialogue") throw new Error("Correction can assign an owner only to dialogue");
        if (!characters.has(correction.characterId)) throw new Error("Correction references unknown character");
        element.characterId = correction.characterId;
      }
    }
    for (const elementId of resolvedElementIds) {
      if (!issue.elementIds.includes(elementId)) {
        throw new Error("Correction does not match a review issue and source element");
      }
    }
    issue.elementIds = issue.elementIds.filter((elementId) => !resolvedElementIds.includes(elementId));
  }

  return normalizeParseProposal({
    playModel: model,
    issues: issues.filter((issue) => issue.elementIds.length > 0),
  }, playId, nextVersion);
}

function findScene(model: PlayModel, sceneId: string) {
  for (const act of model.acts) {
    const sceneIndex = act.scenes.findIndex((scene) => scene.id === sceneId);
    if (sceneIndex >= 0) return { act, scene: act.scenes[sceneIndex]!, sceneIndex };
  }
  return null;
}

function dialogueCharacterIds(elements: ScriptElement[]): string[] {
  return [...new Set(elements.flatMap((element) => (
    element.kind === "dialogue" ? [element.characterId] : []
  )))];
}

export function normalizeParseProposal(
  input: unknown,
  playId: string,
  version: number,
): ParseProposal {
  const proposal = validateParseProposal(input);
  const versionId = `${playId}:v${version}`;
  const characterIdMap = new Map<string, string>();
  const elementIdMap = new Map<string, string>();
  let nextElementOrdinal = 1;

  const characters = proposal.playModel.characters.map((character, index) => {
    if (characterIdMap.has(character.id)) {
      throw new Error(`duplicate character ID: ${character.id}`);
    }
    const id = `${versionId}:character:${index + 1}`;
    characterIdMap.set(character.id, id);
    return { ...character, id };
  });

  const acts = proposal.playModel.acts.map((act) => ({
    ...act,
    id: `${versionId}:act:${act.ordinal}`,
    scenes: act.scenes.map((scene) => ({
      ...scene,
      id: `${versionId}:act:${act.ordinal}:scene:${scene.ordinal}`,
      characterIds: scene.characterIds.map((id) => requiredCharacterId(characterIdMap, id)),
      elements: scene.elements.map((element) => {
        const ordinal = nextElementOrdinal;
        nextElementOrdinal += 1;
        const id = `${versionId}:element:${ordinal}`;
        elementIdMap.set(element.id, id);
        return normalizeElement({ ...element, ordinal }, id, characterIdMap);
      }),
    })),
  }));

  const playModel: PlayModel = {
    ...proposal.playModel,
    id: versionId,
    characters,
    acts,
  };
  const issues = proposal.issues.map((issue, index) => ({
    ...issue,
    id: `${versionId}:issue:${index + 1}`,
    elementIds: issue.elementIds.map((id) => {
      const localId = elementIdMap.get(id);
      if (!localId) throw new Error(`issue references unknown element: ${id}`);
      return localId;
    }),
  }));

  return ParseProposalSchema.parse({ playModel, issues });
}

function addProviderId(ids: Set<string>, id: string): void {
  if (ids.has(id)) throw new Error(`duplicate provider ID: ${id}`);
  ids.add(id);
}

function requiredProviderCharacter(ids: Set<string>, id: string): void {
  if (!ids.has(id)) throw new Error(`unknown character reference: ${id}`);
}

function requiredCharacterId(ids: Map<string, string>, providerId: string): string {
  const id = ids.get(providerId);
  if (!id) throw new Error(`unknown character reference: ${providerId}`);
  return id;
}

function normalizeElement(
  element: ScriptElement,
  id: string,
  characterIds: Map<string, string>,
): ScriptElement {
  if (element.kind !== "dialogue") return { ...element, id };
  if (!element.characterId) throw new Error("dialogue owner is required");
  return { ...element, id, characterId: requiredCharacterId(characterIds, element.characterId) };
}
