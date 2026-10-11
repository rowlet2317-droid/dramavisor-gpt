export type OcrInput = {
  imageBytes: Uint8Array;
  page: number;
  language: "eng";
};

export interface EnglishOcrAdapter {
  recognize(input: OcrInput): Promise<string>;
}

export type HttpEnglishOcrAdapterOptions = {
  endpoint: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
};

export class HttpEnglishOcrAdapter implements EnglishOcrAdapter {
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly options: HttpEnglishOcrAdapterOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async recognize(input: OcrInput): Promise<string> {
    if (!this.options.endpoint) {
      throw new Error("OCR_ENDPOINT is required for scanned PDF extraction");
    }
    const url = new URL(this.options.endpoint);
    url.searchParams.set("language", input.language);
    url.searchParams.set("page", String(input.page));
    const headers = new Headers({ "content-type": "image/png" });
    if (this.options.apiKey) {
      headers.set("authorization", `Bearer ${this.options.apiKey}`);
    }
    const response = await this.fetch(url, {
      method: "POST",
      headers,
      body: input.imageBytes as BodyInit,
    });
    if (!response.ok) {
      throw new Error(`English OCR request failed with status ${response.status}`);
    }
    const body = await response.json() as { text?: unknown };
    if (typeof body.text !== "string") {
      throw new Error("English OCR response did not contain text");
    }
    return body.text;
  }
}
