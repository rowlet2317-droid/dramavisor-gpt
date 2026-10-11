import { describe, expect, it } from "vitest";

import { redactOperationalEvent } from "./redact";

describe("redactOperationalEvent", () => {
  it("retains only operational metadata and hashes user/session identifiers", () => {
    const event = redactOperationalEvent("account.delete", {
      playId: "play-1",
      state: "deleting",
      durationMs: 120,
      byteCount: 2048,
      modelId: "gpt-realtime-2.1",
      retryCount: 2,
      userId: "user-1",
      sessionId: "session-1",
    }, "test-salt");

    expect(event).toEqual({
      type: "account.delete",
      fields: {
        playId: "play-1",
        state: "deleting",
        durationMs: 120,
        byteCount: 2048,
        modelId: "gpt-realtime-2.1",
        retryCount: 2,
        userHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        sessionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("drops every forbidden content and provider field before serialization", () => {
    const event = redactOperationalEvent("worker.failed", {
      transcriptText: "private transcript",
      transcript: "private transcript",
      scriptText: "private script",
      script: "private script",
      actorNotes: "private notes",
      notes: "private notes",
      modelPrompt: "private prompt",
      prompt: "private prompt",
      audioBytes: "private audio",
      audio: "private audio",
      credential: "secret",
      apiKey: "secret",
      providerRequestBody: { private: true },
      requestBody: { private: true },
      nested: { transcript: "still private" },
      state: "retrying",
    }, "test-salt");

    const serialized = JSON.stringify(event);
    for (const value of ["private transcript", "private script", "private notes", "private prompt",
      "private audio", "secret", "providerRequestBody", "requestBody", "nested"]) {
      expect(serialized).not.toContain(value);
    }
    expect(event.fields).toEqual({ state: "retrying" });
  });
});
