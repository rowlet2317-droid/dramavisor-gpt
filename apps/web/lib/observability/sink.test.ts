import { describe, expect, it, vi } from "vitest";

import { emitOperationalEvent } from "./sink";

describe("operational event sink", () => {
  it("serializes only allowlisted event metadata and safe error codes", () => {
    const sink = vi.fn();
    emitOperationalEvent({ type: "realtime.provider_failure", state: "failed", userId: "user-1",
      sessionId: "session-1", error: Object.assign(new Error("secret transcript and prompt"), {
        code: "PROVIDER_UNAVAILABLE", stack: "credential=secret", providerBody: { audio: "private" },
        transcript: "private transcript", message: "private message",
      }) }, sink, "test-salt");

    const line = sink.mock.calls[0]![0] as string;
    expect(JSON.parse(line)).toEqual({ type: "realtime.provider_failure", fields: {
      state: "failed", eventCode: "PROVIDER_UNAVAILABLE",
      userHash: expect.stringMatching(/^[a-f0-9]{64}$/), sessionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    } });
    for (const secret of ["secret", "transcript", "prompt", "credential", "private message", "audio"]) {
      expect(line).not.toContain(secret);
    }
  });

  it("drops unknown event types, states, and unsafe error strings", () => {
    const sink = vi.fn();
    emitOperationalEvent({ type: "worker.failed", state: "retrying", error: { code: "provider says secret" } }, sink);
    expect(sink).not.toHaveBeenCalled();
  });
});
