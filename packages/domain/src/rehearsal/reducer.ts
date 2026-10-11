import { rehearsalLineSimilarity } from "./controller";
import type { PersistedRehearsalEvent, RehearsalAction, RehearsalEvent, RehearsalLine,
  RehearsalState } from "./types";

export class RehearsalSequenceError extends Error {
  constructor(expected: number, received: number) {
    super(`Expected rehearsal sequence ${expected}, received ${received}`);
    this.name = "RehearsalSequenceError";
  }
}

export function reduceRehearsal(state: RehearsalState, event: RehearsalEvent): RehearsalState {
  if (event.type === "actor_partial") return { ...state, transcriptPreview: event.text };
  const sequencedState = acceptSequence(state, event);
  switch (event.type) {
    case "started":
      return { ...sequencedState, status: sequencedState.cursorElementId ? "active" : "completed",
        startedAtMs: event.startedAtMs, pendingAction: actionForCursor(sequencedState) };
    case "actor_line_final":
      return blocksAdvancement(sequencedState) ? sequencedState : applyActorLine(sequencedState, event.text);
    case "ai_speech_started":
      return !blocksAdvancement(sequencedState) && matchesCursor(sequencedState, event.elementId)
        ? { ...sequencedState, status: "active", pendingAction: null }
        : sequencedState;
    case "ai_speech_finished":
      return !blocksAdvancement(sequencedState) && matchesCursor(sequencedState, event.elementId)
        ? advanceAfter(sequencedState, event.elementId)
        : sequencedState;
    case "cue_requested": {
      if (sequencedState.status === "await_interruption_choice") return sequencedState;
      const line = cursorLine(sequencedState);
      return !line ? sequencedState : { ...sequencedState,
        pendingAction: { type: "show_cue", elementId: line.elementId } };
    }
    case "restart_requested": {
      if (sequencedState.status === "await_interruption_choice") return sequencedState;
      const target = event.elementId && sequencedState.lines.some(({ elementId }) => elementId === event.elementId)
        ? event.elementId : sequencedState.lines[0]?.elementId ?? null;
      const restarted = { ...sequencedState, status: target ? "active" as const : "completed" as const,
        cursorElementId: target, transcriptPreview: "", omittedElementIds: [] };
      return { ...restarted, pendingAction: actionForCursor(restarted) };
    }
    case "paused":
      return sequencedState.status === "disconnected" ? { ...sequencedState, pendingAction: null }
        : { ...sequencedState, status: "paused", pendingAction: null };
    case "resumed": {
      if (sequencedState.status === "await_interruption_choice") return sequencedState;
      const resumed = { ...sequencedState, status: "active" as const };
      return { ...resumed, pendingAction: actionForCursor(resumed) };
    }
    case "interrupted": {
      const line = cursorLine(sequencedState);
      if (!line || (event.elementId && event.elementId !== line.elementId)) return sequencedState;
      return { ...sequencedState, status: "await_interruption_choice", pendingAction: line
        ? { type: "await_interruption_choice", elementId: line.elementId } : null };
    }
    case "continue_after_interruption":
      return sequencedState.status === "await_interruption_choice" && matchesCursor(sequencedState, event.elementId)
        ? advanceAfter({ ...sequencedState, status: "active" }, event.elementId) : sequencedState;
    case "restart_line": {
      if (sequencedState.status !== "await_interruption_choice" || !matchesCursor(sequencedState, event.elementId)) {
        return sequencedState;
      }
      const restarted = { ...sequencedState, status: "active" as const };
      return { ...restarted, pendingAction: actionForCursor(restarted) };
    }
    case "manual_actor_line_completed": {
      const line = cursorLine(sequencedState);
      return !blocksAdvancement(sequencedState) && matchesCursor(sequencedState, event.elementId)
        && line?.characterId === sequencedState.actorRoleId
        ? advanceAfter(sequencedState, event.elementId) : sequencedState;
    }
    case "connection_lost":
      return { ...sequencedState, status: "disconnected", pendingAction: null };
    case "fallback_selected": {
      const fallback = { ...sequencedState, status: "active" as const };
      return { ...fallback, pendingAction: actionForCursor(fallback) };
    }
    case "position_confirmed": {
      const confirmedLine = sequencedState.lines.find(({ elementId }) => elementId === event.elementId);
      if (!confirmedLine || confirmedLine.characterId !== sequencedState.actorRoleId) return sequencedState;
      // The confirmation choices are lines the actor has just spoken, not lines
      // they should repeat. Continue from the line after the selected one.
      return advanceAfter({ ...sequencedState, status: "active", transcriptPreview: "" }, event.elementId);
    }
    case "stopped":
      return { ...sequencedState, status: "stopped", pendingAction: null };
  }
}

