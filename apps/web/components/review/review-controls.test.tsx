import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { ReviewControls } from "./review-controls";

it("lets an actor correct an unreadable passage and approve the reviewed model", () => {
  const markup = renderToStaticMarkup(<ReviewControls playId="play-1" expectedModelId="model-1"
    expectedModelVersion={1} issues={[{
    id: "issue-1", kind: "unreadable_text", message: "Confirm this line.", elementIds: ["line-1"],
  }]} elements={[{ id: "line-1", text: "We beg1n.", kind: "dialogue", characterId: "alex",
    sceneId: "scene-1" }]} characters={[{ id: "alex", name: "Alex" }]} />);

  expect(markup).toContain("We beg1n.");
  expect(markup).toContain("Approve corrected play");
  expect(markup).toContain("issue-1");
});

it("renders actionable controls for every structural correction variant", () => {
  const markup = renderToStaticMarkup(<ReviewControls playId="play-1" expectedModelId="model-1"
    expectedModelVersion={3} issues={[
      { id: "name", kind: "character_name", message: "Name", elementIds: ["line-1"] },
      { id: "owner", kind: "dialogue_owner", message: "Owner", elementIds: ["line-2"] },
    ]} elements={[
      { id: "line-1", text: "ALEX", kind: "dialogue", characterId: "alex", sceneId: "scene-1" },
      { id: "line-2", text: "Who speaks?", kind: "dialogue", characterId: "alex", sceneId: "scene-1" },
    ]} characters={[{ id: "alex", name: "Alex" }, { id: "morgan", name: "Morgan" }]} />);

  expect(markup).toContain("Correct character name");
  expect(markup).toContain("Assign dialogue owner");
  expect(markup).not.toContain("advanced correction flow");
  expect(markup).toContain('value="model-1"');
});

it("offers one candidate at a time and never auto-approves a multi-candidate scene boundary", () => {
  const markup = renderToStaticMarkup(<ReviewControls playId="play-1" expectedModelId="model-1"
    expectedModelVersion={3} issues={[
      { id: "boundary", kind: "scene_boundary", message: "Boundary", elementIds: ["line-2", "line-3"] },
    ]} elements={[
      { id: "line-1", text: "Before.", kind: "dialogue", characterId: "alex", sceneId: "scene-1" },
      { id: "line-2", text: "Possible split.", kind: "heading", sceneId: "scene-1" },
      { id: "line-3", text: "Another split.", kind: "heading", sceneId: "scene-1" },
    ]} characters={[{ id: "alex", name: "Alex" }]} />);

  expect(markup.match(/type="radio"/g)).toHaveLength(2);
  expect(markup.match(/name="sceneBoundaryCandidate"/g)).toHaveLength(2);
  expect(markup).toContain("Possible split.");
  expect(markup).toContain("Another split.");
  expect(markup).toContain("Save selected boundary");
  expect(markup).not.toContain("Approve corrected play");
});

it("does not trap the actor in an empty scene-boundary correction", () => {
  const markup = renderToStaticMarkup(<ReviewControls playId="play-1" expectedModelId="model-1"
    expectedModelVersion={1} issues={[
      { id: "boundary", kind: "scene_boundary", message: "No explicit heading.", elementIds: [] },
    ]} elements={[]} characters={[]} />);

  expect(markup).not.toContain("Choose one scene boundary");
  expect(markup).not.toContain("Save selected boundary");
  expect(markup).toContain("Approve corrected play");
});
