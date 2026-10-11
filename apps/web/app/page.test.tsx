import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HomePage from "./page";

describe("home page", () => {
  it("presents the primary journey and practice capabilities", () => {
    const markup = renderToStaticMarkup(<HomePage />);
    expect(markup).toContain("Know the text.");
    expect(markup).toContain('href="/sign-in"');
    expect(markup).toContain("Study with evidence");
    expect(markup).toContain("Build the character");
    expect(markup).toContain("Rehearse out loud");
  });

  it("keeps decorative icons out of the accessibility tree", () => {
    const markup = renderToStaticMarkup(<HomePage />);
    expect(markup.match(/<img/g)).toHaveLength(4);
    expect(markup.match(/alt=""/g)).toHaveLength(4);
    expect(markup).toContain('aria-label="From page to performance"');
  });
});
