import type { RealtimeEvent, RealtimeSessionGrant, RealtimeSpeechRequest } from "@drama/ai/realtime/port";

import type { RemoteAudioSink } from "./remote-audio-sink";
import { BrowserRemoteAudioSink } from "./remote-audio-sink";
import { WebRtcBase, type PeerConnectionLike } from "./webrtc-base";

export interface RoleVoiceSession {
  speak(input: RealtimeSpeechRequest): Promise<void>;
  cancelSpeech(): Promise<void>;
  close(): Promise<void>;
}

type Options = {
  requestGrant: () => Promise<RealtimeSessionGrant>;
  createPeerConnection?: () => PeerConnectionLike;
  fetch?: typeof fetch;
  audioSink?: RemoteAudioSink;
  nowMs?: () => number;
  onEvent?: (event: RealtimeEvent) => void;
};

export class BrowserRoleVoiceSession implements RoleVoiceSession {
  private readonly base: WebRtcBase;
  private readonly requestGrant: () => Promise<RealtimeSessionGrant>;
  private readonly nowMs: () => number;
  private readonly onEvent: (event: RealtimeEvent) => void;
  private connected = false;
  private pendingSpeech: Pick<RealtimeSpeechRequest, "characterId" | "elementId"> | null = null;
  private pendingResponseId: string | null = null;
  private cancelRequested = false;
  private speechActive = false;
  private responseCompleted = false;
  private playbackStopped = false;
  private speechGeneration = 0;
  private speakingGeneration: number | null = null;
  private speakingPromise: Promise<void> | null = null;
  private readonly closeBarrier: Promise<void>;
  private resolveCloseBarrier: () => void = () => undefined;

  constructor(options: Options) {
    this.requestGrant = options.requestGrant;
    this.closeBarrier = new Promise<void>((resolve) => { this.resolveCloseBarrier = resolve; });
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.onEvent = options.onEvent ?? (() => undefined);
    this.base = new WebRtcBase({ createPeerConnection: options.createPeerConnection
      ?? (() => new RTCPeerConnection() as unknown as PeerConnectionLike),
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    remoteAudioSink: options.audioSink ?? new BrowserRemoteAudioSink(), onProviderEvent: (raw) => this.handleProviderEvent(raw),
    onDisconnected: (reason) => this.onEvent({ type: "disconnected", reason }), onMediaFailure: () => {
      this.connected = false; this.pendingSpeech = null; this.pendingResponseId = null;
      this.onEvent({ type: "disconnected", reason: "remote_audio_playback_failed" });
    } });
  }

  speak(input: RealtimeSpeechRequest): Promise<void> {
    const generation = this.speechGeneration;
    this.speakingGeneration = generation;
    const operation = this.runSpeak(input, generation);
    const tracked = operation.finally(() => {
      if (this.speakingPromise === tracked) this.speakingPromise = null;
    });
    this.speakingPromise = tracked;
    return tracked;
  }

  private async runSpeak(input: RealtimeSpeechRequest, generation: number): Promise<void> {
    if (!this.connected) {
      const grant = await this.requestGrant();
      this.assertSpeechCurrent(generation);
      const expiryMs = new Date(grant.expiresAt).getTime();
      if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) throw new Error("Realtime grant has expired");
      await this.base.connect(grant);
      this.connected = true;
      this.assertSpeechCurrent(generation);
    }
    this.assertSpeechCurrent(generation);
    this.pendingSpeech = { characterId: input.characterId, elementId: input.elementId };
    this.pendingResponseId = null;
    this.cancelRequested = false;
    this.speechActive = false;
    this.responseCompleted = false;
    this.playbackStopped = false;
    this.base.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [
      { type: "input_text", text: `Speak this exact scripted text without paraphrasing: ${input.exactText}` },
    ] } });
    this.base.send({ type: "response.create", response: { instructions: input.performanceDirection } });
    if (this.speakingGeneration === generation) this.speakingGeneration = null;
  }

  async cancelSpeech(): Promise<void> {
    const speaking = this.speakingPromise;
    if (this.speakingGeneration !== null) {
      this.speechGeneration += 1;
      this.speakingGeneration = null;
    }
    if (!this.connected || !this.pendingSpeech || this.cancelRequested) {
      await Promise.race([speaking?.catch(() => undefined), this.closeBarrier]);
      return;
    }
    this.base.send({ type: "response.cancel" });
    this.cancelRequested = true;
    await Promise.race([speaking?.catch(() => undefined), this.closeBarrier]);
  }

  async close(): Promise<void> {
    this.resolveCloseBarrier();
    this.speechGeneration += 1;
    this.speakingGeneration = null;
    this.pendingSpeech = null;
    this.pendingResponseId = null;
    this.cancelRequested = false;
    this.speechActive = false;
    this.responseCompleted = false;
    this.playbackStopped = false;
    this.connected = false;
    await this.base.close();
  }

  private assertSpeechCurrent(generation: number): void {
    if (generation !== this.speechGeneration) throw new Error("Realtime role speech was cancelled");
  }

  private handleProviderEvent(raw: string): void {
    let event: Record<string, unknown>;
    try { event = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (event.type === "response.created" && typeof (event.response as { id?: unknown } | undefined)?.id === "string") {
      this.pendingResponseId = (event.response as { id: string }).id;
    }
    if (event.type === "response.output_audio.delta" && !this.speechActive && this.pendingSpeech
      && event.response_id === this.pendingResponseId) {
      this.speechActive = true;
      this.onEvent({ type: "speech_started", ...this.pendingSpeech, startedAtMs: this.nowMs() });
    }
    if (event.type === "output_audio_buffer.stopped" && event.response_id === this.pendingResponseId) {
      this.playbackStopped = true;
      this.finishCompletedSpeech();
    }
    const response = event.response as { id?: unknown; status?: unknown } | undefined;
    if (event.type === "response.done" && typeof response?.id === "string" && response.id === this.pendingResponseId
      && this.pendingSpeech) {
      if (response.status === "completed") {
        // response.done means generation is complete, but WebRTC may still have
        // buffered audio to play. Keep this role active until the browser-side
        // output buffer reports that audible playback has actually stopped.
        this.responseCompleted = true;
        this.finishCompletedSpeech();
      } else if (response.status === "cancelled") {
        this.onEvent({ type: "interrupted", atMs: this.nowMs() });
        this.clearPendingSpeech();
      }
    }
  }

  private finishCompletedSpeech(): void {
    if (!this.responseCompleted || !this.playbackStopped || !this.pendingSpeech) return;
    this.onEvent({ type: "speech_finished", ...this.pendingSpeech, endedAtMs: this.nowMs() });
    this.clearPendingSpeech();
  }

  private clearPendingSpeech(): void {
    this.speechActive = false;
    this.responseCompleted = false;
    this.playbackStopped = false;
    this.pendingSpeech = null;
    this.pendingResponseId = null;
    this.cancelRequested = false;
  }
}
