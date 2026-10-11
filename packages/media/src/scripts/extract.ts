import { extractDocxText } from "./docx";
import { HttpEnglishOcrAdapter, type EnglishOcrAdapter } from "./ocr";
import { extractPdf } from "./pdf";
import { decodeTextFile, prepareScriptText } from "./text";

export { validateScriptFile } from "./validate";

export type ExtractedPage = {
  page: number | null;
  text: string;
  extraction: "native" | "ocr";
};

export type ExtractedScript = {
  titleHint: string | null;
  pages: ExtractedPage[];
  warnings: string[];
};

export type ScriptInput =
  | { kind: "text"; text: string }
  | { kind: "file"; filename: string; contentType: string; bytes: Uint8Array };

export class ScriptExtractor {
  private readonly ocr: EnglishOcrAdapter;

  constructor(options: { ocr?: EnglishOcrAdapter } = {}) {
    this.ocr = options.ocr ?? new HttpEnglishOcrAdapter({
      endpoint: process.env.OCR_ENDPOINT ?? "",
      apiKey: process.env.OCR_API_KEY,
    });
  }

  async extract(input: ScriptInput): Promise<ExtractedScript> {
    if (input.kind === "text") {
      return script([{ page: null, text: prepareScriptText(input.text), extraction: "native" }], []);
    }

    if (input.contentType === "application/pdf") {
      const result = await extractPdf(input.bytes, this.ocr);
      return script(result.pages, result.warnings);
    }

    if (input.contentType === "text/plain") {
      const extracted = script([{ page: null, text: decodeTextFile(input.bytes), extraction: "native" }], []);
      return withFilenameTitle(extracted, input.filename);
    }

    if (input.contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      const text = prepareScriptText(await extractDocxText(input.bytes));
      return script([{ page: null, text, extraction: "native" }], []);
    }

    throw new Error(`Unsupported script type: ${input.contentType}`);
  }
}

export type ScriptExtractorCompositionOptions = {
  ocrEndpoint?: string;
  ocrApiKey?: string;
  fetch?: typeof globalThis.fetch;
};

export function createScriptExtractor(options: ScriptExtractorCompositionOptions = {}): ScriptExtractor {
  return new ScriptExtractor({
    ocr: new HttpEnglishOcrAdapter({
      endpoint: options.ocrEndpoint ?? process.env.OCR_ENDPOINT ?? "",
      apiKey: options.ocrApiKey ?? process.env.OCR_API_KEY,
      fetch: options.fetch,
    }),
  });
}

function script(pages: ExtractedPage[], warnings: string[]): ExtractedScript {
  const firstLine = pages
    .flatMap((page) => page.text.split(/\r?\n/))
    .map((line) => line.trim())
    .find(Boolean);
  return { titleHint: firstLine ?? null, pages, warnings };
}

function withFilenameTitle(extracted: ExtractedScript, filename: string): ExtractedScript {
  if (!extracted.titleHint || !/^\s*(?:scene\b|act\b|(?:first|second|third|fourth|fifth)\s+act\b)/i
    .test(extracted.titleHint)) return extracted;
  const title = filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return { ...extracted, titleHint: title || extracted.titleHint };
}