function acceptSequence(state: RehearsalState, event: PersistedRehearsalEvent): RehearsalState {
  const expected = state.lastSequence + 1;
  if (event.sequence !== expected) throw new RehearsalSequenceError(expected, event.sequence);
  return { ...state, lastSequence: event.sequence };
}

function applyActorLine(state: RehearsalState, text: string): RehearsalState {
  const currentIndex = cursorIndex(state);
  const current = state.lines[currentIndex];
  if (!current || current.characterId !== state.actorRoleId) return state;
  const candidates = state.lines.slice(currentIndex).filter(({ characterId }) => characterId === state.actorRoleId)
    .slice(0, 4).map((line) => ({ line, similarity: rehearsalLineSimilarity(line.text, text) }));
  const currentCandidate = candidates[0];
  if (currentCandidate && currentCandidate.similarity >= 0.65) {
    return advanceAfter({ ...state, transcriptPreview: "" }, currentCandidate.line.elementId);
  }
  const laterIndex = candidates.findIndex(({ similarity }, index) => index > 0 && similarity >= 0.85);
  if (laterIndex > 0 && candidates.slice(0, laterIndex).every(({ similarity }) => similarity < 0.35)) {
    const omitted = candidates.slice(0, laterIndex).map(({ line }) => line.elementId);
    const recovered = { ...state, transcriptPreview: "",
      omittedElementIds: [...new Set([...state.omittedElementIds, ...omitted])] };
    return advanceAfter(recovered, candidates[laterIndex]!.line.elementId);
  }
  return { ...state, status: "needs_position_confirmation", transcriptPreview: "",
    pendingAction: { type: "confirm_position", candidates: candidates.slice(0, 3)
      .map(({ line }) => ({ elementId: line.elementId, text: line.text })) } };
}

function advanceAfter(state: RehearsalState, elementId: string): RehearsalState {
  const index = state.lines.findIndex((line) => line.elementId === elementId);
  const next = index < 0 ? undefined : state.lines[index + 1];
  if (!next) return { ...state, status: "completed", cursorElementId: null,
    pendingAction: { type: "complete" }, transcriptPreview: "" };
  const advanced = { ...state, status: "active" as const, cursorElementId: next.elementId,
    transcriptPreview: "" };
  return { ...advanced, pendingAction: actionForCursor(advanced) };
}

function actionForCursor(state: RehearsalState): RehearsalAction | null {
  const line = cursorLine(state);
  if (!line) return { type: "complete" };
  return line.characterId === state.actorRoleId
    ? { type: "listen", elementId: line.elementId }
    : { type: "speak", elementId: line.elementId, characterId: line.characterId };
}

function cursorLine(state: RehearsalState): RehearsalLine | undefined {
  return state.lines.find(({ elementId }) => elementId === state.cursorElementId);
}

function cursorIndex(state: RehearsalState): number {
  return state.lines.findIndex(({ elementId }) => elementId === state.cursorElementId);
}

function matchesCursor(state: RehearsalState, elementId: string): boolean {
  return state.cursorElementId === elementId;
}

function blocksAdvancement(state: RehearsalState): boolean {
  return ["paused", "disconnected", "recovering", "await_interruption_choice", "stopped"]
    .includes(state.status);
}
