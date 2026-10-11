import { describe, expect, it, vi } from "vitest";

import type { RealtimeSessionGrant } from "@drama/ai/realtime/port";

import { BrowserActorInputSession } from "./actor-input-session";
import { BrowserRoleVoiceSession } from "./role-voice-session";
import { BrowserRemoteAudioSink } from "./remote-audio-sink";
import type { MediaStreamLike } from "./webrtc-base";

const validGrant: RealtimeSessionGrant = { clientSecret: "ek_current", expiresAt: "2099-08-23T00:50:00.000Z",
  model: "gpt-realtime-2.1", rehearsalSessionId: "11111111-1111-4111-8111-111111111111" };

describe("BrowserActorInputSession", () => {
  it("binds the browser fetch receiver for default actor WebRTC negotiation", async () => {
    const receiverSensitiveFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response("answer-sdp"));
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", receiverSensitiveFetch);
    try {
      const session = new BrowserActorInputSession({ requestGrant: async () => validGrant,
        getUserMedia: async () => new FakeStream(new FakeTrack()),
        createPeerConnection: () => new FakePeerConnection(new FakeDataChannel()) });

      await session.connectAfterUserGesture();

      expect(receiverSensitiveFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens the microphone only after a gesture and emits identified final transcripts", async () => {
    const track = new FakeTrack();
    const stream = new FakeStream(track);
    const channel = new FakeDataChannel();
    const peer = new FakePeerConnection(channel);
    const getUserMedia = vi.fn(async () => stream);
    const events: Array<unknown> = [];
    const session = new BrowserActorInputSession({ requestGrant: async () => validGrant, getUserMedia,
      createPeerConnection: () => peer, fetch: async () => new Response("answer-sdp"), nowMs: () => 1_200 });
    session.onEvent((event) => events.push(event));

    expect(getUserMedia).not.toHaveBeenCalled();
    await session.connectAfterUserGesture();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    channel.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "item-1",
      content_index: 0, delta: "To " });
    channel.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-1",
      content_index: 0, transcript: "To be" });

    expect(events).toContainEqual({ type: "actor_transcript_final", text: "To be", endedAtMs: 1_200,
      providerItemId: "item-1", contentIndex: 0 });
    session.pauseCapture();
    expect(track.enabled).toBe(false);
    session.resumeCapture();
    expect(track.enabled).toBe(true);
    await session.close("stop");
    peer.connectionState = "closed";
    peer.onconnectionstatechange?.();
    expect(events).not.toContainEqual(expect.objectContaining({ type: "disconnected" }));
  });

  it("emits only one final transcript for duplicate provider completion identity", async () => {
    // Break caught: a provider retry for the same item/content pair can append the actor line twice.
    const channel = new FakeDataChannel();
    const events: Array<unknown> = [];
    const session = new BrowserActorInputSession({ requestGrant: async () => validGrant,
      getUserMedia: async () => new FakeStream(new FakeTrack()),
      createPeerConnection: () => new FakePeerConnection(channel),
      fetch: async () => new Response("answer-sdp"), nowMs: () => 1_200 });
    session.onEvent((event) => events.push(event));
    await session.connectAfterUserGesture();

    channel.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-1",
      content_index: 0, transcript: "To be" });
    channel.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-1",
      content_index: 0, transcript: "To be" });

    expect(events.filter((event) => (event as { type?: string }).type === "actor_transcript_final"))
      .toEqual([{ type: "actor_transcript_final", text: "To be", endedAtMs: 1_200,
        providerItemId: "item-1", contentIndex: 0 }]);
  });

  it("connects recovery media with capture disabled before the track reaches the peer", async () => {
    const track = new FakeTrack();
    const peer = new FakePeerConnection(new FakeDataChannel());
    const session = new BrowserActorInputSession({ requestGrant: async () => validGrant,
      getUserMedia: async () => new FakeStream(track), createPeerConnection: () => peer,
      fetch: async () => new Response("answer-sdp") });

    await session.connectAfterUserGesture({ startPaused: true });

    expect(peer.addedTrackEnabledStates).toEqual([false]);
    expect(track.enabled).toBe(false);
  });

  it("coalesces concurrent actor connects so a second microphone stream cannot overwrite the first", async () => {
    const track = new FakeTrack();
    const peer = new FakePeerConnection(new FakeDataChannel());
    let releaseMedia: () => void = () => undefined;
    const mediaReady = new Promise<void>((resolve) => { releaseMedia = resolve; });
    const getUserMedia = vi.fn(async () => { await mediaReady; return new FakeStream(track); });
    const session = new BrowserActorInputSession({ requestGrant: async () => validGrant, getUserMedia,
      createPeerConnection: () => peer, fetch: async () => new Response("answer-sdp") });

    const first = session.connectAfterUserGesture();
    const concurrent = session.connectAfterUserGesture();
    releaseMedia();
    await Promise.all([first, concurrent]);

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(peer.addedTracks).toEqual([track]);
  });

  it("awaits the in-flight actor connection after media acquisition and during delayed peer negotiation", async () => {
    const track = new FakeTrack();
    const peer = new FakePeerConnection(new FakeDataChannel());
    let releaseNegotiation: (response: Response) => void = () => undefined;
    const negotiation = new Promise<Response>((resolve) => { releaseNegotiation = resolve; });
    const getUserMedia = vi.fn(async () => new FakeStream(track));
    const fetch = vi.fn(async () => negotiation);
    const session = new BrowserActorInputSession({ requestGrant: async () => validGrant, getUserMedia,
      createPeerConnection: () => peer, fetch });

    const first = session.connectAfterUserGesture();
    await vi.waitFor(() => expect(peer.addedTracks).toEqual([track]));
    let secondSettled = false;
    const second = session.connectAfterUserGesture().finally(() => { secondSettled = true; });
    await Promise.resolve();

    expect(secondSettled).toBe(false);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);

    releaseNegotiation(new Response("answer-sdp"));
    await Promise.all([first, second]);

    expect(secondSettled).toBe(true);
    expect(peer.addedTracks).toEqual([track]);
  });

  it.each(["stop", "unmount"] as const)("terminally fences delayed microphone permission on %s", async (reason) => {
    // Break caught: a late getUserMedia result can reopen capture after terminal cleanup has returned.
    const track = new FakeTrack();
    let releaseMedia: (stream: FakeStream) => void = () => undefined;
    const media = new Promise<FakeStream>((resolve) => { releaseMedia = resolve; });
    const createPeerConnection = vi.fn(() => new FakePeerConnection(new FakeDataChannel()));
    const session = new BrowserActorInputSession({ requestGrant: async () => validGrant,
      getUserMedia: async () => media, createPeerConnection,
      fetch: async () => new Response("answer-sdp") });

    const connecting = session.connectAfterUserGesture();
    await Promise.resolve();
    await session.close(reason);
    releaseMedia(new FakeStream(track));

    await expect(connecting).rejects.toThrow("closed");
    expect(track.enabled).toBe(false);
    expect(track.stopCalls).toBe(1);
    expect(createPeerConnection).not.toHaveBeenCalled();
  });

  it.each(["stop", "unmount"] as const)("closes delayed negotiation without reopening media on %s", async (reason) => {
    // Break caught: negotiation continuations can install a live answer/channel after terminal cleanup.
    const track = new FakeTrack();
    const channel = new FakeDataChannel();
    const peer = new FakePeerConnection(channel);
    let releaseNegotiation: (response: Response) => void = () => undefined;
    const negotiation = new Promise<Response>((resolve) => { releaseNegotiation = resolve; });
    const session = new BrowserActorInputSession({ requestGrant: async () => validGrant,
      getUserMedia: async () => new FakeStream(track), createPeerConnection: () => peer,
      fetch: async () => negotiation });

    const connecting = session.connectAfterUserGesture();
    await vi.waitFor(() => expect(peer.addedTracks).toEqual([track]));
    const closing = session.close(reason);
    releaseNegotiation(new Response("answer-sdp"));

    await closing;
    await expect(connecting).rejects.toThrow("closed");
    expect(track.enabled).toBe(false);
    expect(track.stopCalls).toBe(1);
    expect(peer.closeCalls).toBe(1);
    expect(channel.closeCalls).toBe(1);
    expect(channel.readyState).toBe("closed");
  });

  it("dispatches the provider server-VAD speech-start event independently of transcript identity", async () => {
    // Break caught: requiring transcript item/content fields drops input_audio_buffer.speech_started entirely.
    const channel = new FakeDataChannel();
    const events: Array<unknown> = [];
    const session = new BrowserActorInputSession({ requestGrant: async () => validGrant,
      getUserMedia: async () => new FakeStream(new FakeTrack()),
      createPeerConnection: () => new FakePeerConnection(channel),
      fetch: async () => new Response("answer-sdp"), nowMs: () => 1_750 });
    session.onEvent((event) => events.push(event));
    await session.connectAfterUserGesture();

    channel.emit({ type: "input_audio_buffer.speech_started", audio_start_ms: 240 });

    expect(events).toContainEqual({ type: "actor_speech_started", startedAtMs: 1_750,
      providerAudioStartMs: 240 });
  });
});

