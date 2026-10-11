import { describe, expect, it, vi } from "vitest";

import { BrowserTakeRecorder, type MediaRecorderLike } from "./recorder";
import type { MicrophoneCheck } from "./microphone-check";

describe("BrowserTakeRecorder", () => {
  it("checks the microphone from the same audio-only stream before recording", async () => {
    const fixture = recorderFixture();

    await fixture.recorder.start();

    expect(fixture.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(fixture.checkStream).toHaveBeenCalledWith(fixture.stream);
    expect(fixture.createMediaRecorder).toHaveBeenCalledWith(fixture.stream,
      { mimeType: "audio/webm;codecs=opus" });
    expect(fixture.native.start).toHaveBeenCalledOnce();
  });

  it("selects a server-supported WebM Opus MIME before constructing the native recorder", async () => {
    const fixture = recorderFixture({ isTypeSupported: (mimeType) => mimeType === "audio/webm;codecs=opus" });

    await fixture.recorder.start();

    expect(fixture.createMediaRecorder).toHaveBeenCalledWith(fixture.stream,
      { mimeType: "audio/webm;codecs=opus" });
  });

  it("blocks recording and releases tracks when the browser has no server-supported recording MIME", async () => {
    const fixture = recorderFixture({ isTypeSupported: () => false });

    await expect(fixture.recorder.start()).rejects.toThrow("WebM audio recording is not supported");

    expect(fixture.createMediaRecorder).not.toHaveBeenCalled();
    expect(fixture.track.stop).toHaveBeenCalledOnce();
  });

  it("treats microphone warnings as advisory", async () => {
    const fixture = recorderFixture({ warnings: ["CLIPPING"] });

    await expect(fixture.recorder.start()).resolves.toBeUndefined();

    expect(fixture.native.start).toHaveBeenCalledOnce();
    expect(fixture.onMicrophoneCheck).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      warnings: ["CLIPPING"],
    }));
  });

  it("does not acquire a second stream after the microphone check", async () => {
    const fixture = recorderFixture();

    await fixture.recorder.start();

    expect(fixture.getUserMedia).toHaveBeenCalledOnce();
  });

  it("mixes the microphone and attached AI voice streams into the recorded stream", async () => {
    const fixture = recorderFixture();
    const remoteStream = { getTracks: () => [] } as unknown as MediaStream;
    const mixedTrack = { stop: vi.fn() };
    const mixedStream = { getTracks: () => [mixedTrack] } as unknown as MediaStream;
    const destination = {} as MediaStreamAudioDestinationNode;
    Object.defineProperty(destination, "stream", { value: mixedStream });
    const microphoneSource = { connect: vi.fn(), disconnect: vi.fn() };
    const remoteSource = { connect: vi.fn(), disconnect: vi.fn() };
    const context = { createMediaStreamDestination: vi.fn(() => destination),
      createMediaStreamSource: vi.fn()
        .mockReturnValueOnce(microphoneSource).mockReturnValueOnce(remoteSource),
      resume: vi.fn(async () => undefined), close: vi.fn(async () => undefined) } as unknown as AudioContext;
    const recorder = new BrowserTakeRecorder({ getUserMedia: fixture.getUserMedia,
      checkStream: fixture.checkStream, createMediaRecorder: fixture.createMediaRecorder,
      isTypeSupported: () => true, createAudioContext: () => context });

    await recorder.start();
    recorder.addAudioStream(remoteStream);

    expect(context.createMediaStreamSource).toHaveBeenNthCalledWith(1, fixture.stream);
    expect(context.createMediaStreamSource).toHaveBeenNthCalledWith(2, remoteStream);
    expect(microphoneSource.connect).toHaveBeenCalledWith(destination);
    expect(remoteSource.connect).toHaveBeenCalledWith(destination);
    expect(fixture.createMediaRecorder).toHaveBeenCalledWith(mixedStream,
      { mimeType: "audio/webm;codecs=opus" });
    recorder.cancel();
    expect(remoteSource.disconnect).toHaveBeenCalledOnce();
    expect(mixedTrack.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("cancels pending microphone permission and stops its stream if permission later resolves", async () => {
    const permission = Promise.withResolvers<MediaStream>();
    const fixture = recorderFixture({ getUserMedia: () => permission.promise, trackCount: 2 });
    const starting = fixture.recorder.start();
    await vi.waitFor(() => expect(fixture.getUserMedia).toHaveBeenCalledOnce());

    fixture.recorder.cancel();
    permission.resolve(fixture.stream);

    await expect(starting).rejects.toThrow("Recording cancelled");
    expect(fixture.checkStream).not.toHaveBeenCalled();
    expect(fixture.createMediaRecorder).not.toHaveBeenCalled();
    expect(fixture.native.start).not.toHaveBeenCalled();
    for (const track of fixture.tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it("does not let a stale cancelled start clear a newer active recording", async () => {
    const firstPermission = Promise.withResolvers<MediaStream>();
    const firstTrack = { stop: vi.fn() };
    const secondTrack = { stop: vi.fn() };
    const firstStream = { getTracks: () => [firstTrack] } as unknown as MediaStream;
    const secondStream = { getTracks: () => [secondTrack] } as unknown as MediaStream;
    const secondNative = new FakeMediaRecorder();
    const getUserMedia = vi.fn()
      .mockImplementationOnce(() => firstPermission.promise)
      .mockResolvedValueOnce(secondStream);
    const createMediaRecorder = vi.fn(() => secondNative);
    const now = vi.fn(() => 1_000);
    const recorder = new BrowserTakeRecorder({
      getUserMedia,
      checkStream: async () => ({ ok: true, rmsDb: -20, peakDb: -5, warnings: [] }),
      createMediaRecorder,
      isTypeSupported: () => true,
      now,
    });
    const staleStart = recorder.start();
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    recorder.cancel();
    await recorder.start();

    const staleResult = expect(staleStart).rejects.toThrow("Recording cancelled");
    firstPermission.resolve(firstStream);
    await staleResult;
    now.mockReturnValue(2_500);
    secondNative.data = [new Uint8Array([4, 5, 6]).buffer];
    const stopping = recorder.stop();
    secondNative.emit("dataavailable", { data: new Blob(secondNative.data, { type: "audio/webm" }) });
    secondNative.emit("stop", new Event("stop"));

    await expect(stopping).resolves.toMatchObject({ durationMs: 1_500, mimeType: "audio/webm" });
    expect(createMediaRecorder).toHaveBeenCalledOnce();
    expect(createMediaRecorder).toHaveBeenCalledWith(secondStream, { mimeType: "audio/webm;codecs=opus" });
    expect(secondNative.start).toHaveBeenCalledOnce();
    expect(secondNative.stop).toHaveBeenCalledOnce();
    expect(firstTrack.stop).toHaveBeenCalledOnce();
    expect(secondTrack.stop).toHaveBeenCalledOnce();
  });

  it("cancels safely while the microphone check is pending without starting a native recorder", async () => {
    const checked = Promise.withResolvers<MicrophoneCheck>();
    const fixture = recorderFixture({ checkStream: () => checked.promise });
    const starting = fixture.recorder.start();
    await vi.waitFor(() => expect(fixture.checkStream).toHaveBeenCalledOnce());

    fixture.recorder.cancel();
    checked.resolve({ ok: true, rmsDb: -20, peakDb: -5, warnings: [] });

    await expect(starting).rejects.toThrow("Recording cancelled");
    expect(fixture.createMediaRecorder).not.toHaveBeenCalled();
    expect(fixture.track.stop).toHaveBeenCalledOnce();
  });

  it("releases the stream when recorder construction fails", async () => {
    const fixture = recorderFixture({ constructorError: new Error("unsupported") });

    await expect(fixture.recorder.start()).rejects.toThrow("unsupported");

    expect(fixture.track.stop).toHaveBeenCalledOnce();
  });

  it("releases the stream when native recording fails to start", async () => {
    const fixture = recorderFixture({ startError: new Error("start failed") });

    await expect(fixture.recorder.start()).rejects.toThrow("start failed");

    expect(fixture.track.stop).toHaveBeenCalledOnce();
  });

  it("releases the stream when the native recorder emits an error", async () => {
    const fixture = recorderFixture();
    await fixture.recorder.start();

    fixture.native.emit("error", new Event("error"));

    expect(fixture.track.stop).toHaveBeenCalledOnce();
  });

  it("releases the stream when a take is cancelled", async () => {
    const fixture = recorderFixture();
    await fixture.recorder.start();

    fixture.recorder.cancel();

    expect(fixture.native.stop).toHaveBeenCalledOnce();
    expect(fixture.track.stop).toHaveBeenCalledOnce();
  });

  it("returns the captured blob and releases the stream after normal stop", async () => {
    const fixture = recorderFixture();
    await fixture.recorder.start();
    fixture.now.mockReturnValue(2_500);
    fixture.native.data = [new Uint8Array([1, 2, 3]).buffer];

    const stopped = fixture.recorder.stop();
    fixture.native.emit("dataavailable", { data: new Blob(fixture.native.data, { type: "audio/webm" }) });
    fixture.native.emit("stop", new Event("stop"));
    const result = await stopped;

    expect(result).toMatchObject({ durationMs: 1_500, mimeType: "audio/webm" });
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(fixture.track.stop).toHaveBeenCalledOnce();
  });
});

function recorderFixture(options: {
  warnings?: Array<"SIGNAL_TOO_LOW" | "CLIPPING" | "BACKGROUND_NOISE">;
  constructorError?: Error;
  startError?: Error;
  checkStream?: (stream: MediaStream) => Promise<MicrophoneCheck>;
  isTypeSupported?: (mimeType: string) => boolean;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  trackCount?: number;
} = {}) {
  const tracks = Array.from({ length: options.trackCount ?? 1 }, () => ({ stop: vi.fn() }));
  const [track] = tracks;
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  const native = new FakeMediaRecorder(options.startError);
  const getUserMedia = vi.fn(options.getUserMedia ?? (async () => stream));
  const checkStream = vi.fn(options.checkStream ?? (async () => ({ ok: true, rmsDb: -20, peakDb: -5,
    warnings: options.warnings ?? [] })));
  const createMediaRecorder = vi.fn(() => {
    if (options.constructorError) throw options.constructorError;
    return native;
  });
  const onMicrophoneCheck = vi.fn();
  const now = vi.fn(() => 1_000);
  return {
    track, tracks, stream, native, getUserMedia, checkStream, createMediaRecorder, onMicrophoneCheck, now,
    recorder: new BrowserTakeRecorder({ getUserMedia, checkStream, createMediaRecorder,
      onMicrophoneCheck, now, isTypeSupported: options.isTypeSupported ?? (() => true) }),
  };
}

class FakeMediaRecorder implements MediaRecorderLike {
  readonly mimeType = "audio/webm";
  readonly start = vi.fn(() => {
    if (this.startError) throw this.startError;
  });
  readonly stop = vi.fn();
  data: ArrayBuffer[] = [];
  private readonly listeners = new Map<string, Array<(event: Event | { data: Blob }) => void>>();

  constructor(private readonly startError?: Error) {}

  addEventListener(type: string, listener: (event: Event | { data: Blob }) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  emit(type: string, event: Event | { data: Blob }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
