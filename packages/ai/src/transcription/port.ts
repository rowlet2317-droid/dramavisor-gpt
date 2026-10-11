import type { Transcript } from "@drama/domain/transcript";

export type TranscriptionInput = {
  audio: Uint8Array;
  filename: string;
};

export interface Transcriber {
  readonly version: string;
  transcribe(input: TranscriptionInput): Promise<Transcript>;
}
