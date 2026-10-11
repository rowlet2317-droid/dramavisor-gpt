import { describe, expect, it, vi } from "vitest";

import { chunkAudioReviewRequest, OpenAiAudioReviewer } from "./openai-audio-review";

const request = {
  audio: new Uint8Array([82, 73, 70, 70]),
  durationMs: 2_000,
  sceneObjective: "Make Jordan stay.",
  selectedInterpretation: "The plea is disguised as a joke.",
  lines: [
    { elementId: "line-1", text: "You could stay a little longer." },
    { elementId: "line-2", text: "No one would mind." },
  ],
};

describe("OpenAiAudioReviewer", () => {
  it("sends bounded WAV audio and grounded dramatic context to gpt-audio-1.5", async () => {
    const fetch = responseFetch({ observations: [{
      startMs: 200,
      endMs: 900,
      description: "The final word is audibly quieter than the opening words.",
      confidence: "high",
      elementIds: ["line-1"],
    }] });

    const observations = await reviewer(fetch).review(request);

    expect(observations).toEqual([{
      id: "audio-1",
      kind: "audio_observation",
      startMs: 200,
      endMs: 900,
      description: "The final word is audibly quieter than the opening words.",
      confidence: "high",
      elementIds: ["line-1"],
    }]);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("gpt-audio-1.5");
    expect(body.modalities).toEqual(["text"]);
    expect(body.response_format).toBeUndefined();
    expect(body.tools[0].function.name).toBe("submit_audio_observations");
    expect(body.tools[0].function.strict).toBe(true);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "submit_audio_observations" } });
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.messages[0].content).toContainEqual({
      type: "input_audio",
      input_audio: { data: "UklGRg==", format: "wav" },
    });
    const prompt = body.messages[0].content.find(({ type }: { type: string }) => type === "text").text;
    expect(prompt).toContain(request.sceneObjective);
    expect(prompt).toContain(request.selectedInterpretation);
    expect(prompt).toContain("line-1 [?-? ms]: You could stay a little longer.");
    expect(prompt).toContain("Do not assign a global acting-quality score");
  });

  it("retains safe codes for audio-review provider failures", async () => {
    const unavailableFetch: typeof globalThis.fetch = async () =>
      new Response("bad request", { status: 400 });
    const offlineFetch: typeof globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const unavailable = reviewer(unavailableFetch);
    const offline = reviewer(offlineFetch);

    await expect(unavailable.review(request)).rejects.toMatchObject({
      name: "OpenAiAudioReviewHttpError", code: "OPENAI_AUDIO_REVIEW_HTTP_400",
    });
    await expect(offline.review(request)).rejects.toMatchObject({
      name: "OpenAiAudioReviewNetworkError", code: "OPENAI_AUDIO_REVIEW_NETWORK_FAILURE",
    });
  });

  it("accepts JSON returned inside a Markdown code fence", async () => {
    const fetch = vi.fn(async () => Response.json({
      choices: [{ message: { content: "```json\n{\"observations\":[]}\n```" } }],
    })) as unknown as typeof globalThis.fetch;

    await expect(reviewer(fetch).review(request)).resolves.toEqual([]);
  });

  it("normalizes harmless extra fields and numeric-string timestamps from audio model output", async () => {
    const fetch = responseFetch({ observations: [{
      id: "provider-chosen-id", kind: "audio_observation", startMs: "200.4", endMs: "900.2",
      description: "The ending becomes quieter.", confidence: "medium", elementIds: ["line-1"],
    }], commentary: "extra provider metadata" });

    await expect(reviewer(fetch).review(request)).resolves.toEqual([{
      id: "audio-1", kind: "audio_observation", startMs: 200, endMs: 900,
      description: "The ending becomes quieter.", confidence: "medium", elementIds: ["line-1"],
    }]);
  });

  it("accepts common field aliases and second-based timestamps", async () => {
    const fetch = responseFetch({ audio_observations: [{
      start_seconds: "0.2", end_seconds: 0.9, observation: "The ending becomes quieter.",
      confidence: "HIGH", element_ids: ["line-1"],
    }] });

    await expect(reviewer(fetch).review(request)).resolves.toEqual([expect.objectContaining({
      startMs: 200, endMs: 900, description: "The ending becomes quieter.", confidence: "high",
      elementIds: ["line-1"],
    })]);
  });

  it("retries an invalid chunk response before failing the audio review", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "not JSON" } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { tool_calls: [{ type: "function",
        function: { name: "submit_audio_observations", arguments: JSON.stringify({ observations: [] }) },
      }] } }] }));

    await expect(reviewer(fetch as unknown as typeof globalThis.fetch).review(request)).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps valid later chunks when one chunk remains malformed", async () => {
    const malformed = Response.json({ choices: [{ message: { content: "not JSON" } }] });
    const valid = Response.json({ choices: [{ message: { tool_calls: [{ type: "function", function: {
      name: "submit_audio_observations", arguments: JSON.stringify({ observations: [{ startMs: 500, endMs: 1_500,
        description: "The later line is audible.", confidence: "high", elementIds: ["line-2"] }] }),
    } }] } }] });
    const fetch = vi.fn()
      .mockResolvedValueOnce(malformed)
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "still not JSON" } }] }))
      .mockResolvedValueOnce(valid);

    const result = await reviewer(fetch as unknown as typeof globalThis.fetch).review({
      ...request, audio: wav(60_000), durationMs: 60_000,
      lines: [
        { elementId: "line-1", text: "Opening.", startMs: 1_000, endMs: 2_000 },
        { elementId: "line-2", text: "Later line.", startMs: 35_000, endMs: 36_000 },
      ],
    });

    expect(result).toEqual([expect.objectContaining({
      startMs: 35_000, endMs: 36_000, elementIds: ["line-2"],
    })]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("classifies malformed model output without collapsing it to JOB_FAILURE", async () => {
    const fetch = vi.fn(async () => Response.json({
      choices: [{ message: { content: "not JSON" } }],
    })) as unknown as typeof globalThis.fetch;

    await expect(reviewer(fetch).review(request)).rejects.toMatchObject({
      name: "InvalidAudioReviewOutputError", code: "INVALID_AUDIO_REVIEW_OUTPUT",
    });
  });

  it("rejects observations outside the take duration", async () => {
    const fetch = responseFetch({ observations: [{
      startMs: 1_500, endMs: 2_001, description: "Late event.",
      confidence: "medium", elementIds: ["line-2"],
    }] });

    await expect(reviewer(fetch).review(request)).rejects.toThrow("OBSERVATION_OUT_OF_BOUNDS");
  });

  it("uses cited line boundaries when the model returns out-of-bounds timestamps", async () => {
    const fetch = responseFetch({ observations: [{
      startMs: 35_000, endMs: 36_000, description: "Audible event.",
      confidence: "medium", elementIds: ["line-2"],
    }] });

    await expect(reviewer(fetch).review({ ...request, lines: [
      { ...request.lines[1]!, startMs: 500, endMs: 1_500 },
    ] })).resolves.toEqual([expect.objectContaining({ startMs: 500, endMs: 1_500 })]);
  });

  it("clamps cited line timing to the decoded chunk boundary", async () => {
    const fetch = responseFetch({ observations: [{
      startMs: 35_000, endMs: 36_000, description: "Audible event.",
      confidence: "medium", elementIds: ["line-2"],
    }] });

    await expect(reviewer(fetch).review({ ...request, lines: [
      { ...request.lines[1]!, startMs: 1_500, endMs: 2_500 },
    ] })).resolves.toEqual([expect.objectContaining({ startMs: 1_500, endMs: 2_000 })]);
  });

  it("rejects observations that cite unknown script elements", async () => {
    const fetch = responseFetch({ observations: [{
      startMs: 100, endMs: 200, description: "Audible event.",
      confidence: "medium", elementIds: ["invented-line"],
    }] });

    await expect(reviewer(fetch).review(request)).rejects.toThrow("UNKNOWN_OBSERVATION_ELEMENT");
  });

  it("ignores unrelated top-level commentary from an otherwise grounded response", async () => {
    const fetch = responseFetch({ observations: [], globalScore: 92 });

    await expect(reviewer(fetch).review(request)).resolves.toEqual([]);
  });

  it("does not upload audio beyond the configured byte bound", async () => {
    const fetch = responseFetch({ observations: [] });
    const bounded = reviewer(fetch, { maxAudioBytes: 3 });

    await expect(bounded.review(request)).rejects.toThrow("AUDIO_REVIEW_INPUT_TOO_LARGE");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("splits a six-minute take around every timed line instead of reviewing only the opening", () => {
    const chunks = chunkAudioReviewRequest({ ...request, audio: wav(366_000), durationMs: 360_000,
      lines: [
        { elementId: "line-1", text: "Opening.", startMs: 1_000, endMs: 2_000 },
        { elementId: "line-2", text: "Later line.", startMs: 365_000, endMs: 366_500 },
      ] });

    expect(chunks).toHaveLength(2);
    expect(chunks.map(({ offsetMs }) => offsetMs)).toEqual([500, 364_500]);
    expect(chunks.map(({ request: chunk }) => chunk.lines.map(({ elementId }) => elementId)))
      .toEqual([["line-1"], ["line-2"]]);
    expect(chunks.map(({ request: chunk }) => chunk.durationMs)).toEqual([2_000, 1_500]);
  });
});

function reviewer(fetch: typeof globalThis.fetch, overrides: { maxAudioBytes?: number } = {}) {
  return new OpenAiAudioReviewer({ apiKey: "test-key", fetch, ...overrides });
}

function responseFetch(value: unknown) {
  return vi.fn(async () => Response.json({
    choices: [{ message: { tool_calls: [{
      type: "function",
      function: { name: "submit_audio_observations", arguments: JSON.stringify(value) },
    }] } }],
  })) as unknown as ReturnType<typeof vi.fn> & typeof globalThis.fetch;
}

function wav(durationMs: number, sampleRate = 1_000): Uint8Array {
  const samples = Math.round(durationMs * sampleRate / 1_000);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  bytes.set([82, 73, 70, 70], 0); view.setUint32(4, bytes.length - 8, true); bytes.set([87, 65, 86, 69], 8);
  bytes.set([102, 109, 116, 32], 12); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); bytes.set([100, 97, 116, 97], 36);
  view.setUint32(40, samples * 2, true);
  return bytes;
}
