import type { RealtimeSessionGrant } from "@drama/ai/realtime/port";

import type { RemoteAudioSink, RemoteMediaStream } from "./remote-audio-sink";

export type MediaTrackLike = { enabled?: boolean; stop(): void };
export type MediaStreamLike = RemoteMediaStream & { getTracks(): MediaTrackLike[] };
export type DataChannelLike = {
  readyState: "connecting" | "open" | "closing" | "closed";
  send(value: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
  removeEventListener(type: string, listener: (event: { data?: string }) => void): void;
};
export type PeerConnectionLike = {
  connectionState: string;
  onconnectionstatechange: (() => void) | null;
  ontrack: ((event: { streams: MediaStreamLike[] }) => void) | null;
  createDataChannel(label: string): DataChannelLike;
  addTrack(track: MediaTrackLike, stream: MediaStreamLike): unknown;
  addTransceiver?(kind: "audio", init: { direction: "recvonly" }): unknown;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: "answer"; sdp: string }): Promise<void>;
  close(): void;
};

type Options = {
  createPeerConnection: () => PeerConnectionLike;
  fetch: typeof fetch;
  remoteAudioSink?: RemoteAudioSink;
  onProviderEvent(raw: string): void;
  onDisconnected(reason: string): void;
  onMediaFailure(): void;
};

export class WebRtcBase {
  private peer: PeerConnectionLike | null = null;
  private channel: DataChannelLike | null = null;
  private closing = false;
  private messageListener: ((event: { data?: string }) => void) | null = null;
  private openReject: ((reason: Error) => void) | null = null;
  private openListeners: Array<{ type: string; listener: (event: { data?: string }) => void }> = [];
  private lifecycleGeneration = 0;
  private terminal = false;
  private negotiationAbortController: AbortController | null = null;
  private readonly closedPeers = new WeakSet<object>();
  private readonly closedChannels = new WeakSet<object>();

  constructor(private readonly options: Options) {}