describe("BrowserRoleVoiceSession", () => {
  it("binds the browser fetch receiver for default role WebRTC negotiation", async () => {
    const receiverSensitiveFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response("answer-sdp"));
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", receiverSensitiveFetch);
    try {
      const session = new BrowserRoleVoiceSession({ requestGrant: async () => validGrant,
        createPeerConnection: () => new FakePeerConnection(new FakeDataChannel()) });

      await session.speak({ characterId: "char-bea", elementId: "line-2", exactText: "We begin.",
        performanceDirection: "Urgent, but controlled." });

      expect(receiverSensitiveFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("attaches remote audio and finishes speech only after generation and audible playback complete", async () => {
    const channel = new FakeDataChannel();
    const peer = new FakePeerConnection(channel);
    const remoteStream = new FakeStream(new FakeTrack());
    const audioSink = { attach: vi.fn(), close: vi.fn() };
    const events: Array<unknown> = [];
    const session = new BrowserRoleVoiceSession({ requestGrant: async () => validGrant,
      createPeerConnection: () => peer, fetch: async () => new Response("answer-sdp"), audioSink,
      nowMs: () => 1_500, onEvent: (event) => events.push(event) });

    await session.speak({ characterId: "char-bea", elementId: "line-2", exactText: "We begin.",
      performanceDirection: "Urgent, but controlled." });

    expect(peer.addedTracks).toEqual([]);
    expect(peer.ontrackInstalledBeforeOffer).toBe(true);
    expect(channel.sent.map((value) => JSON.parse(value))).toContainEqual({ type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text",
        text: "Speak this exact scripted text without paraphrasing: We begin." }] } });
    peer.emitTrack(remoteStream);
    expect(audioSink.attach).toHaveBeenCalledWith(remoteStream);
    channel.emit({ type: "response.created", response: { id: "response-1" } });
    channel.emit({ type: "response.output_audio.delta", response_id: "response-1" });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "speech_finished" }));
    channel.emit({ type: "response.output_audio.done", response_id: "response-1" });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "speech_finished" }));
    channel.emit({ type: "response.done", response: { id: "late-response", status: "completed" } });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "speech_finished" }));
    channel.emit({ type: "response.done", response: { id: "response-1", status: "completed" } });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "speech_finished" }));
    channel.emit({ type: "output_audio_buffer.stopped", response_id: "late-response" });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "speech_finished" }));
    channel.emit({ type: "output_audio_buffer.stopped", response_id: "response-1" });
    expect(events).toContainEqual({ type: "speech_finished", characterId: "char-bea", elementId: "line-2",
      endedAtMs: 1_500 });

    await session.cancelSpeech();
    expect(channel.sent.map((value) => JSON.parse(value))).not.toContainEqual({ type: "response.cancel" });
    await session.close();
    await session.close();
    expect(audioSink.close).toHaveBeenCalledTimes(1);
    expect(channel.closeCalls).toBe(1);
    expect(peer.closeCalls).toBe(1);
  });

  it("waits for the data channel open boundary before sending role speech", async () => {
    const channel = new FakeDataChannel("connecting");
    const peer = new FakePeerConnection(channel);
    let resolveResponse: ((response: Response) => void) | undefined;
    const session = new BrowserRoleVoiceSession({ requestGrant: async () => validGrant,
      createPeerConnection: () => peer,
      fetch: async () => new Promise<Response>((resolve) => { resolveResponse = resolve; }) });

    const speaking = session.speak({ characterId: "char-bea", elementId: "line-2", exactText: "Wait.",
      performanceDirection: "Still." });
    await vi.waitFor(() => expect(resolveResponse).toBeTypeOf("function"));
    resolveResponse!(new Response("answer-sdp"));
    await vi.waitFor(() => expect(channel.listenerCount("open")).toBe(1));
    expect(channel.sent).toEqual([]);
    channel.open();
    await speaking;

    expect(channel.sent).toHaveLength(2);
  });

  it("fences role commands when cancellation wins during credential issuance", async () => {
    // Break caught: late credentials can let a cancelled line send provider speech commands.
    const grant = new DeferredValue<RealtimeSessionGrant>();
    const channel = new FakeDataChannel();
    const session = new BrowserRoleVoiceSession({ requestGrant: () => grant.get(),
      createPeerConnection: () => new FakePeerConnection(channel),
      fetch: async () => new Response("answer-sdp") });

    const speaking = session.speak({ characterId: "char-bea", elementId: "line-2", exactText: "Wait.",
      performanceDirection: "Still." });
    await grant.requested;
    const cancelling = session.cancelSpeech();
    let cancellationSettled = false;
    void cancelling.then(() => { cancellationSettled = true; });
    await Promise.resolve();
    expect(cancellationSettled).toBe(false);
    grant.resolve(validGrant);

    await cancelling;
    await expect(speaking).rejects.toThrow("cancelled");
    expect(channel.sent).toEqual([]);
  });

  it("fences role commands when cancellation wins during WebRTC negotiation", async () => {
    // Break caught: a late WebRTC answer can let a cancelled line send provider speech commands.
    const negotiation = new DeferredValue<Response>();
    const channel = new FakeDataChannel();
    const session = new BrowserRoleVoiceSession({ requestGrant: async () => validGrant,
      createPeerConnection: () => new FakePeerConnection(channel), fetch: () => negotiation.get() });

    const speaking = session.speak({ characterId: "char-bea", elementId: "line-2", exactText: "Wait.",
      performanceDirection: "Still." });
    await negotiation.requested;
    const cancelling = session.cancelSpeech();
    negotiation.resolve(new Response("answer-sdp"));

    await cancelling;
    await expect(speaking).rejects.toThrow("cancelled");
    expect(channel.sent).toEqual([]);
  });

  it("lets terminal close release cancellation while credentials remain unresolved", async () => {
    const grant = new DeferredValue<RealtimeSessionGrant>();
    const session = new BrowserRoleVoiceSession({ requestGrant: () => grant.get(),
      createPeerConnection: () => new FakePeerConnection(new FakeDataChannel()),
      fetch: async () => new Response("answer-sdp") });
    const speaking = session.speak({ characterId: "char-bea", elementId: "line-2", exactText: "Wait.",
      performanceDirection: "Still." });
    await grant.requested;
    const cancelling = session.cancelSpeech();
    await session.close();
    await expect(cancelling).resolves.toBeUndefined();
    grant.resolve(validGrant);
    await expect(speaking).rejects.toThrow("cancelled");
  });

  it("rejects a role connection whose data channel closes before opening", async () => {
    const channel = new FakeDataChannel("connecting");
    const peer = new FakePeerConnection(channel);
    const session = new BrowserRoleVoiceSession({ requestGrant: async () => validGrant,
      createPeerConnection: () => peer, fetch: async () => new Response("answer-sdp") });

    const speaking = session.speak({ characterId: "char-bea", elementId: "line-2", exactText: "Wait.",
      performanceDirection: "Still." });
    await vi.waitFor(() => expect(channel.listenerCount("open")).toBe(1));
    channel.closeBeforeOpen();

    await expect(speaking).rejects.toThrow("data channel closed before opening");
    expect(peer.closeCalls).toBe(1);
  });

  it("rejects a role connection whose data channel errors before opening", async () => {
    const channel = new FakeDataChannel("connecting");
    const peer = new FakePeerConnection(channel);
    const session = new BrowserRoleVoiceSession({ requestGrant: async () => validGrant,
      createPeerConnection: () => peer, fetch: async () => new Response("answer-sdp") });

    const speaking = session.speak({ characterId: "char-bea", elementId: "line-2", exactText: "Wait.",
      performanceDirection: "Still." });
    await vi.waitFor(() => expect(channel.listenerCount("open")).toBe(1));
    channel.errorBeforeOpen();

    await expect(speaking).rejects.toThrow("data channel failed before opening");
    expect(peer.closeCalls).toBe(1);
  });

  it.each(["closed", "closing"] as const)("rejects and cleans up when the channel is already %s", async (readyState) => {
    const channel = new FakeDataChannel(readyState);
    const peer = new FakePeerConnection(channel);
    const audioSink = { attach: vi.fn(), close: vi.fn() };
    const session = new BrowserRoleVoiceSession({ requestGrant: async () => validGrant,
      createPeerConnection: () => peer, fetch: async () => new Response("answer-sdp"), audioSink });

    const speaking = session.speak({ characterId: "char-bea", elementId: "line-2", exactText: "Wait.",
      performanceDirection: "Still." });
    const outcome = await Promise.race([speaking.then(() => "resolved", () => "rejected"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 10))]);

    expect(outcome).toBe("rejected");
    await expect(speaking).rejects.toThrow("data channel closed before opening");
    expect(peer.closeCalls).toBe(1);
    expect(channel.closeCalls).toBe(1);
    expect(audioSink.close).toHaveBeenCalledTimes(1);
  });

  it("sends one cancellation and waits for the matching cancelled response", async () => {
    const channel = new FakeDataChannel();
    const peer = new FakePeerConnection(channel);
    const events: Array<unknown> = [];
    const session = new BrowserRoleVoiceSession({ requestGrant: async () => validGrant,
      createPeerConnection: () => peer, fetch: async () => new Response("answer-sdp"), onEvent: (event) => events.push(event) });
    await session.speak({ characterId: "char-bea", elementId: "line-2", exactText: "Stop.", performanceDirection: "Flat." });
    channel.emit({ type: "response.created", response: { id: "response-2" } });

    await session.cancelSpeech();
    await session.cancelSpeech();
    channel.emit({ type: "response.done", response: { id: "wrong-response", status: "cancelled" } });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "interrupted" }));
    channel.emit({ type: "response.done", response: { id: "response-2", status: "cancelled" } });
    await session.cancelSpeech();

    expect(channel.sent.map((value) => JSON.parse(value)).filter(({ type }) => type === "response.cancel"))
      .toHaveLength(1);
    expect(events).toContainEqual({ type: "interrupted", atMs: expect.any(Number) });
  });

  it("fences role media when remote audio playback fails", async () => {
    const channel = new FakeDataChannel();
    const peer = new FakePeerConnection(channel);
    const audioSink = { attach: async () => { throw new Error("play denied"); }, close: vi.fn() };
    const events: Array<unknown> = [];
    const session = new BrowserRoleVoiceSession({ requestGrant: async () => validGrant,
      createPeerConnection: () => peer, fetch: async () => new Response("answer-sdp"), audioSink,
      onEvent: (event) => events.push(event) });
    await session.speak({ characterId: "char-bea", elementId: "line-2", exactText: "Hear me.", performanceDirection: "Clear." });

    peer.emitTrack(new FakeStream(new FakeTrack()));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toContainEqual({ type: "disconnected", reason: "remote_audio_playback_failed" });
    expect(peer.closeCalls).toBe(1);
    expect(channel.closeCalls).toBe(1);
    expect(audioSink.close).toHaveBeenCalledTimes(1);
  });

  it("ignores a retired remote-audio failure that settles after role close", async () => {
    let rejectAttach: (error: Error) => void = () => undefined;
    const attach = new Promise<void>((_resolve, reject) => { rejectAttach = reject; });
    const events: Array<unknown> = [];
    const peer = new FakePeerConnection(new FakeDataChannel());
    const session = new BrowserRoleVoiceSession({ requestGrant: async () => validGrant,
      createPeerConnection: () => peer, fetch: async () => new Response("answer-sdp"),
      audioSink: { attach: () => attach, close: vi.fn() }, onEvent: (event) => events.push(event) });
    await session.speak({ characterId: "char-bea", elementId: "line-2", exactText: "Hear me.",
      performanceDirection: "Clear." });
    peer.emitTrack(new FakeStream(new FakeTrack()));

    await session.close();
    rejectAttach(new Error("late play rejection"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).not.toContainEqual({ type: "disconnected", reason: "remote_audio_playback_failed" });
    expect(peer.closeCalls).toBe(1);
  });
});

