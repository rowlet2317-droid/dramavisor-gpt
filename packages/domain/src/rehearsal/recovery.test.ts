import { describe, expect, it } from "vitest";

import { createRehearsalState } from "./controller";
import { recoverSession } from "./recovery";
import type { PersistedRehearsalEvent } from "./types";

const initialState = createRehearsalState({ sessionId: "session_1", actorRoleId: "actor",
  lines: [
    { elementId: "line_1", ordinal: 1, characterId: "alex", text: "First." },
    { elementId: "line_2", ordinal: 2, characterId: "actor", text: "Second." },
    { elementId: "line_3", ordinal: 3, characterId: "alex", text: "Third." },
    { elementId: "line_4", ordinal: 4, characterId: "actor", text: "Fourth." },
  ] });

describe("recoverSession", () => {
  it("resumes from the last acknowledged scene element and replays unseen server events", () => {
    const events: PersistedRehearsalEvent[] = [
      { type: "started", sequence: 1, startedAtMs: 100 },
      { type: "ai_speech_started", sequence: 2, characterId: "alex", elementId: "line_1", startedAtMs: 110 },
      { type: "ai_speech_finished", sequence: 3, characterId: "alex", elementId: "line_1", endedAtMs: 120 },
      { type: "actor_line_final", sequence: 4, text: "Second.", endedAtMs: 130 },
      { type: "ai_speech_started", sequence: 5, characterId: "alex", elementId: "line_3", startedAtMs: 140 },
      { type: "ai_speech_finished", sequence: 6, characterId: "alex", elementId: "line_3", endedAtMs: 150 },
      { type: "connection_lost", sequence: 7, reason: "failed" },
    ];

    const decision = recoverSession(initialState, events, { clientLastSequence: 5,
      serverLastSequence: 7, expectedPlayModelVersion: 3, serverPlayModelVersion: 3 });

    expect(decision).toMatchObject({ kind: "resume", cursorElementId: "line_4", lastSequence: 7 });
    expect(decision.replayEventSequences).toEqual([6, 7]);
  });

  it("refuses to combine recovery events with a different play model version", () => {
    const decision = recoverSession(initialState,
      [{ type: "started", sequence: 1, startedAtMs: 100 }],
      { clientLastSequence: 0, serverLastSequence: 1,
        expectedPlayModelVersion: 3, serverPlayModelVersion: 4 });

    expect(decision).toMatchObject({ kind: "end_and_save", reason: "play_model_changed",
      cursorElementId: "line_1", lastSequence: 1, replayEventSequences: [1] });
  });

  it("rejects an incomplete or nonmonotonic server event history", () => {
    expect(() => recoverSession(initialState,
      [{ type: "started", sequence: 2, startedAtMs: 100 }],
      { clientLastSequence: 0, serverLastSequence: 2,
        expectedPlayModelVersion: 3, serverPlayModelVersion: 3 })).toThrow(/sequence 1/);
  });
});
