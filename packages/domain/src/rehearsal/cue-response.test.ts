import { describe, expect, it } from "vitest";

import { measureCueResponse, type CueResponseTimeline } from "./cue-response";

describe("measureCueResponse", () => {
  it("measures matching acknowledged provider timestamps on one rehearsal clock", () => {
    // Break caught: provider-derived completion timestamps can be discarded or scored nondeterministically.
    expect(measureCueResponse(timeline())).toEqual({
      version: "cue-response-v1",
      cueEventId: "cue-finished",
      actorEventId: "actor-finished",
      clockId: "browser:rehearsal-1",
      delayMs: 740,
      confidence: "high",
      score: 85,
    });
  });

  it.each([
    { delayMs: 0, want: 100 },
    { delayMs: 500, want: 100 },
    { delayMs: 501, want: 85 },
    { delayMs: 1_000, want: 85 },
    { delayMs: 1_001, want: 70 },
    { delayMs: 1_500, want: 70 },
    { delayMs: 1_501, want: 55 },
    { delayMs: 2_500, want: 55 },
    { delayMs: 2_501, want: 40 },
    { delayMs: 30_000, want: 40 },
  ])("maps $delayMs ms to the literal cue-response-v1 score $want", ({ delayMs, want }) => {
    // Break caught: moving or interpolating a threshold changes a published deterministic rating.
    expect(measureCueResponse(timeline({ actorAtMs: 10_000 + delayMs })).score).toBe(want);
  });

  it("uses medium confidence for two server-receipt timestamps on the same clock", () => {
    // Break caught: server receipts must not be upgraded to provider confidence or discarded when both are comparable.
    expect(measureCueResponse(timeline({ source: "server-receipt", clockId: "server:rehearsal-1" })))
      .toMatchObject({ delayMs: 740, confidence: "medium", score: 85, clockId: "server:rehearsal-1" });
  });

  it("pairs an actor completion with the latest matching cue after a restarted line", () => {
    // Break caught: choosing the first cue after a restart attributes the response to obsolete playback.
    const input = timeline();
    input.events.splice(1, 0, { id: "cue-restarted", sequence: 2, type: "ai_speech_finished",
      elementId: "line-cue", timestamp: { atMs: 20_000, source: "provider-derived",
        clockId: "browser:rehearsal-1" } });
    input.events[2] = { ...input.events[2]!, sequence: 3,
      timestamp: { atMs: 20_740, source: "provider-derived", clockId: "browser:rehearsal-1" } };

    expect(measureCueResponse(input)).toMatchObject({
      cueEventId: "cue-restarted", actorEventId: "actor-finished", delayMs: 740, score: 85,
    });
  });

  it.each([
    { name: "missing cue", input: timeline({ omitCue: true }), cueEventId: null, actorEventId: "actor-finished" },
    { name: "missing actor", input: timeline({ omitActor: true }), cueEventId: "cue-finished", actorEventId: null },
    { name: "missing timestamp", input: timeline({ actorTimestampMissing: true }),
      cueEventId: "cue-finished", actorEventId: "actor-finished" },
    { name: "mixed timestamp sources", input: timeline({ actorSource: "server-receipt" }),
      cueEventId: "cue-finished", actorEventId: "actor-finished" },
    { name: "different clocks", input: timeline({ actorClockId: "browser:other-rehearsal" }),
      cueEventId: "cue-finished", actorEventId: "actor-finished" },
    { name: "wrong cue element", input: timeline({ cueElementId: "line-other" }),
      cueEventId: null, actorEventId: "actor-finished" },
    { name: "wrong actor element", input: timeline({ actorElementId: "line-other" }),
      cueEventId: "cue-finished", actorEventId: null },
    { name: "reversed sequence", input: timeline({ actorSequence: 1, cueSequence: 2 }),
      cueEventId: "cue-finished", actorEventId: "actor-finished" },
    { name: "reversed timestamps", input: timeline({ actorAtMs: 9_999 }),
      cueEventId: "cue-finished", actorEventId: "actor-finished" },
  ])("returns low/null evidence for $name", ({ input, cueEventId, actorEventId }) => {
    // Break caught: incomplete or incomparable timing must never produce an actionable score.
    expect(measureCueResponse(input)).toEqual({
      version: "cue-response-v1", cueEventId, actorEventId, clockId: null,
      delayMs: null, confidence: "low", score: null,
    });
  });
});

function timeline(options: {
  cueAtMs?: number;
  actorAtMs?: number;
  cueSequence?: number;
  actorSequence?: number;
  source?: "provider-derived" | "server-receipt";
  actorSource?: "provider-derived" | "server-receipt";
  clockId?: string;
  actorClockId?: string;
  cueElementId?: string;
  actorElementId?: string;
  actorTimestampMissing?: boolean;
  omitCue?: boolean;
  omitActor?: boolean;
} = {}): CueResponseTimeline {
  const source = options.source ?? "provider-derived";
  const clockId = options.clockId ?? "browser:rehearsal-1";
  const events: CueResponseTimeline["events"] = [];
  if (!options.omitCue) events.push({ id: "cue-finished", sequence: options.cueSequence ?? 1,
    type: "ai_speech_finished", elementId: options.cueElementId ?? "line-cue",
    timestamp: { atMs: options.cueAtMs ?? 10_000, source, clockId } });
  if (!options.omitActor) events.push({ id: "actor-finished", sequence: options.actorSequence ?? 2,
    type: "actor_line_completed", elementId: options.actorElementId ?? "line-actor",
    timestamp: options.actorTimestampMissing ? null : { atMs: options.actorAtMs ?? 10_740,
      source: options.actorSource ?? source, clockId: options.actorClockId ?? clockId } });
  return { cueElementId: "line-cue", actorElementId: "line-actor", events };
}
