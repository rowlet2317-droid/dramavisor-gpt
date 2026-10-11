import type { Transcript, TranscriptWord } from "@drama/domain/transcript";

import type { Transcriber, TranscriptionInput } from "./port";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type OpenAiTranscriberOptions = {
  apiKey: string;
  fetch?: FetchLike;
  primaryModel?: string;
  timingModel?: string;
  maxUploadBytes?: number;
  transcriberVersion?: string;
  silenceSearchMs?: number;
  minimumSilenceMs?: number;
  silenceThreshold?: number;
  promptCharacters?: number;
};

type WavChunk = { bytes: Uint8Array; offsetSeconds: number };

export class OpenAiTranscriptionNetworkError extends Error {
  readonly code = "OPENAI_TRANSCRIPTION_NETWORK_FAILURE";

  constructor(cause: unknown) {
    super("OpenAI transcription request could not reach the provider", { cause });
    this.name = "OpenAiTranscriptionNetworkError";
  }
}

export class OpenAiTranscriptionHttpError extends Error {
  readonly code: string;

  constructor(status: number) {
    super(`OpenAI transcription failed with HTTP ${status}`);
    this.name = "OpenAiTranscriptionHttpError";
    this.code = `OPENAI_TRANSCRIPTION_HTTP_${status}`;
  }
}

export class InvalidOpenAiTranscriptionResponseError extends Error {
  readonly code = "OPENAI_TRANSCRIPTION_RESPONSE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "InvalidOpenAiTranscriptionResponseError";
  }
}

export class OpenAiTranscriber implements Transcriber {
  readonly version: string;
  private readonly fetch: FetchLike;
  private readonly primaryModel: string;
  private readonly timingModel: string;
  private readonly maxUploadBytes: number;
  private readonly silenceSearchMs: number;
  private readonly minimumSilenceMs: number;
  private readonly silenceThreshold: number;
  private readonly promptCharacters: number;

  constructor(private readonly options: OpenAiTranscriberOptions) {
    this.fetch = options.fetch ?? fetch;
    this.primaryModel = options.primaryModel ?? "gpt-transcribe";
    this.timingModel = options.timingModel ?? "whisper-1";
    this.maxUploadBytes = options.maxUploadBytes ?? 24 * 1024 * 1024;
    this.silenceSearchMs = options.silenceSearchMs ?? 2_000;
    this.minimumSilenceMs = options.minimumSilenceMs ?? 200;
    this.silenceThreshold = options.silenceThreshold ?? 512;
    this.promptCharacters = options.promptCharacters ?? 1_000;
    this.version = options.transcriberVersion ?? "openai-transcription-v2";
  }