describe("BrowserRemoteAudioSink", () => {
  it("autoplays an attached remote stream and releases its managed element", async () => {
    const element = new FakeAudioElement();
    const stream = new FakeStream(new FakeTrack());
    const onAttach = vi.fn();
    const sink = new BrowserRemoteAudioSink(() => element, onAttach);

    await sink.attach(stream);
    sink.close();

    expect(element.autoplay).toBe(true);
    expect(onAttach).toHaveBeenCalledWith(stream);
    expect(element.playCalls).toBe(1);
    expect(element.paused).toBe(true);
    expect(element.removed).toBe(true);
    expect(element.srcObject).toBeNull();
  });
});

class FakeTrack {
  enabled = true;
  stopCalls = 0;
  stop() { this.enabled = false; this.stopCalls += 1; }
}

class FakeAudioElement {
  autoplay = false;
  srcObject: unknown = null;
  playCalls = 0;
  paused = false;
  removed = false;
  async play() { this.playCalls += 1; }
  pause() { this.paused = true; }
  remove() { this.removed = true; }
}

class FakeStream {
  constructor(private readonly track: FakeTrack) {}
  getTracks() { return [this.track]; }
}

class FakeDataChannel {
  readonly sent: string[] = [];
  closeCalls = 0;
  readyState: "connecting" | "open" | "closing" | "closed";
  private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();
  constructor(readyState: "connecting" | "open" | "closing" | "closed" = "open") { this.readyState = readyState; }
  send(value: string) { this.sent.push(value); }
  close() { this.closeCalls += 1; this.readyState = "closed"; }
  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    const registered = this.listeners.get(type) ?? new Set();
    registered.add(listener); this.listeners.set(type, registered);
  }
  removeEventListener(type: string, listener: (event: { data?: string }) => void) { this.listeners.get(type)?.delete(listener); }
  emit(value: Record<string, unknown>) { this.dispatch("message", { data: JSON.stringify(value) }); }
  open() { this.readyState = "open"; this.dispatch("open", {}); }
  closeBeforeOpen() { this.readyState = "closed"; this.dispatch("close", {}); }
  errorBeforeOpen() { this.dispatch("error", {}); }
  listenerCount(type: string) { return this.listeners.get(type)?.size ?? 0; }
  private dispatch(type: string, event: { data?: string }) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}

