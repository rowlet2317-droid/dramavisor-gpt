export const EXERCISE_KINDS = [
  "repeat_line",
  "change_tactic",
  "pause_and_intend",
  "alternative_interpretation",
] as const;

export type ExerciseKind = typeof EXERCISE_KINDS[number];

export type ExerciseSession = {
  id: string;
  ownerUserId: string;
  playId: string;
  playModelId: string;
  playModelVersion: number;
  sceneId: string;
  roleId: string;
  kind: ExerciseKind;
  targetElementIds: string[];
  prompt: string;
  state: "ready" | "finished";
  currentTurn: number;
  maxTurns: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ExerciseTurn = {
  id: string;
  exerciseSessionId: string;
  ordinal: number;
  takeId: string | null;
  state: "ready" | "processing" | "awaiting_choice" | "completed";
  note: { text: string; evidenceIds: string[] } | null;
};

export type ExerciseEvent =
  | { mode: "complete_take"; event: "speech_detected" }
  | { mode: "guided_exercise"; event: "attempt_completed"; evidenceIds: string[] }
  | { mode: "guided_exercise"; event: "feedback_ready" }
  | { mode: "guided_exercise"; event: "actor_choice"; choice: "continue" | "retry" | "finish";
      turn: number; maxTurns: number };

export type ExerciseAction =
  | { type: "continue" }
  | { type: "coach"; maxNotes: 1; evidenceIds: string[] }
  | { type: "await_choice"; choices: ["continue", "retry", "finish"]; autoRecord: false }
  | { type: "prepare_turn"; turn: number; requiresStart: true }
  | { type: "finish" };

type CreateExerciseSessionInput = Omit<ExerciseSession, "state" | "currentTurn" | "createdAt" | "updatedAt">
  & { now?: Date };

export function createExerciseSession(input: CreateExerciseSessionInput): ExerciseSession {
  if (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 8) {
    throw new Error("INVALID_EXERCISE_TURN_LIMIT");
  }
  if (!input.prompt.trim()) throw new Error("INVALID_EXERCISE_PROMPT");
  if (input.targetElementIds.length === 0) throw new Error("MISSING_EXERCISE_TARGET");
  const now = input.now ?? new Date();
  const { now: _now, ...session } = input;
  return { ...session, prompt: input.prompt.trim(), targetElementIds: [...input.targetElementIds],
    state: "ready", currentTurn: 1, createdAt: now, updatedAt: now };
}

export function nextExerciseAction(event: ExerciseEvent): ExerciseAction {
  if (event.mode === "complete_take") return { type: "continue" };
  if (event.event === "attempt_completed") {
    return { type: "coach", maxNotes: 1, evidenceIds: [...event.evidenceIds] };
  }
  if (event.event === "feedback_ready") {
    return { type: "await_choice", choices: ["continue", "retry", "finish"], autoRecord: false };
  }
  if (event.choice === "finish" || event.choice === "continue" && event.turn >= event.maxTurns) {
    return { type: "finish" };
  }
  return { type: "prepare_turn", turn: event.choice === "retry" ? event.turn : event.turn + 1,
    requiresStart: true };
}
