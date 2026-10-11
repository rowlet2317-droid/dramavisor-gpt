import { describe, expect, it } from "vitest";

import { measureCoachingLatency, runCoachingLatencyHarness } from "./coaching-latency";
import { measureRealtimeLatency } from "./realtime-latency";

describe("acceptance latency harnesses", () => {
  it("requires at least thirty recorded realtime turns and reports median/p95", () => {
    const turns = Array.from({ length: 30 }, (_, index) => ({ actorLineEndedAtMs: index * 10_000,
      partnerFirstAudioAtMs: index * 10_000 + 1_000 + index }));
    expect(measureRealtimeLatency(turns)).toEqual({ turns: 30, medianMs: 1_014, p95Ms: 1_028 });
    expect(() => measureRealtimeLatency(turns.slice(0, 29))).toThrow("at least 30");
  });

  it("requires exactly ten consented five-minute fixtures and reports the ninety-second fraction", () => {
    const fixtures = Array.from({ length: 10 }, (_, index) => ({ fixtureId: `${index}`, consented: true,
      durationSeconds: 300, uploadedAtMs: 0, completedAtMs: index < 9 ? 90_000 : 90_001 }));
    expect(measureCoachingLatency(fixtures)).toMatchObject({ fixtures: 10, within90Seconds: 9,
      within90SecondsFraction: 0.9 });
    expect(() => measureCoachingLatency(fixtures.slice(0, 9))).toThrow("exactly ten");
  });

  it("sends every one of the ten accepted fixtures through the supplied uploader", async () => {
    const fixtures = Array.from({ length: 10 }, (_, index) => ({ fixtureId: `${index}`, consented: true,
      durationSeconds: 300 }));
    const uploaded: string[] = [];

    const result = await runCoachingLatencyHarness(fixtures, async (fixture) => {
      uploaded.push(fixture.fixtureId);
      return { uploadedAtMs: 0, completedAtMs: 90_000 };
    }, "/tmp/dramavisor-acceptance-harness-test");

    expect(uploaded).toEqual(fixtures.map(({ fixtureId }) => fixtureId));
    expect(result.within90SecondsFraction).toBe(1);
  });
});
