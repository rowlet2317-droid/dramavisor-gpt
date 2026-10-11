import { describe, expect, it, vi } from "vitest";

import { runRealtimeSmoke } from "./smoke-realtime";

describe("realtime provider smoke command", () => {
  it("records a credential-free run as skipped without failing", async () => {
    const output = vi.fn();

    const result = await runRealtimeSmoke({ environment: {}, output });

    expect(result).toBe(0);
    expect(output).toHaveBeenCalledWith("Realtime smoke: SKIPPED (OPENAI_API_KEY is unset)");
  });

  it("reports model and expiry without printing the ephemeral secret", async () => {
    const lines: string[] = [];

    const result = await runRealtimeSmoke({ environment: { OPENAI_API_KEY: "server-key",
      REALTIME_MODEL: "gpt-realtime-2.1" }, output: (line) => lines.push(line),
      issue: async () => ({ clientSecret: "ek_private", expiresAt: "2026-08-23T00:50:00.000Z",
        model: "gpt-realtime-2.1" }) });

    expect(result).toBe(0);
    expect(lines).toEqual(["Realtime smoke: PASSED (gpt-realtime-2.1, expires 2026-08-23T00:50:00.000Z)"]);
    expect(lines.join(" ")).not.toContain("ek_private");
  });
});
