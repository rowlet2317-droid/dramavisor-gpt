import type { RealtimeSessionGrant } from "@drama/ai/realtime/port";

import { WebRtcBase, type MediaStreamLike, type PeerConnectionLike } from "./webrtc-base";

export type ActorInputEvent =
  | { type: "actor_speech_started"; startedAtMs: number; providerAudioStartMs?: number }
  | { type: "actor_transcript_partial"; text: string; providerItemId: string; contentIndex: number }
  | { type: "actor_transcript_final"; text: string; endedAtMs: number; providerItemId: string; contentIndex: number }
  | { type: "disconnected"; reason: string };

export interface ActorInputSession {
  connectAfterUserGesture(options?: { startPaused?: boolean }): Promise<void>;
  pauseCapture(): void;
  resumeCapture(): void;
  onEvent(listener: (event: ActorInputEvent) => void): () => void;
  close(reason: "stop" | "unmount" | "recovery"): Promise<void>;
}

type Options = {
  requestGrant: () => Promise<RealtimeSessionGrant>;
  getUserMedia?: (constraints: { audio: true }) => Promise<MediaStreamLike>;
  createPeerConnection?: () => PeerConnectionLike;
  fetch?: typeof fetch;
  nowMs?: () => number;
};

export class BrowserActorInputSession implements ActorInputSession {
  private readonly listeners = new Set<(event: ActorInputEvent) => void>();
  private readonly getUserMedia: (constraints: { audio: true }) => Promise<MediaStreamLike>;
  private readonly nowMs: () => number;
  private readonly base: WebRtcBase;
  private stream: MediaStreamLike | null = null;
  private connecting: Promise<void> | null = null;
  private readonly partials = new Map<string, string>();
  private readonly completedTranscriptions = new Set<string>();
  private lifecycleGeneration = 0;
  private terminal = false;

  constructor(options: Options) {
    this.getUserMedia = options.getUserMedia
      ?? ((constraints) => navigator.mediaDevices.getUserMedia(constraints) as Promise<MediaStreamLike>);
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.base = new WebRtcBase({ createPeerConnection: options.createPeerConnection
      ?? (() => new RTCPeerConnection() as unknown as PeerConnectionLike),
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    onProviderEvent: (raw) => this.handleProviderEvent(raw), onDisconnected: (reason) => this.emit({ type: "disconnected", reason }),
    onMediaFailure: () => this.emit({ type: "disconnected", reason: "remote_audio_playback_failed" }) });
    this.requestGrant = options.requestGrant;
  }

  private readonly requestGrant: () => Promise<RealtimeSessionGrant>;

  async connectAfterUserGesture(options: { startPaused?: boolean } = {}): Promise<void> {
    if (this.terminal) throw new Error("Actor input session is closed");
    if (this.connecting) return this.connecting;
    if (this.stream) return;
    const generation = this.lifecycleGeneration;
    this.connecting ??= this.connect(options, generation).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connect(options: { startPaused?: boolean }, generation: number): Promise<void> {
    const grant = await this.requestGrant();
    this.assertCurrent(generation);
    const expiryMs = new Date(grant.expiresAt).getTime();
    if (!Number.isFinite(expiryMs)) throw new Error("Realtime grant expiry is invalid");
    if (expiryMs <= Date.now()) throw new Error("Realtime grant has expired");
    const stream = await this.getUserMedia({ audio: true });
    if (!this.isCurrent(generation)) {
      this.stopStream(stream);
      throw new Error("Actor input session is closed");
    }
    if (options.startPaused) for (const track of stream.getTracks()) track.enabled = false;
    this.stream = stream;
    try {
      await this.base.connect(grant, stream);
      this.assertCurrent(generation);
    } catch (error) {
      if (this.stream === stream) { this.stopStream(stream); this.stream = null; }
      throw error;
    }
  }

  pauseCapture(): void { for (const track of this.stream?.getTracks() ?? []) track.enabled = false; }
  resumeCapture(): void { for (const track of this.stream?.getTracks() ?? []) track.enabled = true; }
  onEvent(listener: (event: ActorInputEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close(_reason: "stop" | "unmount" | "recovery"): Promise<void> {
    this.terminal = true;
    this.lifecycleGeneration += 1;
    if (this.stream) this.stopStream(this.stream);
    this.stream = null;
    this.partials.clear();
    this.completedTranscriptions.clear();
    await this.base.close();
    this.listeners.clear();
  }

  private handleProviderEvent(raw: string): void {
    let event: Record<string, unknown>;
    try { event = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (event.type === "input_audio_buffer.speech_started") {
      this.emit({ type: "actor_speech_started", startedAtMs: this.nowMs(),
        ...(typeof event.audio_start_ms === "number" && Number.isFinite(event.audio_start_ms)
          ? { providerAudioStartMs: event.audio_start_ms } : {}) });
      return;
    }
    const itemId = typeof event.item_id === "string" ? event.item_id : null;
    const contentIndex = typeof event.content_index === "number" ? event.content_index : null;
    if (!itemId || contentIndex === null) return;
    const key = `${itemId}:${contentIndex}`;
    if (event.type === "conversation.item.input_audio_transcription.delta" && typeof event.delta === "string") {
      if (this.completedTranscriptions.has(key)) return;
      const text = (this.partials.get(key) ?? "") + event.delta;
      this.partials.set(key, text);
      this.emit({ type: "actor_transcript_partial", text, providerItemId: itemId, contentIndex });
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      if (this.completedTranscriptions.has(key)) return;
      this.completedTranscriptions.add(key);
      const text = typeof event.transcript === "string" ? event.transcript : this.partials.get(key);
      this.partials.delete(key);
      if (text) this.emit({ type: "actor_transcript_final", text, endedAtMs: this.nowMs(),
        providerItemId: itemId, contentIndex });
    }
  }

  private emit(event: ActorInputEvent): void { for (const listener of this.listeners) listener(event); }

  private isCurrent(generation: number): boolean {
    return !this.terminal && generation === this.lifecycleGeneration;
  }

  private assertCurrent(generation: number): void {
    if (!this.isCurrent(generation)) throw new Error("Actor input session is closed");
  }

  private stopStream(stream: MediaStreamLike): void {
    for (const track of stream.getTracks()) { track.enabled = false; track.stop(); }
  }
}
