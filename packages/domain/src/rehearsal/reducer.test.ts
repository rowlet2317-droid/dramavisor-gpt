import { describe, expect, it } from "vitest";

import { createRehearsalState } from "./controller";
import { reduceRehearsal } from "./reducer";

const lines = [
  { elementId: "line_1", ordinal: 1, characterId: "actor", text: "A" },
  { elementId: "line_2", ordinal: 2, characterId: "role", text: "B" },
  { elementId: "line_3", ordinal: 3, characterId: "actor", text: "C" },
];

describe("rehearsal interruption reduction", () => {
  it("restores an active pending action only after a disconnected resume is acknowledged", () => {
    const started = reduceRehearsal(createRehearsalState({ sessionId: "session_1", actorRoleId: "actor", lines }),
      { type: "started", sequence: 1, startedAtMs: 0 });
    const disconnected = reduceRehearsal(started,
      { type: "connection_lost", sequence: 2, reason: "network" });

    expect(disconnected).toMatchObject({ status: "disconnected", cursorElementId: "line_1",
      pendingAction: null, lastSequence: 2 });

    const resumed = reduceRehearsal(disconnected, { type: "resumed", sequence: 3 });

    expect(resumed).toMatchObject({ status: "active", cursorElementId: "line_1",
      pendingAction: { type: "listen", elementId: "line_1" }, lastSequence: 3 });
  });

  it("waits for explicit Continue and ignores late speech completion while awaiting the choice", () => {
    const started = reduceRehearsal(createRehearsalState({ sessionId: "session_1", actorRoleId: "actor", lines }),
      { type: "started", sequence: 1, startedAtMs: 0 });
    const speaking = reduceRehearsal(started,
      { type: "actor_line_final", sequence: 2, text: "A", endedAtMs: 10 });
    const interrupted = reduceRehearsal(speaking,
      { type: "interrupted", sequence: 3, elementId: "line_2", atMs: 20 });

    expect(interrupted).toMatchObject({ status: "await_interruption_choice", cursorElementId: "line_2",
      pendingAction: { type: "await_interruption_choice", elementId: "line_2" } });

    const lateCompletion = reduceRehearsal(interrupted, { type: "ai_speech_finished", sequence: 4,
      characterId: "role", elementId: "line_2", endedAtMs: 21 });
    expect(lateCompletion).toMatchObject({ status: "await_interruption_choice", cursorElementId: "line_2" });

    const continued = reduceRehearsal(lateCompletion,
      { type: "continue_after_interruption", sequence: 5, elementId: "line_2" });
    expect(continued).toMatchObject({ status: "active", cursorElementId: "line_3",
      pendingAction: { type: "listen", elementId: "line_3" } });
  });

  it("advances a matching actor cursor after explicit manual completion", () => {
    const started = reduceRehearsal(createRehearsalState({ sessionId: "session_1", actorRoleId: "actor", lines }),
      { type: "started", sequence: 1, startedAtMs: 0 });

    const completed = reduceRehearsal(started,
      { type: "manual_actor_line_completed", sequence: 2, elementId: "line_1", endedAtMs: 20 });

    expect(completed).toMatchObject({ status: "active", cursorElementId: "line_2",
      pendingAction: { type: "speak", elementId: "line_2", characterId: "role" } });
  });

  it("requests the same interrupted AI element after explicit Restart Line", () => {
    const started = reduceRehearsal(createRehearsalState({ sessionId: "session_1", actorRoleId: "actor", lines }),
      { type: "started", sequence: 1, startedAtMs: 0 });
    const speaking = reduceRehearsal(started,
      { type: "actor_line_final", sequence: 2, text: "A", endedAtMs: 10 });
    const interrupted = reduceRehearsal(speaking,
      { type: "interrupted", sequence: 3, elementId: "line_2", atMs: 20 });

    const restarted = reduceRehearsal(interrupted,
      { type: "restart_line", sequence: 4, elementId: "line_2" });

    expect(restarted).toMatchObject({ status: "active", cursorElementId: "line_2",
      pendingAction: { type: "speak", elementId: "line_2", characterId: "role" } });
  });

  it("does not let Cue, Restart Beat, or Resume bypass an interruption choice", () => {
    const started = reduceRehearsal(createRehearsalState({ sessionId: "session_1", actorRoleId: "actor", lines }),
      { type: "started", sequence: 1, startedAtMs: 0 });
    const speaking = reduceRehearsal(started,
      { type: "actor_line_final", sequence: 2, text: "A", endedAtMs: 10 });
    const interrupted = reduceRehearsal(speaking,
      { type: "interrupted", sequence: 3, elementId: "line_2", atMs: 20 });

    const afterCue = reduceRehearsal(interrupted, { type: "cue_requested", sequence: 4 });
    const afterRestart = reduceRehearsal(afterCue,
      { type: "restart_requested", sequence: 5, elementId: "line_1" });
    const afterResume = reduceRehearsal(afterRestart, { type: "resumed", sequence: 6 });

    expect(afterResume).toMatchObject({
      lastSequence: 6,
      status: "await_interruption_choice",
      cursorElementId: "line_2",
      pendingAction: { type: "await_interruption_choice", elementId: "line_2" },
    });
  });
});