  async transcribe(input: TranscriptionInput): Promise<Transcript> {
    const chunks = chunkCanonicalPcmWav(input.audio, this.maxUploadBytes, {
      searchMs: this.silenceSearchMs,
      minimumMs: this.minimumSilenceMs,
      threshold: this.silenceThreshold,
    });
    const primary = [] as Array<{ text: string; languages: string[] }>;
    let promptText = "";
    for (let index = 0; index < chunks.length; index += 1) {
      const prompt = index === 0 ? undefined : trailingContext(promptText, this.promptCharacters);
      let result = await this.requestPrimary(chunks[index]!.bytes, chunkFilename(input.filename, index), prompt);
      const overlap = prompt ? textOverlapLength(promptText, result.text) : 0;
      if (overlap > 0) {
        const verification = await this.requestPrimary(chunks[index]!.bytes, chunkFilename(input.filename, index));
        const withoutOverlap = textWithoutPrefix(result.text, overlap);
        result = {
          text: sameTokens(verification.text, withoutOverlap) ? verification.text : result.text,
          languages: [...result.languages, ...verification.languages],
        };
      }
      primary.push(result);
      promptText = mergePromptText(promptText, result.text);
    }

    let words: TranscriptWord[] = [];
    let canonicalText = "";
    let timingRequestCount = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const canonicalWords = transcriptTokens(primary[index]!.text).map(({ text }) => text);
      let reconciled: TranscriptWord[];
      try {
        const timing = await this.requestTiming(chunks[index]!.bytes, chunkFilename(input.filename, index));
        timingRequestCount += 1;
        reconciled = reconcileTiming(canonicalWords, timing.words, chunks[index]!.offsetSeconds);
      } catch {
        reconciled = canonicalWords.map((text) => ({
          text, startMs: null, endMs: null, confidence: null,
        }));
      }
      canonicalText = mergeCanonicalText(canonicalText, primary[index]!.text, 0);
      words = [...words, ...reconciled];
    }
    const mappedWordCount = words.filter(({ startMs }) => startMs !== null).length;
    const timingSource: Transcript["timingSource"] = mappedWordCount === 0
      ? "unavailable"
      : mappedWordCount === words.length ? "whisper_word_timestamps" : "partial_whisper_word_timestamps";
    if (mappedWordCount === 0 && timingRequestCount === 0) words = [];
    return this.result(primary, canonicalText, words, timingSource,
      timingRequestCount === 0 ? this.primaryModel : `${this.primaryModel}+${this.timingModel}`);
  }

  private result(
    chunks: Array<{ text: string; languages: string[] }>,
    canonicalText: string,
    words: TranscriptWord[],
    timingSource: Transcript["timingSource"],
    modelName: string,
  ): Transcript {
    return {
      text: canonicalText,
      language: aggregateLanguages(chunks.flatMap(({ languages }) => languages)),
      words,
      provider: "openai",
      modelName,
      transcriberVersion: this.version,
      timingSource,
    };
  }

  private async requestPrimary(bytes: Uint8Array, filename: string, prompt?: string): Promise<{
    text: string; languages: string[];
  }> {
    const form = audioForm(bytes, filename, this.primaryModel);
    form.set("response_format", "json");
    if (prompt) form.set("prompt", prompt);
    const response = await this.request(form);
    if (typeof response.text !== "string") throw new InvalidOpenAiTranscriptionResponseError("OpenAI transcription response omitted text");
    const languages = Array.isArray(response.languages)
      ? response.languages.flatMap((value) => isRecord(value) && typeof value.code === "string"
        ? [normalizeLanguage(value.code)] : [])
      : [];
    return { text: response.text, languages };
  }

  private async requestTiming(bytes: Uint8Array, filename: string): Promise<{
    words: Array<{ word: string; start: number; end: number }>;
  }> {
    const form = audioForm(bytes, filename, this.timingModel);
    form.set("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    const response = await this.request(form);
    if (!Array.isArray(response.words)) throw new InvalidOpenAiTranscriptionResponseError("Whisper response omitted word timestamps");
    const words = response.words.map((value) => {
      if (!isRecord(value) || typeof value.word !== "string" || typeof value.start !== "number"
        || typeof value.end !== "number") throw new InvalidOpenAiTranscriptionResponseError("Whisper returned an invalid word timestamp");
      return { word: value.word, start: value.start, end: value.end };
    });
    return { words };
  }

  private async request(form: FormData): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        body: form,
      });
    } catch (error) {
      throw new OpenAiTranscriptionNetworkError(error);
    }
    if (!response.ok) throw new OpenAiTranscriptionHttpError(response.status);
    const body: unknown = await response.json();
    if (!isRecord(body)) {
      throw new InvalidOpenAiTranscriptionResponseError("OpenAI transcription returned invalid JSON");
    }
    return body;
  }
}

function audioForm(bytes: Uint8Array, filename: string, model: string): FormData {
  const form = new FormData();
  form.set("model", model);
  const blobBytes = new Uint8Array(bytes.byteLength);
  blobBytes.set(bytes);
  form.set("file", new Blob([blobBytes], { type: "audio/wav" }), filename);
  return form;
}

