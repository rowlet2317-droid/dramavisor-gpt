import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { normalizeAudio } from "@drama/media/audio/normalize";

import { OpenAiTranscriber } from "./openai-transcriber";

describe("OpenAiTranscriber", () => {
  it("chunks canonical WAV below the upload bound and offsets Whisper word timestamps globally", async () => {
    // Break caught: forwarding a long normalized take as one request can exceed the provider's 25 MB file limit.
    const requests: Array<{ model: string; responseFormat: string; timestampGranularity: string | null;
      fileSize: number }> = [];
    let primaryIndex = 0;
    let timingIndex = 0;
    const transcriber = new OpenAiTranscriber({
      apiKey: "test-key",
      maxUploadBytes: 76,
      fetch: async (_input, init) => {
        const form = init?.body as FormData;
        const model = String(form.get("model"));
        const file = form.get("file") as File;
        requests.push({
          model,
          responseFormat: String(form.get("response_format")),
          timestampGranularity: form.get("timestamp_granularities[]")?.toString() ?? null,
          fileSize: file.size,
        });
        if (model === "gpt-transcribe") {
          const index = primaryIndex++;
          return Response.json({ text: index === 0 ? "First" : "second", languages: [{ code: "en" }] });
        }
        const index = timingIndex++;
        return Response.json({
          task: "transcribe",
          language: "english",
          duration: 0.001,
          text: index === 0 ? "First" : "second",
          words: [{ word: index === 0 ? "First" : "second", start: 0, end: 0.001 }],
        });
      },
    });

    const result = await transcriber.transcribe({
      audio: canonicalWav(new Int16Array(32), 16_000),
      filename: "take.wav",
    });

    expect(requests).toEqual([
      { model: "gpt-transcribe", responseFormat: "json", timestampGranularity: null, fileSize: 76 },
      { model: "gpt-transcribe", responseFormat: "json", timestampGranularity: null, fileSize: 76 },
      { model: "whisper-1", responseFormat: "verbose_json", timestampGranularity: "word", fileSize: 76 },
      { model: "whisper-1", responseFormat: "verbose_json", timestampGranularity: "word", fileSize: 76 },
    ]);
    expect(result).toEqual({
      text: "First second",
      language: "en",
      words: [
        { text: "First", startMs: 0, endMs: 1, confidence: null },
        { text: "second", startMs: 1, endMs: 2, confidence: null },
      ],
      provider: "openai",
      modelName: "gpt-transcribe+whisper-1",
      transcriberVersion: "openai-transcription-v2",
      timingSource: "whisper_word_timestamps",
    });
  });

  it("retains safe codes for primary transcription provider failures", async () => {
    const input = { audio: canonicalWav(new Int16Array(2), 16_000), filename: "take.wav" };
    const unavailable = new OpenAiTranscriber({
      apiKey: "test-key", fetch: async () => new Response("bad request", { status: 400 }),
    });
    const offline = new OpenAiTranscriber({
      apiKey: "test-key", fetch: async () => { throw new TypeError("fetch failed"); },
    });

    await expect(unavailable.transcribe(input)).rejects.toMatchObject({
      name: "OpenAiTranscriptionHttpError", code: "OPENAI_TRANSCRIPTION_HTTP_400",
    });
    await expect(offline.transcribe(input)).rejects.toMatchObject({
      name: "OpenAiTranscriptionNetworkError", code: "OPENAI_TRANSCRIPTION_NETWORK_FAILURE",
    });
  });

  it("keeps primary text when the optional word-timing request fails", async () => {
    // Break caught: treating timing as mandatory would discard a usable primary transcript.
    const transcriber = new OpenAiTranscriber({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        const form = init?.body as FormData;
        if (form.get("model") === "whisper-1") return new Response("unavailable", { status: 503 });
        return Response.json({ text: "We begin", languages: [{ code: "en" }] });
      },
    });

    await expect(transcriber.transcribe({ audio: canonicalWav(new Int16Array(2), 16_000),
      filename: "take.wav" })).resolves.toMatchObject({
      text: "We begin",
      language: "en",
      words: [],
      modelName: "gpt-transcribe",
      timingSource: "unavailable",
    });
  });

  it("accepts real normalized FFmpeg WAV output containing non-audio RIFF chunks", async () => {
    // Break caught: assuming data starts at byte 44 rejects valid FFmpeg WAVs that contain a LIST chunk.
    const fixture = new Uint8Array(await readFile(new URL("../../../../fixtures/audio/alex-scene-clean.wav",
      import.meta.url)));
    const normalized = await normalizeAudio(fixture);
    const transcriber = new OpenAiTranscriber({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        const form = init?.body as FormData;
        return form.get("model") === "whisper-1"
          ? Response.json({ task: "transcribe", language: "english", duration: 0.6,
            text: "tone", words: [{ word: "tone", start: 0, end: 0.6 }] })
          : Response.json({ text: "tone", languages: [{ code: "en" }] });
      },
    });

    await expect(transcriber.transcribe({ audio: normalized, filename: "fixture.wav" }))
      .resolves.toMatchObject({ text: "tone", language: "en", timingSource: "whisper_word_timestamps" });
  });

  it("aggregates detected languages across every chunk and language entry", async () => {
    // Break caught: inspecting only the first detection can incorrectly approve a mixed-language take.
    let primaryIndex = 0;
    const transcriber = new OpenAiTranscriber({
      apiKey: "test-key",
      maxUploadBytes: 76,
      fetch: async (_input, init) => {
        const form = init?.body as FormData;
        if (form.get("model") === "whisper-1") throw new Error("timing unavailable");
        const languages = primaryIndex++ === 0 ? [{ code: "en" }] : [{ code: "en" }, { code: "es" }];
        return Response.json({ text: "words", languages });
      },
    });

    await expect(transcriber.transcribe({ audio: canonicalWav(new Int16Array(32), 16_000),
      filename: "take.wav" })).resolves.toMatchObject({ language: "mixed" });
  });

  it("uses a later English detection when an initial silent chunk has no detected language", async () => {
    // Break caught: treating the first empty language list as the take language creates a false unsupported result.
    let primaryIndex = 0;
    const transcriber = new OpenAiTranscriber({
      apiKey: "test-key",
      maxUploadBytes: 76,
      fetch: async (_input, init) => {
        const form = init?.body as FormData;
        if (form.get("model") === "whisper-1") throw new Error("timing unavailable");
        return Response.json({ text: "words", languages: primaryIndex++ === 0 ? [] : [{ code: "en" }] });
      },
    });

    await expect(transcriber.transcribe({ audio: canonicalWav(new Int16Array(32), 16_000),
      filename: "take.wav" })).resolves.toMatchObject({ language: "en" });
  });

  it("moves a bounded chunk boundary to silence and verifies prompt-echo deduplication", async () => {
    // Break caught: byte-exact cuts can split speech, while unverified aggregation can duplicate prompt echoes.
    const samples = new Int16Array(500).fill(8_000);
    samples.fill(0, 240, 256);
    const primaryRequests: Array<{ fileSize: number; prompt: string | null }> = [];
    let primaryIndex = 0;
    let timingIndex = 0;
    const transcriber = new OpenAiTranscriber({
      apiKey: "test-key",
      maxUploadBytes: 644,
      silenceSearchMs: 10,
      minimumSilenceMs: 1,
      fetch: async (_input, init) => {
        const form = init?.body as FormData;
        const file = form.get("file") as File;
        if (form.get("model") === "gpt-transcribe") {
          primaryRequests.push({ fileSize: file.size, prompt: form.get("prompt")?.toString() ?? null });
          return Response.json({
            text: ["We meet at", "at midnight", "midnight"][primaryIndex++]!,
            languages: [{ code: "en" }],
          });
        }
        const second = timingIndex++ === 1;
        return Response.json({ words: second
          ? [{ word: "midnight", start: 0.001, end: 0.003 }]
          : [{ word: "We", start: 0, end: 0.001 }, { word: "meet", start: 0.001, end: 0.002 },
            { word: "at", start: 0.002, end: 0.003 }] });
      },
    });

    const result = await transcriber.transcribe({ audio: canonicalWav(samples, 16_000), filename: "take.wav" });

    expect(primaryRequests).toEqual([
      { fileSize: 556, prompt: null },
      { fileSize: 532, prompt: "We meet at" },
      { fileSize: 532, prompt: null },
    ]);
    expect(result.text).toBe("We meet at midnight");
    expect(result.words.map(({ text }) => text)).toEqual(["We", "meet", "at", "midnight"]);
    expect(result.words.at(-1)).toMatchObject({ startMs: 17, endMs: 19, confidence: null });
    expect(result.timingSource).toBe("whisper_word_timestamps");
  });

  it("preserves a genuine repeated word spoken on both sides of a chunk boundary", async () => {
    // Break caught: blind suffix-prefix deduplication drops intentional repeated dialogue.
    let primaryIndex = 0;
    let timingIndex = 0;
    const transcriber = new OpenAiTranscriber({
      apiKey: "test-key",
      maxUploadBytes: 76,
      fetch: async (_input, init) => {
        const form = init?.body as FormData;
        if (form.get("model") === "gpt-transcribe") {
          return Response.json({ text: primaryIndex++ === 0 ? "no" : "no more",
            languages: [{ code: "en" }] });
        }
        return Response.json({ words: timingIndex++ === 0
          ? [{ word: "no", start: 0, end: 0.001 }]
          : [{ word: "no", start: 0, end: 0.001 }, { word: "more", start: 0.001, end: 0.002 }] });
      },
    });

    const result = await transcriber.transcribe({ audio: canonicalWav(new Int16Array(32), 16_000),
      filename: "take.wav" });

    expect(result.text).toBe("no no more");
    expect(result.words.map(({ text }) => text)).toEqual(["no", "no", "more"]);
  });

  it("preserves an uncertain repeated boundary word when Whisper omits its timing", async () => {
    // Break caught: missing timing is uncertainty, not proof that a repeated primary token is prompt echo.
    let primaryIndex = 0;
    let timingIndex = 0;
    const transcriber = new OpenAiTranscriber({
      apiKey: "test-key",
      maxUploadBytes: 76,
      fetch: async (_input, init) => {
        const form = init?.body as FormData;
        if (form.get("model") === "gpt-transcribe") {
          return Response.json({ text: primaryIndex++ === 0 ? "no" : "no more",
            languages: [{ code: "en" }] });
        }
        return Response.json({ words: timingIndex++ === 0
          ? [{ word: "no", start: 0, end: 0.001 }]
          : [{ word: "more", start: 0.001, end: 0.002 }] });
      },
    });

    const result = await transcriber.transcribe({ audio: canonicalWav(new Int16Array(32), 16_000),
      filename: "take.wav" });

    expect(result.text).toBe("no no more");
    expect(result.words).toEqual([
      { text: "no", startMs: 0, endMs: 1, confidence: null },
      { text: "no", startMs: null, endMs: null, confidence: null },
      { text: "more", startMs: 2, endMs: 3, confidence: null },
    ]);
    expect(result.timingSource).toBe("partial_whisper_word_timestamps");
  });

  it("maps canonical primary tokens only to matching Whisper timing evidence", async () => {
    // Break caught: persisting unrelated Whisper tokens attributes timing to words the canonical model did not say.
    const transcriber = new OpenAiTranscriber({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        const form = init?.body as FormData;
        if (form.get("model") === "gpt-transcribe") {
          return Response.json({ text: "We really begin brave world", languages: [{ code: "en" }] });
        }
        return Response.json({ words: [
          { word: "um", start: 0, end: 0.1 },
          { word: "We", start: 0.1, end: 0.2 },
          { word: "begin", start: 0.2, end: 0.3 },
          { word: "strange", start: 0.3, end: 0.4 },
          { word: "world", start: 0.4, end: 0.5 },
        ] });
      },
    });

    const result = await transcriber.transcribe({ audio: canonicalWav(new Int16Array(2), 16_000),
      filename: "take.wav" });

    expect(result.words).toEqual([
      { text: "We", startMs: 100, endMs: 200, confidence: null },
      { text: "really", startMs: null, endMs: null, confidence: null },
      { text: "begin", startMs: 200, endMs: 300, confidence: null },
      { text: "brave", startMs: null, endMs: null, confidence: null },
      { text: "world", startMs: 400, endMs: 500, confidence: null },
    ]);
    expect(result.timingSource).toBe("partial_whisper_word_timestamps");
  });

  it("normalizes punctuation identically in primary and Whisper words", async () => {
    // Break caught: ordinary punctuation attached to Whisper words must not erase valid timing evidence.
    const transcriber = new OpenAiTranscriber({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        const form = init?.body as FormData;
        return form.get("model") === "gpt-transcribe"
          ? Response.json({ text: "Hello, world.", languages: [{ code: "en" }] })
          : Response.json({ words: [
            { word: "Hello,", start: 0, end: 0.1 },
            { word: "world.", start: 0.1, end: 0.2 },
          ] });
      },
    });

    const result = await transcriber.transcribe({ audio: canonicalWav(new Int16Array(2), 16_000),
      filename: "take.wav" });

    expect(result.words).toEqual([
      { text: "Hello", startMs: 0, endMs: 100, confidence: null },
      { text: "world", startMs: 100, endMs: 200, confidence: null },
    ]);
    expect(result.timingSource).toBe("whisper_word_timestamps");
  });

  it("retains canonical tokens with unavailable timing when Whisper has no safe match", async () => {
    // Break caught: dropping all canonical tokens hides the exact region whose timing is unsupported.
    const transcriber = new OpenAiTranscriber({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        const form = init?.body as FormData;
        return form.get("model") === "gpt-transcribe"
          ? Response.json({ text: "canonical words", languages: [{ code: "en" }] })
          : Response.json({ words: [{ word: "different", start: 0, end: 0.1 }] });
      },
    });

    const result = await transcriber.transcribe({ audio: canonicalWav(new Int16Array(2), 16_000),
      filename: "take.wav" });

    expect(result.words).toEqual([
      { text: "canonical", startMs: null, endMs: null, confidence: null },
      { text: "words", startMs: null, endMs: null, confidence: null },
    ]);
    expect(result.timingSource).toBe("unavailable");
  });

  it("does not reuse one Whisper timestamp for ambiguous repeated canonical tokens", async () => {
    // Break caught: one timing word cannot be monotonically assigned to two primary transcript words.
    const transcriber = new OpenAiTranscriber({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        const form = init?.body as FormData;
        return form.get("model") === "gpt-transcribe"
          ? Response.json({ text: "no no", languages: [{ code: "en" }] })
          : Response.json({ words: [{ word: "no", start: 0, end: 0.1 }] });
      },
    });

    const result = await transcriber.transcribe({ audio: canonicalWav(new Int16Array(2), 16_000),
      filename: "take.wav" });

    expect(result.words).toEqual([
      { text: "no", startMs: null, endMs: null, confidence: null },
      { text: "no", startMs: null, endMs: null, confidence: null },
    ]);
    expect(result.timingSource).toBe("unavailable");
  });

  it("does not publish crossed Whisper timestamps as monotonic canonical evidence", async () => {
    // Break caught: independently valid LCS pairs can run backwards when model word order diverges.
    const transcriber = new OpenAiTranscriber({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        const form = init?.body as FormData;
        return form.get("model") === "gpt-transcribe"
          ? Response.json({ text: "a b", languages: [{ code: "en" }] })
          : Response.json({ words: [
            { word: "b", start: 0, end: 0.1 },
            { word: "a", start: 0.1, end: 0.2 },
          ] });
      },
    });

    const result = await transcriber.transcribe({ audio: canonicalWav(new Int16Array(2), 16_000),
      filename: "take.wav" });

    expect(result.words).toEqual([
      { text: "a", startMs: null, endMs: null, confidence: null },
      { text: "b", startMs: null, endMs: null, confidence: null },
    ]);
    expect(result.timingSource).toBe("unavailable");
  });
});

function canonicalWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.byteLength);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  writeAscii(bytes, 8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, samples.byteLength, true);
  bytes.set(new Uint8Array(samples.buffer), 44);
  return bytes;
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) target[offset + index] = value.charCodeAt(index);
}
