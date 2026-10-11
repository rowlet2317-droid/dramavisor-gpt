import type { RehearsalLine, RehearsalState } from "./types";

export function createRehearsalState(input: {
  sessionId: string;
  actorRoleId: string;
  lines: RehearsalLine[];
}): RehearsalState {
  const lines = [...input.lines].sort((left, right) => left.ordinal - right.ordinal);
  if (new Set(lines.map(({ elementId }) => elementId)).size !== lines.length) {
    throw new Error("Rehearsal lines require unique element IDs");
  }
  return {
    sessionId: input.sessionId,
    actorRoleId: input.actorRoleId,
    lines,
    status: "ready",
    cursorElementId: lines[0]?.elementId ?? null,
    pendingAction: null,
    omittedElementIds: [],
    transcriptPreview: "",
    lastSequence: 0,
    startedAtMs: null,
  };
}

export function rehearsalLineSimilarity(expected: string, performed: string): number {
  const left = tokenize(expected);
  const right = tokenize(performed);
  const denominator = Math.max(left.length, right.length);
  if (denominator === 0) return 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return Math.max(0, 1 - previous[right.length]! / denominator);
}

function tokenize(text: string): string[] {
  return text.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/’/g, "'").match(/[\p{L}\p{N}']+/gu) ?? [];
}
