import { describe, expect, it } from "vitest";

import { createRehearsalState } from "./controller";
import { RehearsalSequenceError, reduceRehearsal } from "./reducer";

const actorRoleId = "char_actor";
const lines = [
  { elementId: "line_0001", ordinal: 1, characterId: actorRoleId, text: "We begin." },
  { elementId: "line_0002", ordinal: 2, characterId: "char_bea", text: "At last." },
  { elementId: "line_0003", ordinal: 3, characterId: actorRoleId, text: "I thought you had gone." },
  { elementId: "line_0004", ordinal: 4, characterId: "char_bea", text: "Never." },
  { elementId: "line_0005", ordinal: 5, characterId: actorRoleId, text: "Then stay beside me." },
  { elementId: "line_0006", ordinal: 6, characterId: "char_bea", text: "I will." },
  { elementId: "line_0007", ordinal: 7, characterId: actorRoleId, text: "Do not leave again." },
];

describe("rehearsal controller", () => {
  it("advances to the next AI line after the actor completes a matched line", () => {
    const initial = activeState();

    const next = reduceRehearsal(initial, { type: "actor_line_final", sequence: 2,
      text: "We begin.", endedAtMs: 1_200 });

    expect(next.cursorElementId).toBe("line_0002");
    expect(next.pendingAction).toEqual({ type: "speak", elementId: "line_0002", characterId: "char_bea" });
  });

  it("returns a cue without advancing scene position", () => {
    const initial = activeState();

    const next = reduceRehearsal(initial, { type: "cue_requested", sequence: 2 });

    expect(next.pendingAction).toEqual({ type: "show_cue", elementId: "line_0001" });
    expect(next.cursorElementId).toBe("line_0001");
  });

  it("recovers to an exact later actor line only when intervening actor lines are clear nonmatches", () => {
    const initial = activeState();

    const next = reduceRehearsal(initial, { type: "actor_line_final", sequence: 2,
      text: "Then stay beside me.", endedAtMs: 2_400 });

    expect(next.omittedElementIds).toEqual(["line_0001", "line_0003"]);
    expect(next.cursorElementId).toBe("line_0006");
    expect(next.pendingAction).toEqual({ type: "speak", elementId: "line_0006", characterId: "char_bea" });
  });

  it("requires explicit position confirmation when transcript evidence is ambiguous", () => {
    const initial = activeState();

    const next = reduceRehearsal(initial, { type: "actor_line_final", sequence: 2,
      text: "I thought we should begin and stay.", endedAtMs: 2_400 });

    expect(next.status).toBe("needs_position_confirmation");
    expect(next.cursorElementId).toBe("line_0001");
    expect(next.pendingAction).toEqual({ type: "confirm_position", candidates: [
      { elementId: "line_0001", text: "We begin." },
      { elementId: "line_0003", text: "I thought you had gone." },
      { elementId: "line_0005", text: "Then stay beside me." },
    ] });
  });

  it("continues with the next AI line after the actor confirms the line they just spoke", () => {
    const ambiguous = reduceRehearsal(activeState(), { type: "actor_line_final", sequence: 2,
      text: "I thought we should begin and stay.", endedAtMs: 2_400 });

    const confirmed = reduceRehearsal(ambiguous, { type: "position_confirmed", sequence: 3,
      elementId: "line_0003" });

    expect(confirmed).toMatchObject({ status: "active", cursorElementId: "line_0004",
      pendingAction: { type: "speak", elementId: "line_0004", characterId: "char_bea" } });
  });

  it("advances from completed AI speech to the next actor line", () => {
    const speaking = reduceRehearsal(activeState(), { type: "actor_line_final", sequence: 2,
      text: "We begin.", endedAtMs: 1_200 });

    const next = reduceRehearsal(speaking, { type: "ai_speech_finished", sequence: 3,
      characterId: "char_bea", elementId: "line_0002", endedAtMs: 2_000 });

    expect(next.cursorElementId).toBe("line_0003");
    expect(next.pendingAction).toEqual({ type: "listen", elementId: "line_0003" });
  });

  it("pauses, resumes, restarts, and stops without losing deterministic position", () => {
    const initial = activeState();
    const paused = reduceRehearsal(initial, { type: "paused", sequence: 2 });
    expect(paused).toMatchObject({ status: "paused", cursorElementId: "line_0001", pendingAction: null });
    const resumed = reduceRehearsal(paused, { type: "resumed", sequence: 3 });
    expect(resumed).toMatchObject({ status: "active", cursorElementId: "line_0001",
      pendingAction: { type: "listen", elementId: "line_0001" } });
    const restarted = reduceRehearsal(resumed, { type: "restart_requested", sequence: 4,
      elementId: "line_0003" });
    expect(restarted).toMatchObject({ cursorElementId: "line_0003",
      pendingAction: { type: "listen", elementId: "line_0003" } });
    const stopped = reduceRehearsal(restarted, { type: "stopped", sequence: 5 });
    expect(stopped).toMatchObject({ status: "stopped", cursorElementId: "line_0003", pendingAction: null });
  });

  it("keeps recovery fenced on pause and restores the pending action on acknowledged resume", () => {
    const disconnected = reduceRehearsal(activeState(), { type: "connection_lost", sequence: 2,
      reason: "network" });

    const paused = reduceRehearsal(disconnected, { type: "paused", sequence: 3 });
    const resumed = reduceRehearsal(paused, { type: "resumed", sequence: 4 });

    expect(paused).toMatchObject({ status: "disconnected", cursorElementId: "line_0001", pendingAction: null });
    expect(resumed).toMatchObject({ status: "active", cursorElementId: "line_0001",
      pendingAction: { type: "listen", elementId: "line_0001" } });
  });

  it("does not advance on a late actor completion while locally paused", () => {
    const paused = reduceRehearsal(activeState(), { type: "paused", sequence: 2 });

    const late = reduceRehearsal(paused, { type: "actor_line_final", sequence: 3,
      text: "We begin.", endedAtMs: 1_200 });

    expect(late).toMatchObject({ status: "paused", cursorElementId: "line_0001", lastSequence: 3,
      pendingAction: null });
  });

  it("updates partial transcript preview without consuming a persisted sequence", () => {
    const initial = activeState();

    const next = reduceRehearsal(initial, { type: "actor_partial", text: "We be" });

    expect(next.transcriptPreview).toBe("We be");
    expect(next.lastSequence).toBe(1);
  });

  it("rejects duplicate and out-of-order persisted events", () => {
    const initial = activeState();

    expect(() => reduceRehearsal(initial, { type: "paused", sequence: 1 }))
      .toThrow(RehearsalSequenceError);
    expect(() => reduceRehearsal(initial, { type: "paused", sequence: 3 }))
      .toThrow("Expected rehearsal sequence 2, received 3");
  });
});

function activeState() {
  return reduceRehearsal(createRehearsalState({ sessionId: "session-1", actorRoleId, lines }),
    { type: "started", sequence: 1, startedAtMs: 0 });
}