class FakePeerConnection {
  readonly addedTracks: Array<unknown> = [];
  readonly addedTrackEnabledStates: boolean[] = [];
  closeCalls = 0;
  ontrackInstalledBeforeOffer = false;
  connectionState = "connected";
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { streams: MediaStreamLike[] }) => void) | null = null;
  constructor(private readonly channel: FakeDataChannel) {}
  createDataChannel() { return this.channel; }
  addTrack(track: unknown) { this.addedTracks.push(track);
    this.addedTrackEnabledStates.push((track as { enabled?: boolean }).enabled === true); }
  async createOffer() { this.ontrackInstalledBeforeOffer = this.ontrack !== null; return { type: "offer", sdp: "offer-sdp" }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() { this.closeCalls += 1; }
  emitTrack(stream: MediaStreamLike) { this.ontrack?.({ streams: [stream] }); }
}

class DeferredValue<T> {
  private resolveRequested: () => void = () => undefined;
  readonly requested = new Promise<void>((resolve) => { this.resolveRequested = resolve; });
  private resolveValue: (value: T) => void = () => undefined;
  private readonly value = new Promise<T>((resolve) => { this.resolveValue = resolve; });
  get(): Promise<T> { this.resolveRequested(); return this.value; }
  resolve(value: T): void { this.resolveValue(value); }
}
