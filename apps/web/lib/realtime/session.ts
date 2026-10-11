import type { RealtimeEvent, RealtimeSessionGrant, RealtimeSpeechRequest,
  RealtimeTransport } from "@drama/ai/realtime/port";

type Options = {
  transport: RealtimeTransport;
  requestGrant: () => Promise<RealtimeSessionGrant>;
  now?: () => Date;
};

export class ActorRealtimeSession {
  private readonly now: () => Date;

  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => new Date());
  }

  async connectAfterUserGesture(): Promise<void> {
    const grant = await this.options.requestGrant();
    const expiryMs = new Date(grant.expiresAt).getTime();
    if (!Number.isFinite(expiryMs)) throw new Error("Realtime grant expiry is invalid");
    if (expiryMs <= this.now().getTime()) {
      throw new Error("Realtime grant has expired");
    }
    await this.options.transport.connect(grant);
  }

  async reconnectAfterUserGesture(): Promise<void> {
    await this.options.transport.close();
    await this.connectAfterUserGesture();
  }

  onEvent(listener: (event: RealtimeEvent) => void): () => void {
    return this.options.transport.onEvent(listener);
  }

  async close(): Promise<void> {
    await this.options.transport.close();
  }
}

type TrackLike = { stop(): void };
type StreamLike = { getTracks(): TrackLike[] };
type DataChannelLike = {
  send(value: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { data: string }) => void): void;
};
type PeerConnectionLike = {
  connectionState: string;
  onconnectionstatechange: (() => void) | null;
  createDataChannel(label: string): DataChannelLike;
  addTrack(track: TrackLike, stream: StreamLike): unknown;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: "answer"; sdp: string }): Promise<void>;
  close(): void;
};

type BrowserOptions = {
  getUserMedia?: (constraints: { audio: true }) => Promise<StreamLike>;
  createPeerConnection?: () => PeerConnectionLike;
  fetch?: typeof fetch;
  nowMs?: () => number;
};

export class BrowserWebRtcTransport implements RealtimeTransport {
  private readonly listeners = new Set<(event: RealtimeEvent) => void>();
  private readonly getUserMedia: (constraints: { audio: true }) => Promise<StreamLike>;
  private readonly createPeerConnection: () => PeerConnectionLike;
  private readonly fetch: typeof fetch;
  private readonly nowMs: () => number;
  private stream: StreamLike | null = null;
  private peer: PeerConnectionLike | null = null;
  private channel: DataChannelLike | null = null;
  private speechActive = false;
  private pendingSpeech: Pick<RealtimeSpeechRequest, "characterId" | "elementId"> | null = null;

  constructor(options: BrowserOptions = {}) {
    this.getUserMedia = options.getUserMedia
      ?? ((constraints) => navigator.mediaDevices.getUserMedia(constraints) as Promise<StreamLike>);
    this.createPeerConnection = options.createPeerConnection
      ?? (() => new RTCPeerConnection() as unknown as PeerConnectionLike);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.nowMs = options.nowMs ?? (() => performance.now());
  }

  async connect(grant: RealtimeSessionGrant): Promise<void> {
    if (this.peer) throw new Error("Realtime transport is already connected");
    const stream = await this.getUserMedia({ audio: true });
    const peer = this.createPeerConnection();
    const channel = peer.createDataChannel("oai-events");
    for (const track of stream.getTracks()) peer.addTrack(track, stream);
    channel.addEventListener("message", (event) => this.handleProviderEvent(event.data));
    peer.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(peer.connectionState)) {
        this.emit({ type: "disconnected", reason: peer.connectionState });
      }
    };
    this.stream = stream;
    this.peer = peer;
    this.channel = channel;
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const response = await this.fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: { authorization: `Bearer ${grant.clientSecret}`, "content-type": "application/sdp" },
      });
      if (!response.ok) throw new Error(`Realtime WebRTC connection failed (${response.status})`);
      await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  sendAudio(chunk: ArrayBuffer): void {
    this.requireChannel().send(JSON.stringify({ type: "input_audio_buffer.append",
      audio: arrayBufferToBase64(chunk) }));
  }

  async requestSpeech(input: RealtimeSpeechRequest): Promise<void> {
    const channel = this.requireChannel();
    this.pendingSpeech = { characterId: input.characterId, elementId: input.elementId };
    channel.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user",
      content: [{ type: "input_text",
        text: `Speak this exact scripted text without paraphrasing: ${input.exactText}` }] } }));
    channel.send(JSON.stringify({ type: "response.create",
      response: { instructions: input.performanceDirection } }));
  }

  onEvent(listener: (event: RealtimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.channel?.close();
    this.peer?.close();
    this.stream = null;
    this.channel = null;
    this.peer = null;
    this.speechActive = false;
    this.pendingSpeech = null;
  }

  private requireChannel(): DataChannelLike {
    if (!this.channel) throw new Error("Realtime transport is not connected");
    return this.channel;
  }

  private handleProviderEvent(raw: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.delta" && typeof event.delta === "string") {
      this.emit({ type: "actor_transcript_partial", text: event.delta });
    } else if (event.type === "conversation.item.input_audio_transcription.completed"
      && typeof event.transcript === "string") {
      this.emit({ type: "actor_transcript_final", text: event.transcript, endedAtMs: this.nowMs() });
    } else if (event.type === "response.output_audio.delta" && !this.speechActive && this.pendingSpeech) {
      this.speechActive = true;
      this.emit({ type: "speech_started", ...this.pendingSpeech, startedAtMs: this.nowMs() });
    } else if (event.type === "response.output_audio.done" && this.speechActive && this.pendingSpeech) {
      this.speechActive = false;
      this.emit({ type: "speech_finished", ...this.pendingSpeech, endedAtMs: this.nowMs() });
      this.pendingSpeech = null;
    } else if (event.type === "response.cancelled") {
      this.speechActive = false;
      this.pendingSpeech = null;
      this.emit({ type: "interrupted", atMs: this.nowMs() });
    }
  }

  private emit(event: RealtimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
