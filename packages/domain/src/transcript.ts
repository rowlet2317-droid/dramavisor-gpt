export type TranscriptWord = {
  text: string;
  startMs: number | null;
  endMs: number | null;
  confidence: number | null;
};

export type LineAlignmentStatus = "matched" | "paraphrased" | "omitted" | "uncertain";

export type LineAlignment = {
  elementId: string;
  scriptOrdinal: number;
  transcriptStartMs: number | null;
  transcriptEndMs: number | null;
  similarity: number;
  status: LineAlignmentStatus;
};

export type TranscriptTimingSource = "whisper_word_timestamps" | "partial_whisper_word_timestamps"
  | "unavailable";

export type Transcript = {
  text: string;
  language: string;
  words: TranscriptWord[];
  provider: string;
  modelName: string;
  transcriberVersion: string;
  timingSource: TranscriptTimingSource;
};

export type UncertaintyRegion = {
  elementId: string;
  startMs: number | null;
  endMs: number | null;
  reason: "low_similarity" | "missing_timing";
};
