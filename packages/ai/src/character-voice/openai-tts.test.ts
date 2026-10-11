import { describe, expect, it, vi } from "vitest";

import { OpenAiTtsSynthesizer } from "./openai-tts";

describe("OpenAiTtsSynthesizer", () => {
  it("sends exact text and the persisted supported voice without forwarding any other performance input", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const request: typeof fetch = async (input, init) => { calls.push({ input, init });
      return new Response(Uint8Array.of(1, 2, 3),
        { status: 200, headers: { "content-type": "audio/mpeg" } }); };
    const synthesizer = new OpenAiTtsSynthesizer({ apiKey: "server-secret", fetch: request });

    const result = await synthesizer.synthesize({ exactText: "At last.", voice: "marin" });

    expect(result).toEqual({ bytes: Uint8Array.of(1, 2, 3), mediaType: "audio/mpeg" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://api.openai.com/v1/audio/speech");
    const init = calls[0]!.init!;
    expect(init.headers).toEqual({ authorization: "Bearer server-secret", "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ model: "gpt-4o-mini-tts", input: "At last.",
      voice: "marin", response_format: "mp3" });
  });

  it("rejects an unsupported persisted voice before contacting the provider", async () => {
    const request = vi.fn();
    const synthesizer = new OpenAiTtsSynthesizer({ apiKey: "server-secret", fetch: request });

    await expect(synthesizer.synthesize({ exactText: "At last.", voice: "arbitrary-browser-voice" }))
      .rejects.toThrow("Configured TTS voice is unsupported");
    expect(request).not.toHaveBeenCalled();
  });

  it("passes cancellation to provider generation and never exposes a provider response body", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | null | undefined> = [];
    const request: typeof fetch = async (_input, init) => { signals.push(init?.signal);
      return new Response("provider-secret-body", { status: 500 }); };
    const synthesizer = new OpenAiTtsSynthesizer({ apiKey: "server-secret", fetch: request });

    const error = await synthesizer.synthesize({ exactText: "At last.", voice: "cedar",
      signal: controller.signal }).catch((caught: unknown) => caught);

    expect(signals).toEqual([controller.signal]);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Configured TTS provider request failed");
    expect((error as Error).message).not.toContain("provider-secret-body");
  });

  it("streams expected audio/mpeg with standard case and parameters without using unbounded arrayBuffer", async () => {
    const response = new Response(streamChunks([
      new Uint8Array(0), Uint8Array.of(1, 2), new Uint8Array(0), Uint8Array.of(3),
    ]), { status: 200, headers: { "content-type": "Audio/MPEG; charset=binary" } });
    const arrayBuffer = vi.spyOn(response, "arrayBuffer");
    const synthesizer = synthesizerReturning(response);

    await expect(synthesizer.synthesize({ exactText: "At last.", voice: "marin" })).resolves.toEqual({
      bytes: Uint8Array.of(1, 2, 3), mediaType: "audio/mpeg",
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("cancels on the 1,025th empty chunk so a provider cannot retain chunks or loop without progress", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 1_025) { controller.enqueue(new Uint8Array(0)); return; }
        controller.enqueue(Uint8Array.of(7));
        controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const synthesizer = synthesizerReturning(new Response(body, { status: 200,
      headers: { "content-type": "audio/mpeg" } }));

    const error = await captureError(synthesizer.synthesize({ exactText: "At last.", voice: "marin" }));

    expect(error.message).toBe("Configured TTS provider returned invalid audio");
    expect(cancelled).toBe(true);
    expect(pulls).toBe(1_025);
  });

  it("resets the consecutive empty-read budget after positive bytes at the permitted boundary", async () => {
    const emptyBoundary = Array.from({ length: 1_024 }, () => new Uint8Array(0));
    const response = new Response(streamChunks([
      ...emptyBoundary, Uint8Array.of(4), ...emptyBoundary, Uint8Array.of(5, 6),
    ]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    const synthesizer = synthesizerReturning(response);

    await expect(synthesizer.synthesize({ exactText: "At last.", voice: "marin" })).resolves.toEqual({
      bytes: Uint8Array.of(4, 5, 6), mediaType: "audio/mpeg",
    });
  });

  it("cancels the first chunk beyond a 65,536 total-chunk work budget despite sparse progress", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(pulls % 1_025 === 0 ? Uint8Array.of(1) : new Uint8Array(0));
        if (pulls === 65_538) controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const synthesizer = synthesizerReturning(new Response(body, { status: 200,
      headers: { "content-type": "audio/mpeg" } }));

    const error = await captureError(synthesizer.synthesize({ exactText: "At last.", voice: "marin" }));

    expect(error.message).toBe("Configured TTS provider returned invalid audio");
    expect(cancelled).toBe(true);
    expect(pulls).toBe(65_537);
  });

  it.each([
    { label: "missing", contentType: undefined },
    { label: "non-audio", contentType: "application/json" },
  ])("rejects $label Content-Type before reading provider bytes", async ({ contentType }) => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      pulls += 1; controller.enqueue(Uint8Array.of(9)); controller.close();
    }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const headers = contentType === undefined ? undefined : { "content-type": contentType };
    const synthesizer = synthesizerReturning(new Response(body, { status: 200, headers }));

    const error = await captureError(synthesizer.synthesize({ exactText: "At last.", voice: "marin" }));

    expect(error.message).toBe("Configured TTS provider returned invalid audio");
    expect(pulls).toBe(0);
    expect(cancelled).toBe(true);
  });

  it("rejects a declared Content-Length over 16 MiB before reading the provider body", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      pulls += 1; controller.enqueue(Uint8Array.of(1)); controller.close();
    }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const synthesizer = synthesizerReturning(new Response(body, { status: 200, headers: {
      "content-type": "audio/mpeg", "content-length": "16777217",
    } }));

    const error = await captureError(synthesizer.synthesize({ exactText: "At last.", voice: "marin" }));

    expect(error.message).toBe("Configured TTS provider returned invalid audio");
    expect(pulls).toBe(0);
    expect(cancelled).toBe(true);
  });

  it("cancels a chunked provider body immediately when its running size crosses 16 MiB", async () => {
    const eightMiB = 8_388_608;
    const chunks = [new Uint8Array(eightMiB), new Uint8Array(eightMiB), Uint8Array.of(1), Uint8Array.of(2)];
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[pulls];
        if (!chunk) { controller.close(); return; }
        pulls += 1; controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const synthesizer = synthesizerReturning(new Response(body, { status: 200,
      headers: { "content-type": "audio/mpeg" } }));

    const error = await captureError(synthesizer.synthesize({ exactText: "At last.", voice: "marin" }));

    expect(error.message).toBe("Configured TTS provider returned invalid audio");
    expect(cancelled).toBe(true);
    expect(pulls).toBe(3);
  });

  it("accepts exactly 16 MiB while still using bounded streaming", async () => {
    const exactLimit = 16_777_216;
    const response = new Response(streamChunks([new Uint8Array(exactLimit - 1), Uint8Array.of(7)]), { status: 200,
      headers: { "content-type": "audio/mpeg", "content-length": "16777216" } });
    const arrayBuffer = vi.spyOn(response, "arrayBuffer");
    const synthesizer = synthesizerReturning(response);

    const result = await synthesizer.synthesize({ exactText: "At last.", voice: "marin" });

    expect(result.mediaType).toBe("audio/mpeg");
    expect(result.bytes.byteLength).toBe(16_777_216);
    expect(result.bytes[16_777_215]).toBe(7);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("replaces arbitrary provider stream exceptions with a generic audio error", async () => {
    const body = new ReadableStream<Uint8Array>({ pull() {
      throw new Error("private upstream stream failure");
    } }, { highWaterMark: 0 });
    const synthesizer = synthesizerReturning(new Response(body, { status: 200,
      headers: { "content-type": "audio/mpeg" } }));

    const error = await captureError(synthesizer.synthesize({ exactText: "At last.", voice: "marin" }));

    expect(error.message).toBe("Configured TTS provider returned invalid audio");
    expect(error.message).not.toContain("private upstream stream failure");
  });

  it("replaces arbitrary provider request exceptions with a generic request error", async () => {
    const synthesizer = new OpenAiTtsSynthesizer({ apiKey: "server-secret", fetch: async () => {
      throw new Error("private provider connection failure");
    } });

    const error = await captureError(synthesizer.synthesize({ exactText: "At last.", voice: "marin" }));

    expect(error.message).toBe("Configured TTS provider request failed");
    expect(error.message).not.toContain("private provider connection failure");
  });
});

function synthesizerReturning(response: Response): OpenAiTtsSynthesizer {
  return new OpenAiTtsSynthesizer({ apiKey: "server-secret", fetch: async () => response });
}

function streamChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({ pull(controller) {
    const chunk = chunks[index++];
    if (chunk) controller.enqueue(chunk);
    if (index >= chunks.length) controller.close();
  } }, { highWaterMark: 0 });
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  const result = await promise.catch((error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  return result as Error;
}
