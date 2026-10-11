import { describe, expect, it, vi } from "vitest";

import { runProviderSmoke } from "./provider-smoke";

describe("provider smoke command", () => {
  it("records a credential-free run as skipped without failing", async () => {
    const output = vi.fn();

    const result = await runProviderSmoke({ environment: {}, args: ["fixtures/plays/two-scene-play.txt"], output });

    expect(result).toBe(0);
    expect(output).toHaveBeenCalledWith("Provider smoke: SKIPPED (OPENAI_API_KEY is unset)");
  });
});
