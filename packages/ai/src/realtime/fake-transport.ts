import type { RealtimeEvent, RealtimeSessionGrant, RealtimeSpeechRequest, RealtimeTransport } from "./port";

export class FakeRealtimeTransport implements RealtimeTransport {
  readonly connections: RealtimeSessionGrant[] = [];
  readonly audioChunks: ArrayBuffer[] = [];
  readonly speechRequests: RealtimeSpeechRequest[] = [];
  closeCalls = 0;
  private readonly listeners = new Set<(event: RealtimeEvent) => void>();

  async connect(grant: RealtimeSessionGrant): Promise<void> {
    this.connections.push(grant);
  }

  sendAudio(chunk: ArrayBuffer): void {
    this.audioChunks.push(chunk);
  }

  async requestSpeech(input: RealtimeSpeechRequest): Promise<void> {
    this.speechRequests.push(input);
  }

  onEvent(listener: (event: RealtimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: RealtimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}