  async connect(grant: RealtimeSessionGrant, localStream?: MediaStreamLike): Promise<void> {
    if (this.terminal) throw new Error("Realtime transport is closed");
    if (this.peer) throw new Error("Realtime transport is already connected");
    const generation = this.lifecycleGeneration;
    this.closing = false;
    const peer = this.options.createPeerConnection();
    const channel = peer.createDataChannel("oai-events");
    const negotiationAbortController = new AbortController();
    const messageListener = (event: { data?: string }) => {
      if (typeof event.data === "string") this.options.onProviderEvent(event.data);
    };
    channel.addEventListener("message", messageListener);
    peer.ontrack = (event) => {
      if (!this.isCurrent(generation, peer, channel)) return;
      const stream = event.streams[0];
      try {
        const attached = stream ? this.options.remoteAudioSink?.attach(stream) : undefined;
        if (attached instanceof Promise) void attached.catch(() => {
          void this.handleMediaFailure(generation, peer, channel);
        });
      } catch { void this.handleMediaFailure(generation, peer, channel); }
    };
    peer.onconnectionstatechange = () => {
      if (this.isCurrent(generation, peer, channel) && !this.closing
        && ["disconnected", "failed", "closed"].includes(peer.connectionState)) {
        this.options.onDisconnected(peer.connectionState);
      }
    };
    if (localStream) {
      for (const track of localStream.getTracks()) peer.addTrack(track, localStream);
    } else {
      // An output-only role session has no microphone track. Negotiate a receive-only
      // audio m-line so the provider can attach its generated speech stream.
      peer.addTransceiver?.("audio", { direction: "recvonly" });
    }
    this.peer = peer;
    this.channel = channel;
    this.messageListener = messageListener;
    this.negotiationAbortController = negotiationAbortController;
    try {
      const offer = await peer.createOffer();
      this.assertCurrent(generation, peer, channel);
      await peer.setLocalDescription(offer);
      this.assertCurrent(generation, peer, channel);
      const response = await this.options.fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST", body: offer.sdp,
        headers: { authorization: `Bearer ${grant.clientSecret}`, "content-type": "application/sdp" },
        signal: negotiationAbortController.signal,
      });
      this.assertCurrent(generation, peer, channel);
      if (!response.ok) throw new Error(`Realtime WebRTC connection failed (${response.status})`);
      const answer = await response.text();
      this.assertCurrent(generation, peer, channel);
      await peer.setRemoteDescription({ type: "answer", sdp: answer });
      this.assertCurrent(generation, peer, channel);
      await this.waitForDataChannelOpen(channel, generation, peer);
      this.assertCurrent(generation, peer, channel);
    } catch (error) {
      await this.cleanupConnection(peer, channel, messageListener);
      throw error;
    }
  }

  send(event: Record<string, unknown>): void {
    if (!this.channel) throw new Error("Realtime transport is not connected");
    this.channel.send(JSON.stringify(event));
  }

  async close(): Promise<void> {
    this.terminal = true;
    this.lifecycleGeneration += 1;
    this.closing = true;
    this.negotiationAbortController?.abort();
    this.negotiationAbortController = null;
    const peer = this.peer;
    const channel = this.channel;
    const messageListener = this.messageListener;
    this.openReject?.(new Error("Realtime data channel closed before opening"));
    this.openReject = null;
    this.removeOpenListeners();
    this.peer = null;
    this.channel = null;
    this.messageListener = null;
    if (!peer && !channel) return;
    await this.cleanupConnection(peer, channel, messageListener);
  }

  private async cleanupConnection(peer: PeerConnectionLike | null, channel: DataChannelLike | null,
    messageListener: ((event: { data?: string }) => void) | null): Promise<void> {
    if (channel && messageListener) channel.removeEventListener("message", messageListener);
    if (peer) {
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      if (!this.closedPeers.has(peer)) { this.closedPeers.add(peer); peer.close(); }
    }
    if (channel && !this.closedChannels.has(channel)) { this.closedChannels.add(channel); channel.close(); }
    if (this.peer === peer) this.peer = null;
    if (this.channel === channel) this.channel = null;
    if (this.messageListener === messageListener) this.messageListener = null;
    if (this.negotiationAbortController?.signal.aborted) this.negotiationAbortController = null;
    await this.options.remoteAudioSink?.close();
  }

  private waitForDataChannelOpen(channel: DataChannelLike, generation: number,
    peer: PeerConnectionLike): Promise<void> {
    this.assertCurrent(generation, peer, channel);
    if (channel.readyState === "open") return Promise.resolve();
    if (channel.readyState !== "connecting") {
      return Promise.reject(new Error("Realtime data channel closed before opening"));
    }
    return new Promise((resolve, reject) => {
      const settle = (callback: () => void) => {
        this.openReject = null;
        this.removeOpenListeners();
        callback();
      };
      const onOpen = () => settle(resolve);
      const onClose = () => settle(() => reject(new Error("Realtime data channel closed before opening")));
      const onError = () => settle(() => reject(new Error("Realtime data channel failed before opening")));
      this.openReject = reject;
      this.openListeners = [{ type: "open", listener: onOpen }, { type: "close", listener: onClose },
        { type: "error", listener: onError }];
      for (const entry of this.openListeners) channel.addEventListener(entry.type, entry.listener);
    });
  }

  private removeOpenListeners(): void {
    for (const entry of this.openListeners) this.channel?.removeEventListener(entry.type, entry.listener);
    this.openListeners = [];
  }

  private async handleMediaFailure(generation: number, peer: PeerConnectionLike,
    channel: DataChannelLike): Promise<void> {
    if (!this.isCurrent(generation, peer, channel)) return;
    await this.close();
    this.options.onMediaFailure();
  }

  private isCurrent(generation: number, peer: PeerConnectionLike, channel: DataChannelLike): boolean {
    return !this.terminal && generation === this.lifecycleGeneration && this.peer === peer && this.channel === channel;
  }

  private assertCurrent(generation: number, peer: PeerConnectionLike, channel: DataChannelLike): void {
    if (!this.isCurrent(generation, peer, channel)) throw new Error("Realtime transport is closed");
  }
}