function chunkCanonicalPcmWav(audio: Uint8Array, maxUploadBytes: number, silence: {
  searchMs: number;
  minimumMs: number;
  threshold: number;
}): WavChunk[] {
  if (audio.length < 12 || ascii(audio, 0, 4) !== "RIFF" || ascii(audio, 8, 4) !== "WAVE") {
    throw new Error("Expected PCM WAV audio");
  }
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const format = findRiffChunk(audio, view, "fmt ");
  const data = findRiffChunk(audio, view, "data");
  if (!format || format.length < 16 || !data) throw new Error("WAV omitted its format or data chunk");
  const channels = view.getUint16(format.offset + 2, true);
  const sampleRate = view.getUint32(format.offset + 4, true);
  const blockAlign = view.getUint16(format.offset + 12, true);
  const bitsPerSample = view.getUint16(format.offset + 14, true);
  if (view.getUint16(format.offset, true) !== 1 || channels !== 1 || sampleRate !== 16_000
    || bitsPerSample !== 16 || blockAlign !== 2) {
    throw new Error("Expected mono 16 kHz 16-bit PCM WAV audio");
  }
  const declaredDataBytes = data.length;
  const maxDataBytes = Math.floor((maxUploadBytes - 44) / blockAlign) * blockAlign;
  if (maxDataBytes < blockAlign) throw new Error("Transcription upload bound is too small for WAV audio");

  const chunks: WavChunk[] = [];
  for (let offset = 0; offset < declaredDataBytes;) {
    const nominalEnd = Math.min(declaredDataBytes, offset + maxDataBytes);
    const boundary = nominalEnd < declaredDataBytes
      ? findSilenceBoundary(audio, data.offset, offset, nominalEnd, sampleRate, silence)
      : nominalEnd;
    const dataLength = boundary - offset;
    const bytes = pcmWav(audio.subarray(data.offset + offset, data.offset + offset + dataLength), sampleRate);
    chunks.push({ bytes, offsetSeconds: offset / blockAlign / sampleRate });
    offset = boundary;
  }
  if (chunks.length === 0) chunks.push({ bytes: pcmWav(new Uint8Array(), sampleRate), offsetSeconds: 0 });
  return chunks;
}

function findSilenceBoundary(
  audio: Uint8Array,
  dataOffset: number,
  chunkOffset: number,
  nominalEnd: number,
  sampleRate: number,
  options: { searchMs: number; minimumMs: number; threshold: number },
): number {
  const bytesPerSample = 2;
  const searchBytes = Math.floor(sampleRate * options.searchMs / 1_000) * bytesPerSample;
  const minimumSamples = Math.max(1, Math.ceil(sampleRate * options.minimumMs / 1_000));
  const searchStart = Math.max(chunkOffset, nominalEnd - searchBytes);
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  let runStart = -1;
  let selected = nominalEnd;
  for (let position = searchStart; position < nominalEnd; position += bytesPerSample) {
    const sample = Math.abs(view.getInt16(dataOffset + position, true));
    if (sample <= options.threshold) {
      if (runStart < 0) runStart = position;
      if ((position + bytesPerSample - runStart) / bytesPerSample >= minimumSamples) {
        selected = position + bytesPerSample;
      }
    } else {
      runStart = -1;
    }
  }
  return selected > chunkOffset ? selected : nominalEnd;
}

function findRiffChunk(
  audio: Uint8Array,
  view: DataView,
  expectedId: string,
): { offset: number; length: number } | null {
  for (let headerOffset = 12; headerOffset + 8 <= audio.length;) {
    const length = view.getUint32(headerOffset + 4, true);
    const offset = headerOffset + 8;
    if (offset + length > audio.length) throw new Error("WAV chunk is truncated");
    if (ascii(audio, headerOffset, 4) === expectedId) return { offset, length };
    headerOffset = offset + length + (length % 2);
  }
  return null;
}

function pcmWav(data: Uint8Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + data.length);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  writeAscii(bytes, 8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, data.length, true);
  bytes.set(data, 44);
  return bytes;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function chunkFilename(filename: string, index: number): string {
  const stem = filename.toLowerCase().endsWith(".wav") ? filename.slice(0, -4) : filename;
  return `${stem}.part-${String(index + 1).padStart(3, "0")}.wav`;
}

function trailingContext(text: string, maximumCharacters: number): string {
  return text.slice(-maximumCharacters).trim();
}

function mergePromptText(existing: string, next: string): string {
  const left = transcriptTokens(existing);
  const right = transcriptTokens(next);
  const overlap = overlapLength(left.map(({ normalized }) => normalized), right.map(({ normalized }) => normalized));
  return mergeCanonicalText(existing, next, overlap);
}

function textOverlapLength(existing: string, next: string): number {
  return overlapLength(
    transcriptTokens(existing).map(({ normalized }) => normalized),
    transcriptTokens(next).map(({ normalized }) => normalized),
  );
}

function textWithoutPrefix(text: string, prefixTokenCount: number): string {
  const tokens = transcriptTokens(text);
  return prefixTokenCount >= tokens.length ? "" : text.slice(tokens[prefixTokenCount]!.start).trim();
}

