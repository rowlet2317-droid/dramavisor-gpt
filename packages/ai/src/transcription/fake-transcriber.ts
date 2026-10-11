import type { Transcript } from "@drama/domain/transcript";

import type { Transcriber, TranscriptionInput } from "./port";

export class FakeTranscriber implements Transcriber {
  readonly inputs: TranscriptionInput[] = [];

  constructor(readonly version: string, private readonly result: Transcript | (() => Promise<Transcript>)) {}

  async transcribe(input: TranscriptionInput): Promise<Transcript> {
    this.inputs.push({ ...input, audio: input.audio.slice() });
    return typeof this.result === "function" ? this.result() : structuredClone(this.result);
  }
}
