import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { createScriptExtractor, ScriptExtractor, type ScriptInput } from "./extract";

const fixtures = new URL("../../../../fixtures/plays/", import.meta.url);

describe("ScriptExtractor", () => {
  const extractor = new ScriptExtractor();

  it.each(["txt", "docx", "pdf"] as const)("extracts the same dialogue from %s", async (format) => {
    const result = await extractor.extract(await fixture(format));

    expect(result.pages.map((page) => page.text).join("\n")).toContain("ALEX: We begin.");
    expect(result.titleHint).toBe("THE FIRST STEP");
    expect(result.warnings).toEqual([]);
  });

  it("preserves PDF page numbers and marks native extraction", async () => {
    const result = await extractor.extract(await fixture("pdf"));

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({ page: 1, extraction: "native" });
  });

  it("extracts a full public-domain TXT after its introduction", async () => {
    const bytes = await readFile(new URL("hamlet.txt", fixtures));
    const result = await extractor.extract({ kind: "file", filename: "hamlet.txt", contentType: "text/plain", bytes });

    expect(result.titleHint).toBe("hamlet");
    expect(result.pages[0]!.text).toContain("Scene I. Elsinore.");
    expect(result.pages[0]!.text).not.toContain("Project Gutenberg EBook");
  });

  it("uses the filename as the title hint for a one-act TXT that begins with SCENE", async () => {
    const bytes = await readFile(new URL("riders-to-the-sea.txt", fixtures));
    const result = await extractor.extract({ kind: "file", filename: "riders-to-the-sea.txt",
      contentType: "text/plain", bytes });

    expect(result.titleHint).toBe("riders to the sea");
    expect(result.pages[0]!.text.startsWith("SCENE.")).toBe(true);
  });

  it("uses English OCR for a sparse PDF page and reports low-confidence OCR", async () => {
    const calls: Array<{ page: number; language: string; imageBytes: Uint8Array }> = [];
    const ocrExtractor = new ScriptExtractor({
      ocr: {
        async recognize(input) {
          calls.push(input);
          return "ALEX: Begin.";
        },
      },
    });

    const result = await ocrExtractor.extract({
      kind: "file",
      filename: "sparse.pdf",
      contentType: "application/pdf",
      bytes: await sparsePdf(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.language).toBe("eng");
    expect(calls[0]!.page).toBe(1);
    expect(calls[0]!.imageBytes.byteLength).toBeGreaterThan(0);
    expect(result.pages).toEqual([{ page: 1, text: "ALEX: Begin.", extraction: "ocr" }]);
    expect(result.warnings).toEqual(["OCR_USED", "LOW_TEXT_CONFIDENCE"]);
  });

  it("uses the configured production HTTP OCR path for sparse PDFs", async () => {
    const requests: Request[] = [];
    const extractor = createScriptExtractor({
      ocrEndpoint: "https://ocr.internal/v1/recognize",
      ocrApiKey: "test-key",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ text: "ALEX: We begin after scanning this complete line of dialogue." });
      },
    });

    const result = await extractor.extract({
      kind: "file",
      filename: "sparse.pdf",
      contentType: "application/pdf",
      bytes: await sparsePdf(),
    });

    expect(result.pages[0]).toMatchObject({ extraction: "ocr", text: "ALEX: We begin after scanning this complete line of dialogue." });
    expect(result.warnings).toEqual(["OCR_USED"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://ocr.internal/v1/recognize?language=eng&page=1");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer test-key");
    expect(requests[0]!.headers.get("content-type")).toBe("image/png");
  });
});

async function fixture(format: "txt" | "docx" | "pdf"): Promise<ScriptInput> {
  if (format === "txt") {
    return { kind: "file", filename: "two-scene-play.txt", contentType: "text/plain",
      bytes: await readFile(new URL("two-scene-play.txt", fixtures)) };
  }
  const contentType = format === "pdf"
    ? "application/pdf"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return {
    kind: "file",
    filename: `two-scene-play.${format}`,
    contentType,
    bytes: await readFile(new URL(`two-scene-play.${format}`, fixtures)),
  };
}

async function sparsePdf(): Promise<Uint8Array> {
  const fixture = await readFile(new URL("two-scene-play.pdf", fixtures));
  const source = Buffer.from(fixture).toString("latin1");
  const sparse = source.replace(/\(([^\r\n]*)\) Tj/g, (_match, text: string) => {
    return `(${text.length > 0 ? "X".padEnd(text.length, " ") : ""}) Tj`;
  });
  return Buffer.from(sparse, "latin1");
}
