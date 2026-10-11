import { describe, expect, it } from "vitest";

import type { PlayModel } from "./play-model";
import {
  validateRoleWorkbook,
  validateStudyArtifact,
  type RoleWorkbook,
  type StudyArtifact,
} from "./study";

const playId = "22222222-2222-4222-8222-222222222222";
const characterId = `${playId}:v2:character:1`;
const elementId = `${playId}:v2:element:1`;
const stageDirectionId = `${playId}:v2:element:2`;

const play: PlayModel = {
  id: `${playId}:v2`,
  title: "The First Step",
  language: "en",
  characters: [{ id: characterId, name: "Alex", aliases: [] }],
  acts: [{
    id: `${playId}:v2:act:1`,
    ordinal: 1,
    title: "Act I",
    scenes: [{
      id: `${playId}:v2:act:1:scene:1`,
      ordinal: 1,
      title: "Scene 1",
      characterIds: [characterId],
      elements: [{
        id: elementId,
        ordinal: 1,
        kind: "dialogue",
        characterId,
        text: "We begin.",
        sourcePage: 1,
      }, {
        id: stageDirectionId,
        ordinal: 2,
        kind: "stage_direction",
        text: "[Alex crosses to the door.]",
        sourcePage: 1,
      }],
    }],
  }],
};

function artifact(claims: StudyArtifact["claims"]): StudyArtifact {
  return {
    id: "overview",
    kind: "overview",
    scopeId: null,
    claims,
  };
}

describe("grounded study validation", () => {
  it("requires explicit claims to cite existing elements", () => {
    const invalid = artifact([{
      id: "c1",
      text: "Alex begins the action.",
      epistemicStatus: "explicit",
      reference: { playId, elementIds: [`${playId}:v2:element:999`] },
    }]);

    expect(() => validateStudyArtifact(invalid, play)).toThrow("UNKNOWN_SCRIPT_REFERENCE");
  });

  it("requires explicit claims to include a citation", () => {
    const invalid = artifact([{
      id: "c1",
      text: "Alex begins the action.",
      epistemicStatus: "explicit",
      reference: null,
    }]);

    expect(() => validateStudyArtifact(invalid, play)).toThrow("MISSING_SCRIPT_REFERENCE");
  });

  it("allows uncited interpretation only when labeled", () => {
    const valid = artifact([{
      id: "c1",
      text: "A playable choice",
      epistemicStatus: "interpretation",
      reference: null,
    }]);

    expect(validateStudyArtifact(valid, play)).toEqual(valid);
  });

  it("rejects citations to a different play", () => {
    const invalid = artifact([{
      id: "c1",
      text: "Alex begins the action.",
      epistemicStatus: "explicit",
      reference: { playId: "another-play", elementIds: [elementId] },
    }]);

    expect(() => validateStudyArtifact(invalid, play)).toThrow("UNKNOWN_SCRIPT_REFERENCE");
  });
});

describe("role workbook validation", () => {
  it("validates the selected character belongs to the approved model", () => {
    expect(() => validateRoleWorkbook(workbook("missing-character"), play)).toThrow("UNKNOWN_CHARACTER");
  });

  it("validates grounding across every workbook field", () => {
    const invalid = workbook(characterId);
    invalid.beats[0]!.reference = { playId, elementIds: ["missing-element"] };

    expect(() => validateRoleWorkbook(invalid, play)).toThrow("UNKNOWN_SCRIPT_REFERENCE");
  });

  it("requires referenced stage directions to cite stage-direction elements", () => {
    const invalid = workbook(characterId);
    invalid.referencedStageDirections[0]!.reference = { playId, elementIds: [elementId] };

    expect(() => validateRoleWorkbook(invalid, play)).toThrow("REFERENCE_IS_NOT_STAGE_DIRECTION");
  });
});

function workbook(selectedCharacterId: string): RoleWorkbook {
  const explicit = (id: string) => ({
    id,
    text: "Alex says they begin.",
    epistemicStatus: "explicit" as const,
    reference: { playId, elementIds: [elementId] },
  });
  return {
    id: "role-alex",
    characterId: selectedCharacterId,
    directorConcept: null,
    circumstances: [explicit("circumstance-1")],
    relationships: [explicit("relationship-1")],
    superObjectiveOptions: [explicit("super-objective-1")],
    sceneObjectives: [explicit("scene-objective-1")],
    obstacles: [explicit("obstacle-1")],
    stakes: [explicit("stakes-1")],
    tactics: [explicit("tactic-1")],
    entranceExitStates: [explicit("state-1")],
    beats: [explicit("beat-1")],
    subtextOptions: [explicit("subtext-1")],
    referencedStageDirections: [{ ...explicit("stage-direction-1"),
      reference: { playId, elementIds: [stageDirectionId] } }],
  };
}
