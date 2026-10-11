import { createCanvas } from "@napi-rs/canvas";

import type { EnglishOcrAdapter } from "./ocr";
import { loadPdf, textFromItems } from "./pdf-validation";

export { validatePdf } from "./pdf-validation";

export type ExtractedPdfPage = {
  page: number;
  text: string;
  extraction: "native" | "ocr";
};

export type PdfExtraction = {
  pages: ExtractedPdfPage[];
  warnings: string[];
};

export async function extractPdf(bytes: Uint8Array, ocr: EnglishOcrAdapter): Promise<PdfExtraction> {
  const document = await loadPdf(bytes);
  const pages: ExtractedPdfPage[] = [];
  const warnings = new Set<string>();

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const nativeText = textFromItems(content.items);

      if (nativeText.replace(/\s/g, "").length >= 20) {
        pages.push({ page: pageNumber, text: nativeText, extraction: "native" });
        page.cleanup();
        continue;
      }

      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const renderParameters = {
        canvas,
        canvasContext: canvas.getContext("2d"),
        viewport,
      } as unknown as Parameters<typeof page.render>[0];
      await page.render(renderParameters).promise;
      const text = (await ocr.recognize({
        imageBytes: canvas.toBuffer("image/png"),
        page: pageNumber,
        language: "eng",
      })).trim();
      pages.push({ page: pageNumber, text, extraction: "ocr" });
      warnings.add("OCR_USED");
      if (text.length < 40) {
        warnings.add("LOW_TEXT_CONFIDENCE");
      }
      page.cleanup();
    }
  } finally {
    await document.destroy();
  }

  return { pages, warnings: [...warnings] };
}
