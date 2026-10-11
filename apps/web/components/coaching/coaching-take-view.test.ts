import { describe, expect, it } from "vitest";

import { coachingFailureMessage, coachingLimitationMessage } from "./coaching-take-view";

describe("coaching failure messaging", () => {
  it("shows the safe provider status needed to diagnose a failed take", () => {
    expect(coachingFailureMessage("OPENAI_COACHING_HTTP_400"))
      .toContain("HTTP 400");
  });

  it("states when an older take did not retain a failure code", () => {
    expect(coachingFailureMessage(null)).toContain("No failure code was recorded");
  });

  it("does not hide an unexpected worker failure code", () => {
    expect(coachingFailureMessage("JOB_FAILURE")).toContain("JOB_FAILURE");
  });
});

describe("coaching limitation messaging", () => {
  it("does not claim audio was unavailable when audio review completed", () => {
    expect(coachingLimitationMessage("completed")).toContain("generated coaching interpretation");
    expect(coachingLimitationMessage("completed")).not.toContain("Audio interpretation was unavailable");
  });

  it("identifies an actual audio review failure", () => {
    expect(coachingLimitationMessage("failed")).toContain("Audio interpretation was unavailable");
  });
});
