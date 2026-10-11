import type { LineAlignment, TranscriptWord } from "@drama/domain/transcript";

export type RoleLine = { elementId: string; ordinal: number; text: string };

type Candidate = { start: number; end: number; similarity: number } | null;
type Decision = { kind: "omit" } | { kind: "skip" }
  | { kind: "align"; end: number; similarity: number };

export function alignScript(lines: RoleLine[], words: TranscriptWord[]): LineAlignment[] {
  const decisions = lines.map(() => Array<Decision>(words.length + 1));
  let nextLineScores = new Float64Array(words.length + 1);
  for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
    const scores = new Float64Array(words.length + 1);
    const scriptTokens = tokenize(lines[lineIndex]!.text);
    const longest = Math.max(1, scriptTokens.length * 2 + 2);
    for (let wordIndex = words.length; wordIndex >= 0; wordIndex -= 1) {
      let bestScore = nextLineScores[wordIndex]! + 0.25;
      let best: Decision = { kind: "omit" };
      if (wordIndex < words.length && scores[wordIndex + 1]! - 0.03 > bestScore) {
        bestScore = scores[wordIndex + 1]! - 0.03;
        best = { kind: "skip" };
      }
      for (let end = wordIndex + 1; end <= Math.min(words.length, wordIndex + longest); end += 1) {
        const transcriptTokens = words.slice(wordIndex, end).flatMap((word) => tokenize(word.text));
        const similarity = tokenSimilarity(scriptTokens, transcriptTokens);
        if (similarity < 0.35) continue;
        const lengthPenalty = Math.abs(scriptTokens.length - transcriptTokens.length) * 0.01;
        const score = nextLineScores[end]! + similarity - lengthPenalty;
        if (score > bestScore) {
          bestScore = score;
          best = { kind: "align", end, similarity };
        }
      }
      scores[wordIndex] = bestScore;
      decisions[lineIndex]![wordIndex] = best;
    }
    nextLineScores = scores;
  }

  const choices: Candidate[] = [];
  let lineIndex = 0;
  let wordIndex = 0;
  while (lineIndex < lines.length) {
    const decision = decisions[lineIndex]![wordIndex]!;
    if (decision.kind === "skip") {
      wordIndex += 1;
    } else if (decision.kind === "omit") {
      choices.push(null);
      lineIndex += 1;
    } else {
      choices.push({ start: wordIndex, end: decision.end, similarity: decision.similarity });
      wordIndex = decision.end;
      lineIndex += 1;
    }
  }

  const provisional = choices.map((choice, index): LineAlignment => {
    if (!choice) return emptyAlignment(lines[index]!.elementId, lines[index]!.ordinal);
    const selectedWords = words.slice(choice.start, choice.end);
    const missingTiming = selectedWords.some(({ startMs, endMs }) => startMs === null || endMs === null);
    const status = missingTiming
      ? "uncertain"
      : choice.similarity >= 0.9
      ? "matched"
      : choice.similarity >= 0.65
        ? "paraphrased"
        : "uncertain";
    return {
      elementId: lines[index]!.elementId,
      scriptOrdinal: lines[index]!.ordinal,
      transcriptStartMs: missingTiming ? null : words[choice.start]!.startMs,
      transcriptEndMs: missingTiming ? null : words[choice.end - 1]!.endMs,
      similarity: choice.similarity,
      status,
    };
  });

  return provisional.map((alignment, index) => {
    if (choices[index] !== null) return alignment;
    const previousAligned = index > 0 && choices[index - 1] !== null
      && provisional[index - 1]!.similarity >= 0.65;
    const nextAligned = index + 1 < choices.length && choices[index + 1] !== null
      && provisional[index + 1]!.similarity >= 0.65;
    return { ...alignment, status: previousAligned && nextAligned ? "omitted" : "uncertain" };
  });

}

function emptyAlignment(elementId: string, scriptOrdinal = 0): LineAlignment {
  return { elementId, scriptOrdinal, transcriptStartMs: null, transcriptEndMs: null,
    similarity: 0, status: "uncertain" };
}

function tokenize(text: string): string[] {
  return text.toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}'’]+/gu, " ")
    .replace(/’/g, "'")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function tokenSimilarity(left: string[], right: string[]): number {
  const denominator = Math.max(left.length, right.length);
  if (denominator === 0) return 1;
  const rows = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let row = 0; row <= left.length; row += 1) rows[row]![0] = row;
  for (let column = 0; column <= right.length; column += 1) rows[0]![column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      rows[row]![column] = Math.min(
        rows[row - 1]![column]! + 1,
        rows[row]![column - 1]! + 1,
        rows[row - 1]![column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
  }
  return Math.max(0, 1 - rows[left.length]![right.length]! / denominator);
}
