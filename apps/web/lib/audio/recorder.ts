import { checkMicrophoneStream, type MicrophoneCheck } from "./microphone-check";

export interface TakeRecorder {
  start(): Promise<void>;
  addAudioStream?(stream: MediaStream): void;
  stop(): Promise<{ blob: Blob; durationMs: number; mimeType: string }>;
  cancel(): void;
}

export interface MediaRecorderLike {
  readonly mimeType: string;
  start(): void;
  stop(): void;
  addEventListener(type: string, listener: (event: Event | { data: Blob }) => void): void;
}

type RecorderOptions = {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  checkStream?: (stream: MediaStream) => Promise<MicrophoneCheck>;
  createMediaRecorder?: (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorderLike;
  isTypeSupported?: (mimeType: string) => boolean;
  onMicrophoneCheck?: (result: MicrophoneCheck) => void;
  now?: () => number;
  createAudioContext?: () => AudioContext;
};

export class BrowserTakeRecorder implements TakeRecorder {
  private readonly getUserMedia: NonNullable<RecorderOptions["getUserMedia"]>;
  private readonly checkStream: NonNullable<RecorderOptions["checkStream"]>;
  private readonly createMediaRecorder: NonNullable<RecorderOptions["createMediaRecorder"]>;
  private readonly isTypeSupported: NonNullable<RecorderOptions["isTypeSupported"]>;
  private readonly onMicrophoneCheck: NonNullable<RecorderOptions["onMicrophoneCheck"]>;
  private readonly now: NonNullable<RecorderOptions["now"]>;
  private readonly createAudioContext: RecorderOptions["createAudioContext"];
  private stream?: MediaStream;
  private streamGeneration?: number;
  private recorder?: MediaRecorderLike;
  private recorderGeneration?: number;
  private startedAt?: number;
  private chunks: Blob[] = [];
  private recorderError?: Error;
  private startGeneration = 0;
  private starting = false;
  private audioContext?: AudioContext;
  private recordingDestination?: MediaStreamAudioDestinationNode;
  private readonly mixedSources: MediaStreamAudioSourceNode[] = [];

  constructor(options: RecorderOptions = {}) {
    this.getUserMedia = options.getUserMedia ?? ((constraints) => navigator.mediaDevices.getUserMedia(constraints));
    this.checkStream = options.checkStream ?? checkMicrophoneStream;
    this.createMediaRecorder = options.createMediaRecorder ?? ((stream, recorderOptions) =>
      new MediaRecorder(stream, recorderOptions));
    this.isTypeSupported = options.isTypeSupported ?? ((mimeType) => MediaRecorder.isTypeSupported(mimeType));
    this.onMicrophoneCheck = options.onMicrophoneCheck ?? (() => undefined);
    this.now = options.now ?? (() => performance.now());
    this.createAudioContext = options.createAudioContext;
  }

  async start(): Promise<void> {
    if (this.starting || this.stream || this.recorder) throw new Error("A take is already recording");
    const generation = ++this.startGeneration;
    this.starting = true;
    let stream: MediaStream | undefined;
    try {
      stream = await this.getUserMedia({ audio: true, video: false });
      if (generation !== this.startGeneration) {
        if (this.stream !== stream || this.streamGeneration === generation) this.stopStream(stream);
        throw new Error("Recording cancelled");
      }
      this.stream = stream;
      this.streamGeneration = generation;
      const check = await this.checkStream(stream).catch((): MicrophoneCheck => ({
        ok: true,
        rmsDb: Number.NEGATIVE_INFINITY,
        peakDb: Number.NEGATIVE_INFINITY,
        warnings: ["SIGNAL_TOO_LOW"],
      }));
      if (generation !== this.startGeneration || this.stream !== stream) throw new Error("Recording cancelled");
      this.onMicrophoneCheck(check);
      const mimeType = ["audio/webm;codecs=opus", "audio/webm"]
        .find((candidate) => this.isTypeSupported(candidate));
      if (!mimeType) throw new Error("WebM audio recording is not supported by this browser");
      const recordingStream = await this.createMixedRecordingStream(stream);
      const recorder = this.createMediaRecorder(recordingStream, { mimeType });
      this.recorder = recorder;
      this.recorderGeneration = generation;
      this.chunks = [];
      this.recorderError = undefined;
      recorder.addEventListener("dataavailable", (event) => {
        if (this.recorderGeneration === generation && "data" in event && event.data.size > 0) {
          this.chunks.push(event.data);
        }
      });
      recorder.addEventListener("error", () => {
        if (this.recorderGeneration !== generation) return;
        this.recorderError = new Error("Recording failed");
        this.releaseStream(generation);
      });
      recorder.start();
      this.startedAt = this.now();
    } catch (error) {
      if (this.recorderGeneration === generation) {
        this.recorder = undefined;
        this.recorderGeneration = undefined;
      }
      this.releaseStream(generation);
      throw error;
    } finally {
      if (generation === this.startGeneration) this.starting = false;
    }
  }

  addAudioStream(stream: MediaStream): void {
    if (!this.audioContext || !this.recordingDestination) return;
    const source = this.audioContext.createMediaStreamSource(stream);
    source.connect(this.recordingDestination);
    this.mixedSources.push(source);
  }

  async stop(): Promise<{ blob: Blob; durationMs: number; mimeType: string }> {
    const recorder = this.recorder;
    const startedAt = this.startedAt;
    if (!recorder || startedAt === undefined) throw new Error("No take is recording");
    const durationMs = Math.max(0, this.now() - startedAt);
    return new Promise((resolve, reject) => {
      recorder.addEventListener("stop", () => {
        const error = this.recorderError;
        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(this.chunks, { type: mimeType });
        this.recorder = undefined;
        this.recorderGeneration = undefined;
        this.startedAt = undefined;
        this.chunks = [];
        this.releaseStream();
        if (error) reject(error);
        else resolve({ blob, durationMs, mimeType });
      });
      try {
        recorder.stop();
      } catch (error) {
        this.recorder = undefined;
        this.recorderGeneration = undefined;
        this.startedAt = undefined;
        this.releaseStream();
        reject(error);
      }
    });
  }

  cancel(): void {
    this.startGeneration += 1;
    this.starting = false;
    const recorder = this.recorder;
    this.recorder = undefined;
    this.recorderGeneration = undefined;
    this.startedAt = undefined;
    this.chunks = [];
    try {
      recorder?.stop();
    } finally {
      this.releaseStream();
    }
  }

  private releaseStream(generation?: number): void {
    if (generation !== undefined && this.streamGeneration !== generation) return;
    const stream = this.stream;
    this.stream = undefined;
    this.streamGeneration = undefined;
    this.releaseMixer();
    if (stream) this.stopStream(stream);
  }

  private async createMixedRecordingStream(microphone: MediaStream): Promise<MediaStream> {
    const createAudioContext = this.createAudioContext
      ?? (typeof AudioContext === "undefined" ? undefined : () => new AudioContext());
    if (!createAudioContext) return microphone;
    const context = createAudioContext();
    const destination = context.createMediaStreamDestination();
    const microphoneSource = context.createMediaStreamSource(microphone);
    microphoneSource.connect(destination);
    this.audioContext = context;
    this.recordingDestination = destination;
    this.mixedSources.push(microphoneSource);
    await context.resume();
    return destination.stream;
  }

  private releaseMixer(): void {
    for (const source of this.mixedSources.splice(0)) source.disconnect();
    const context = this.audioContext;
    const destination = this.recordingDestination;
    this.audioContext = undefined;
    this.recordingDestination = undefined;
    for (const track of destination?.stream.getTracks() ?? []) track.stop();
    if (context) void context.close();
  }

  private stopStream(stream: MediaStream): void {
    for (const track of stream.getTracks()) track.stop();
  }
}
