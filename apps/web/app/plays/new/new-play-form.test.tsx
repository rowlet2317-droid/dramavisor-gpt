import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { NewPlayForm } from "./new-play-form";

it("offers TXT alongside PDF and DOCX uploads", () => {
  const markup = renderToStaticMarkup(<NewPlayForm />);

  expect(markup).toContain("PDF, DOCX, or TXT");
  expect(markup).toContain(".txt");
  expect(markup).toContain("text/plain");
});
