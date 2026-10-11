import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { decodeTextFile, prepareScriptText } from "./text";

const fixtures = new URL("../../../../fixtures/plays/", import.meta.url);

describe("plain-text script preparation", () => {
  it.each([
    ["riders-to-the-sea.txt", "SCENE."],
    ["the-importance-of-being-earnest.txt", "FIRST ACT"],
    ["hamlet.txt", "ACT I."],
  ])("removes the introduction from %s and begins at the play", async (filename, expectedStart) => {
    const prepared = decodeTextFile(await readFile(new URL(filename, fixtures)));

    expect(prepared.startsWith(expectedStart)).toBe(true);
    expect(prepared).not.toContain("Project Gutenberg EBook");
    expect(prepared.length).toBeGreaterThan(10_000);
  });

  it("does not discard a script that has no explicit scene heading", () => {
    const script = "A PLAY WITHOUT SCENES\nALEX: We begin.\nSAM: We continue.";
    expect(prepareScriptText(script)).toBe(script);
  });
});
