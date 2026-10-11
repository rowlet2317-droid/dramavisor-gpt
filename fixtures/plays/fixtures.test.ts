import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const fixtures = [
  ["riders-to-the-sea.txt", "RIDERS TO THE SEA", 40_000, "17bba8719feedb4c16792188322e65fbe3088f0ef0796d07fb2c268feb237d02"],
  ["the-importance-of-being-earnest.txt", "THE IMPORTANCE OF BEING EARNEST", 120_000, "06c4d158cee503dfbb099f18dec5dce89290636e3524be08127fb6c6c80ca570"],
  ["hamlet.txt", "HAMLET", 180_000, "29a178adfed2b617d6bd67e6e65018590a38985fc75da39556721379eebf6bd6"],
] as const;

describe("public-domain play fixtures", () => {
  it.each(fixtures)("keeps %s complete and attributable", async (file, title, minimumBytes, sha256) => {
    const path = resolve(process.cwd(), "fixtures/plays", file);
    const [contents, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    expect(metadata.size).toBeGreaterThan(minimumBytes);
    expect(contents.toUpperCase()).toContain(title);
    expect(contents).toContain("Project Gutenberg");
    expect(createHash("sha256").update(contents).digest("hex")).toBe(sha256);
  });

  it("covers materially different input sizes", async () => {
    const sizes = await Promise.all(fixtures.map(([file]) => stat(resolve(process.cwd(), "fixtures/plays", file)).then(({ size }) => size)));
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeGreaterThan(3);
  });
});
