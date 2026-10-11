import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PlayModel } from "@drama/domain/play-model";
import type { GroundedClaim as GroundedClaimValue } from "@drama/domain/study";

import { GroundedClaim } from "./grounded-claim";

const play: PlayModel = {
  id: "play-1:v2",
  title: "The First Step",
  language: "en",
  characters: [{ id: "alex", name: "Alex", aliases: [] }],
  acts: [{
    id: "act-1", ordinal: 1, title: "Act I", scenes: [{
      id: "scene-1", ordinal: 2, title: "The Door", characterIds: ["alex"],
      elements: [{
        id: "line-7", ordinal: 7, kind: "dialogue", characterId: "alex",
        text: "We begin.", sourcePage: 4,
      }],
    }],
  }],
};

describe("GroundedClaim", () => {
  it("shows interpretation separately from script evidence", () => {
    const claim: GroundedClaimValue = {
      id: "c1",
      text: "He may be concealing fear.",
      epistemicStatus: "interpretation",
      reference: null,
    };

    const markup = renderToStaticMarkup(<GroundedClaim claim={claim} />);

    expect(markup).toContain("Interpretation");
    expect(markup).not.toContain("Script evidence");
  });

  it("links script evidence to its original passage with a complete stable locator", () => {
    const claim: GroundedClaimValue = {
      id: "c2",
      text: "Alex initiates the action.",
      epistemicStatus: "explicit",
      reference: { playId: "play-1", elementIds: ["line-7"] },
    };

    const markup = renderToStaticMarkup(<GroundedClaim claim={claim} play={play} />);

    expect(markup).toContain("Script evidence");
    expect(markup).toContain("Act 1");
    expect(markup).toContain("Scene 2");
    expect(markup).toContain("line-7");
    expect(markup).toContain("Page 4");
    expect(markup).toContain('href="/plays/play-1/scenes/scene-1#line-7"');
  });
});
