import { describe, expect, it } from "vitest";

import { createExerciseSession, nextExerciseAction } from "./exercises";

describe("guided exercise state", () => {
  it("never interrupts a complete take when speech is detected", () => {
    expect(nextExerciseAction({ mode: "complete_take", event: "speech_detected" }))
      .toEqual({ type: "continue" });
  });

  it("offers exactly one evidence-linked note after a guided attempt", () => {
    expect(nextExerciseAction({ mode: "guided_exercise", event: "attempt_completed",
      evidenceIds: ["audio:line-1"] })).toEqual({
      type: "coach", maxNotes: 1, evidenceIds: ["audio:line-1"],
    });
  });

  it("waits for an explicit actor choice after feedback", () => {
    expect(nextExerciseAction({ mode: "guided_exercise", event: "feedback_ready" })).toEqual({
      type: "await_choice", choices: ["continue", "retry", "finish"], autoRecord: false,
    });
  });

  it("requires an explicit recording start after continue or retry", () => {
    expect(nextExerciseAction({ mode: "guided_exercise", event: "actor_choice", choice: "retry",
      turn: 2, maxTurns: 4 })).toEqual({ type: "prepare_turn", turn: 2, requiresStart: true });
    expect(nextExerciseAction({ mode: "guided_exercise", event: "actor_choice", choice: "continue",
      turn: 2, maxTurns: 4 })).toEqual({ type: "prepare_turn", turn: 3, requiresStart: true });
  });

  it("finishes on actor request or at the bounded turn limit", () => {
    expect(nextExerciseAction({ mode: "guided_exercise", event: "actor_choice", choice: "finish",
      turn: 1, maxTurns: 4 })).toEqual({ type: "finish" });
    expect(nextExerciseAction({ mode: "guided_exercise", event: "actor_choice", choice: "continue",
      turn: 4, maxTurns: 4 })).toEqual({ type: "finish" });
  });
});

describe("exercise sessions", () => {
  it.each(["repeat_line", "change_tactic", "pause_and_intend", "alternative_interpretation"] as const)(
    "creates a bounded %s session pinned to the actor's play context",
    (kind) => {
      const session = createExerciseSession({ id: "exercise-1", ownerUserId: "actor-1", playId: "play-1",
        playModelId: "model-1", playModelVersion: 3, sceneId: "scene-1", roleId: "alex", kind,
        targetElementIds: ["line-1"], prompt: "Try the line once more.", maxTurns: 4,
        now: new Date("2026-08-22T12:00:00Z") });

      expect(session).toMatchObject({ id: "exercise-1", ownerUserId: "actor-1", playId: "play-1",
        playModelId: "model-1", playModelVersion: 3, sceneId: "scene-1", roleId: "alex", kind,
        targetElementIds: ["line-1"], prompt: "Try the line once more.", state: "ready", currentTurn: 1,
        maxTurns: 4 });
      expect(session.createdAt).toEqual(new Date("2026-08-22T12:00:00Z"));
    },
  );

  it("rejects unbounded or empty exercise instructions", () => {
    const base = { id: "exercise-1", ownerUserId: "actor-1", playId: "play-1", playModelId: "model-1",
      playModelVersion: 3, sceneId: "scene-1", roleId: "alex", kind: "repeat_line" as const,
      targetElementIds: ["line-1"], prompt: "Try the line once more.", maxTurns: 4 };

    expect(() => createExerciseSession({ ...base, maxTurns: 0 })).toThrow("INVALID_EXERCISE_TURN_LIMIT");
    expect(() => createExerciseSession({ ...base, maxTurns: 9 })).toThrow("INVALID_EXERCISE_TURN_LIMIT");
    expect(() => createExerciseSession({ ...base, prompt: " " })).toThrow("INVALID_EXERCISE_PROMPT");
    expect(() => createExerciseSession({ ...base, targetElementIds: [] })).toThrow("MISSING_EXERCISE_TARGET");
  });
});