function sameTokens(left: string, right: string): boolean {
  const leftTokens = transcriptTokens(left).map(({ normalized }) => normalized);
  const rightTokens = transcriptTokens(right).map(({ normalized }) => normalized);
  return leftTokens.length === rightTokens.length
    && leftTokens.every((token, index) => token === rightTokens[index]);
}

function mergeCanonicalText(existing: string, next: string, overlap: number): string {
  const right = transcriptTokens(next);
  if (overlap === right.length) return existing.trim();
  const suffix = overlap === 0 ? next.trim() : next.slice(right[overlap]!.start).trim();
  return [existing.trim(), suffix].filter(Boolean).join(" ");
}

function overlapLength(left: string[], right: string[]): number {
  for (let length = Math.min(left.length, right.length); length > 0; length -= 1) {
    if (left.slice(-length).every((token, index) => token === right[index])) return length;
  }
  return 0;
}

function reconcileTiming(
  canonical: string[],
  whisper: Array<{ word: string; start: number; end: number }>,
  offsetSeconds: number,
): TranscriptWord[] {
  const left = canonical.map(normalizeToken);
  const right = whisper.map(({ word }) => normalizeToken(word));
  const prefix = lcsPrefix(left, right);
  const suffix = lcsSuffix(left, right);
  const length = prefix[left.length]![right.length]!;
  const candidates = canonical.map((_text, canonicalIndex) => whisper.flatMap((_word, whisperIndex) =>
    left[canonicalIndex] === right[whisperIndex]
      && prefix[canonicalIndex]![whisperIndex]! + 1 + suffix[canonicalIndex + 1]![whisperIndex + 1]! === length
      ? [whisperIndex] : []));
  const candidateUseCounts = new Map<number, number>();
  for (const indexes of candidates) {
    for (const index of indexes) candidateUseCounts.set(index, (candidateUseCounts.get(index) ?? 0) + 1);
  }
  const selected = candidates.map((indexes) => indexes.length === 1 && candidateUseCounts.get(indexes[0]!) === 1
    ? indexes[0]! : null);
  const crossed = selected.map((whisperIndex, canonicalIndex) => whisperIndex !== null
    && selected.some((otherIndex, otherCanonicalIndex) => otherIndex !== null
      && ((otherCanonicalIndex < canonicalIndex && otherIndex > whisperIndex)
        || (otherCanonicalIndex > canonicalIndex && otherIndex < whisperIndex))));
  return canonical.map((text, canonicalIndex) => {
    const whisperIndex = selected[canonicalIndex];
    if (whisperIndex === null || whisperIndex === undefined || crossed[canonicalIndex]) {
      return { text, startMs: null, endMs: null, confidence: null };
    }
    const word = whisper[whisperIndex]!;
    return {
      text,
      startMs: Math.round((offsetSeconds + word.start) * 1_000),
      endMs: Math.round((offsetSeconds + word.end) * 1_000),
      confidence: null,
    };
  });
}

function lcsPrefix(left: string[], right: string[]): number[][] {
  const result = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      result[leftIndex + 1]![rightIndex + 1] = left[leftIndex] === right[rightIndex]
        ? result[leftIndex]![rightIndex]! + 1
        : Math.max(result[leftIndex]![rightIndex + 1]!, result[leftIndex + 1]![rightIndex]!);
    }
  }
  return result;
}

function lcsSuffix(left: string[], right: string[]): number[][] {
  const result = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      result[leftIndex]![rightIndex] = left[leftIndex] === right[rightIndex]
        ? result[leftIndex + 1]![rightIndex + 1]! + 1
        : Math.max(result[leftIndex + 1]![rightIndex]!, result[leftIndex]![rightIndex + 1]!);
    }
  }
  return result;
}

function transcriptTokens(text: string): Array<{ text: string; normalized: string; start: number }> {
  const matches = text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu);
  return Array.from(matches, (match) => ({
    text: match[0],
    normalized: normalizeToken(match[0]),
    start: match.index,
  }));
}

function normalizeToken(token: string): string {
  return token.toLocaleLowerCase("en-US").replace(/’/g, "'")
    .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu)?.join(" ") ?? "";
}

function normalizeLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();
  return normalized === "english" ? "en" : normalized;
}

function aggregateLanguages(languages: string[]): string {
  const detected = new Set(languages.filter((language) => language !== "unknown"));
  if (detected.size === 0) return "unknown";
  if (detected.size === 1) return detected.values().next().value!;
  return "mixed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
