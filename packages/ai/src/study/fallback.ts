import type { PlayModel, ScriptElement } from "@drama/domain/play-model";
import type { GroundedClaim, RoleWorkbook, StudyArtifact, StudySectionKind } from "@drama/domain/study";

export function fallbackStudyArtifact(
  play: PlayModel,
  kind: StudySectionKind,
  scopeId: string | null,
): StudyArtifact {
  const element = scopedElements(play, scopeId)[0] ?? allElements(play)[0];
  const claim = element
    ? groundedClaim(play, `${kind}-fallback-claim`, fallbackSectionText(kind, element), element)
    : interpretation(`${kind}-fallback-claim`, "The approved script contains no text to analyze yet.");
  return { id: `${kind}-fallback`, kind, scopeId, claims: [claim] };
}

export function fallbackRoleWorkbook(
  play: PlayModel,
  characterId: string,
  directorConcept: string | null,
): RoleWorkbook {
  const character = play.characters.find(({ id }) => id === characterId);
  if (!character) throw new Error("UNKNOWN_CHARACTER");
  const speeches = allElements(play).filter((element) => (
    element.kind === "dialogue" && element.characterId === characterId
  ));
  const first = speeches[0];
  const claim = (field: string, text: string, element = first) => element
    ? groundedClaim(play, `${field}-fallback`, text, element)
    : interpretation(`${field}-fallback`, text);
  const quote = first ? `“${excerpt(first.text)}”` : "the character's first appearance";

  return {
    id: `${characterId}:fallback-workbook`, characterId, directorConcept,
    circumstances: [claim("circumstances", `${character.name}'s given circumstances can be explored from ${quote}.`)],
    relationships: [claim("relationships", `Use ${quote} to investigate whom ${character.name} needs in the scene.`)],
    superObjectiveOptions: [claim("super-objective", `Try pursuing what ${character.name} most needs while speaking ${quote}.`)],
    sceneObjectives: [claim("scene-objective", `Choose a playable objective for ${character.name} immediately before ${quote}.`)],
    obstacles: [claim("obstacle", `Identify what prevents ${character.name} from getting what they need in ${quote}.`)],
    stakes: [claim("stakes", `Ask what ${character.name} risks if the need behind ${quote} is not met.`)],
    tactics: [claim("tactic", `Rehearse ${quote} with two contrasting tactics.`)],
    entranceExitStates: [claim("state", `Track ${character.name}'s physical and emotional state around ${quote}.`)],
    beats: [claim("beat", `Treat ${quote} as an initial beat and mark the next change in tactic.`)],
    subtextOptions: [claim("subtext", `Test a subtext that contrasts with the literal words ${quote}.`)],
    referencedStageDirections: [],
  };
}

function allElements(play: PlayModel): ScriptElement[] {
  return play.acts.flatMap((act) => act.scenes.flatMap((scene) => scene.elements));
}

function scopedElements(play: PlayModel, scopeId: string | null): ScriptElement[] {
  if (!scopeId) return allElements(play);
  return play.acts.flatMap((act) => act.scenes.filter(({ id }) => id === scopeId).flatMap(({ elements }) => elements));
}

function groundedClaim(play: PlayModel, id: string, text: string, element: ScriptElement): GroundedClaim {
  return { id, text, epistemicStatus: "interpretation", reference: {
    playId: play.id.replace(/:v\d+$/, ""), elementIds: [element.id],
  } };
}

function interpretation(id: string, text: string): GroundedClaim {
  return { id, text, epistemicStatus: "interpretation", reference: null };
}

function fallbackSectionText(kind: StudySectionKind, element: ScriptElement): string {
  const passage = `“${excerpt(element.text)}”`;
  const lead: Record<StudySectionKind, string> = {
    overview: "Begin the first read with this passage",
    themes: "Use this passage to investigate a recurring idea",
    dramatic_structure: "Use this passage to mark the dramatic situation and its next change",
    characters: "Use this passage as evidence when identifying the speaker's immediate need",
    relationships: "Use this passage to explore how the speaker tries to affect the other characters",
    scene: "Start the scene analysis with this passage",
  };
  return `${lead[kind]}: ${passage}.`;
}

function excerpt(text: string): string {
  return text.length > 180 ? `${text.slice(0, 177).trimEnd()}…` : text;
}
