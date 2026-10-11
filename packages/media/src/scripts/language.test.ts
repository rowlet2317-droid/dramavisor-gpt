import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { isNonEnglishScript } from "./language";
import { decodeTextFile } from "./text";

const fixtures = new URL("../../../../fixtures/plays/", import.meta.url);

describe("script language detection", () => {
  it.each(["riders-to-the-sea.txt", "the-importance-of-being-earnest.txt", "hamlet.txt"])(
    "does not reject dramatic English in %s",
    async (filename) => {
      expect(isNonEnglishScript(decodeTextFile(await readFile(new URL(filename, fixtures))))).toBe(false);
    },
  );

  it("still rejects a Spanish script", async () => {
    expect(isNonEnglishScript(await readFile(new URL("two-scene-play-es.txt", fixtures), "utf8"))).toBe(true);
  });
});
