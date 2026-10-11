import { describe, expect, it } from "vitest";

import type { TranscriptWord } from "@drama/domain/transcript";

import { alignScript } from "./align-script";

const roleLines = [
  { elementId: "line_0001", ordinal: 1, text: "I thought you had gone." },
  { elementId: "line_0002", ordinal: 2, text: "I waited by the window." },
  { elementId: "line_0003", ordinal: 3, text: "The rain would not stop." },
  { elementId: "line_0004", ordinal: 4, text: "Then I heard your key." },
];

describe("alignScript", () => {
  it("identifies an omitted line without shifting every later line", () => {
    // Break caught: consuming line 4's words for the absent line 3 would make line 4 fail to match.
    const words = timedWords([
      "I", "thought", "you", "had", "gone",
      "I", "waited", "by", "the", "window",
      "Then", "I", "heard", "your", "key",
    ]);

    const result = alignScript(roleLines, words);

    expect(result.find((alignment) => alignment.elementId === "line_0003")).toMatchObject({
      transcriptStartMs: null,
      transcriptEndMs: null,
      status: "omitted",
    });
    expect(result.find((alignment) => alignment.elementId === "line_0004")).toMatchObject({
      transcriptStartMs: 1_000,
      transcriptEndMs: 1_480,
      status: "matched",
    });
  });

  it("normalizes punctuation and case while preserving contractions as tokens", () => {
    // Break caught: stripping apostrophes changes contractions and can incorrectly demote exact spoken lines.
    const result = alignScript([{ elementId: "line", ordinal: 7, text: "Don't turn BACK!" }], timedWords([
      "don't", "turn", "back",
    ]));

    expect(result).toEqual([{
      elementId: "line",
      scriptOrdinal: 7,
      transcriptStartMs: 0,
      transcriptEndMs: 280,
      similarity: 1,
      status: "matched",
    }]);
  });

  it("classifies token similarity at matched and paraphrased thresholds", () => {
    // Break caught: off-by-one threshold comparisons would misclassify exactly 0.90 or 0.65 evidence.
    const result = alignScript([
      { elementId: "matched", ordinal: 1, text: "one two three four five six seven eight nine ten" },
      { elementId: "paraphrased", ordinal: 2, text: "a b c d e f g h i j k l m n o p q r s t" },
    ], timedWords([
      "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "wrong",
      "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
      "wrong1", "wrong2", "wrong3", "wrong4", "wrong5", "wrong6", "wrong7",
    ]));

    expect(result.map(({ elementId, similarity, status }) => ({ elementId, similarity, status }))).toEqual([
      { elementId: "matched", similarity: 0.9, status: "matched" },
      { elementId: "paraphrased", similarity: 0.65, status: "paraphrased" },
    ]);
  });

  it("marks an unmatched edge line uncertain when aligned neighbors do not bracket it", () => {
    // Break caught: a low-similarity edge cannot be called omitted without evidence on both sides.
    const result = alignScript([
      { elementId: "edge", ordinal: 1, text: "The missing opening line" },
      { elementId: "next", ordinal: 2, text: "We begin now" },
    ], timedWords(["We", "begin", "now"]));

    expect(result).toEqual([
      { elementId: "edge", scriptOrdinal: 1, transcriptStartMs: null, transcriptEndMs: null,
        similarity: 0, status: "uncertain" },
      { elementId: "next", scriptOrdinal: 2, transcriptStartMs: 0, transcriptEndMs: 280,
        similarity: 1, status: "matched" },
    ]);
  });

  it("recovers an exact later line after more than five filler words", () => {
    // Break caught: a fixed short lookahead loses script alignment after ad-libs or non-script speech.
    const result = alignScript([
      { elementId: "first", ordinal: 1, text: "We begin now" },
      { elementId: "second", ordinal: 2, text: "Then I heard your key" },
    ], timedWords([
      "We", "begin", "now",
      "well", "you", "know", "I", "was", "just", "thinking", "about", "the", "weather",
      "Then", "I", "heard", "your", "key",
    ]));

    expect(result).toEqual([
      { elementId: "first", scriptOrdinal: 1, transcriptStartMs: 0, transcriptEndMs: 280,
        similarity: 1, status: "matched" },
      { elementId: "second", scriptOrdinal: 2, transcriptStartMs: 1_300, transcriptEndMs: 1_780,
        similarity: 1, status: "matched" },
    ]);
  });
});

function timedWords(tokens: string[]): TranscriptWord[] {
  return tokens.map((text, index) => ({
    text,
    startMs: index * 100,
    endMs: index * 100 + 80,
    confidence: null,
  }));
}
