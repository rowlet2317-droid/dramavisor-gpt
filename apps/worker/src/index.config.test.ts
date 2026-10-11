import { describe, expect, it } from "vitest";

import { loadCoachingModel } from "./index";

describe("coaching model configuration", () => {
  it("defaults to GPT-5.6 independently of the general analysis model", () => {
    expect(loadCoachingModel({ ANALYSIS_MODEL: "gpt-5.4" })).toBe("gpt-5.6");
  });

  it("accepts a configured GPT-5.6-family model", () => {
    expect(loadCoachingModel({ COACHING_MODEL: "gpt-5.6-pro" })).toBe("gpt-5.6-pro");
  });

  it("rejects a coaching override outside the required model family", () => {
    expect(() => loadCoachingModel({ COACHING_MODEL: "gpt-5.4" }))
      .toThrow("COACHING_MODEL must be a GPT-5.6-family model");
  });
});
