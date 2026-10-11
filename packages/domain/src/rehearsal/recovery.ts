import { reduceRehearsal } from "./reducer";
import type { PersistedRehearsalEvent, RehearsalState } from "./types";

export type RecoveryDecision = {
  kind: "resume" | "end_and_save";
  reason?: "play_model_changed";
  state: RehearsalState;
  cursorElementId: string | null;
  lastSequence: number;
  replayEventSequences: number[];
};

type RecoveryMetadata = {
  clientLastSequence: number;
  serverLastSequence: number;
  expectedPlayModelVersion: number;
  serverPlayModelVersion: number;
};

export function recoverSession(initialState: RehearsalState, events: PersistedRehearsalEvent[],
  metadata: RecoveryMetadata): RecoveryDecision {
  validateHistory(events, metadata.serverLastSequence);
  if (!Number.isInteger(metadata.clientLastSequence) || metadata.clientLastSequence < 0
    || metadata.clientLastSequence > metadata.serverLastSequence) {
    throw new Error("Client rehearsal sequence is invalid");
  }
  const state = events.reduce((current, event) => reduceRehearsal(current, event), initialState);
  const common = { state, cursorElementId: state.cursorElementId, lastSequence: metadata.serverLastSequence,
    replayEventSequences: events.filter(({ sequence }) => sequence > metadata.clientLastSequence)
      .map(({ sequence }) => sequence) };
  if (metadata.expectedPlayModelVersion !== metadata.serverPlayModelVersion) {
    return { kind: "end_and_save", reason: "play_model_changed", ...common };
  }
  return { kind: "resume", ...common };
}

function validateHistory(events: PersistedRehearsalEvent[], serverLastSequence: number): void {
  if (!Number.isInteger(serverLastSequence) || serverLastSequence < 0) {
    throw new Error("Server rehearsal sequence is invalid");
  }
  for (let index = 0; index < events.length; index += 1) {
    const expected = index + 1;
    if (events[index]?.sequence !== expected) {
      throw new Error(`Expected rehearsal recovery sequence ${expected}`);
    }
  }
  if ((events.at(-1)?.sequence ?? 0) !== serverLastSequence) {
    throw new Error(`Recovery history does not end at server sequence ${serverLastSequence}`);
  }
}
