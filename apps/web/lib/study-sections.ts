import type { RoleWorkbook } from "@drama/domain/study";

export const playSectionKinds = ["overview", "themes", "dramatic_structure", "relationships"] as const;
export type PlaySectionKind = typeof playSectionKinds[number];

export function playSectionTitle(kind: PlaySectionKind): string {
  if (kind === "dramatic_structure") return "Dramatic structure";
  return kind[0]!.toUpperCase() + kind.slice(1);
}

export const workbookSectionKinds = [
  "circumstances", "relationships", "superObjectiveOptions", "sceneObjectives", "obstacles", "stakes",
  "tactics", "entranceExitStates", "beats", "subtextOptions", "referencedStageDirections",
] as const;
export type WorkbookSectionKind = typeof workbookSectionKinds[number];

const workbookTitles: Record<WorkbookSectionKind, string> = {
  circumstances: "Given circumstances",
  relationships: "Relationships",
  superObjectiveOptions: "Super-objective options",
  sceneObjectives: "Scene objectives",
  obstacles: "Obstacles",
  stakes: "Stakes",
  tactics: "Tactics",
  entranceExitStates: "Entrance and exit states",
  beats: "Beats",
  subtextOptions: "Subtext options",
  referencedStageDirections: "Stage directions",
};

export function workbookSectionTitle(kind: WorkbookSectionKind): string {
  return workbookTitles[kind];
}

export function workbookSections(workbook: RoleWorkbook) {
  return workbookSectionKinds.map((kind) => ({ kind, title: workbookSectionTitle(kind), claims: workbook[kind] }));
}
