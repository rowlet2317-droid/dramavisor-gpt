// Register the in-process worker before pdf.js loads so server bundles do not
// try to resolve a separate pdf.worker.mjs file relative to a generated chunk.
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export async function validatePdf(bytes: Uint8Array): Promise<string> {
  const document = await loadPdf(bytes);
  const pageTexts: string[] = [];
  try {
    if (document.numPages < 1) {
      throw new Error("PDF has no pages");
    }
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pageTexts.push(textFromItems(content.items));
      page.cleanup();
    }
  } finally {
    await document.destroy();
  }
  return pageTexts.join("\n");
}

export function loadPdf(bytes: Uint8Array) {
  return getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true }).promise;
}

export function textFromItems(items: unknown[]): string {
  return items
    .filter((item): item is typeof item & { str: string; hasEOL?: boolean } => typeof item === "object" && item !== null && "str" in item)
    .map((item) => `${item.str}${item.hasEOL ? "\n" : " "}`)
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
