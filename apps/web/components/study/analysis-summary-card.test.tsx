import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { AnalysisSummaryCard } from "./analysis-summary-card";

it("previews one grounded note and links to the focused analysis", () => {
  const markup = renderToStaticMarkup(<AnalysisSummaryCard title="Themes" href="/themes" claims={[
    { id: "one", text: "The first concise theme.", epistemicStatus: "explicit",
      reference: { playId: "play", elementIds: ["line-1"] } },
    { id: "two", text: "A detailed note belongs on the deep-dive page.", epistemicStatus: "interpretation",
      reference: null },
  ]} />);

  expect(markup).toContain("The first concise theme.");
  expect(markup).not.toContain("A detailed note belongs on the deep-dive page.");
  expect(markup).toContain("2 grounded notes");
  expect(markup).toContain('href="/themes"');
});
