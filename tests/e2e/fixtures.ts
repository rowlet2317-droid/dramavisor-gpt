import chromium from "@sparticuz/chromium";
import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

export const test = base.extend<{}, { sharedContext: BrowserContext }>({
launchOptions: async ({ browserName }, use) => {
  if (browserName !== "chromium") {
    throw new Error("The E2E browser fixture requires Chromium");
  }

  // macOS/Windows: use Playwright's installed local browser.
  if (process.platform !== "linux") {
    await use({ headless: true });
    return;
  }

  // Linux CI/serverless: use the Lambda-compatible Chromium build.
  chromium.setGraphicsMode = false;
  const executablePath = await chromium.executablePath();

  const cachePath = "/tmp/task6-chromium-cache";
  await mkdir(cachePath, { recursive: true });
  process.env.XDG_CACHE_HOME = cachePath;
  process.env.FONTCONFIG_FILE = "/etc/fonts/fonts.conf";

  await use({
    executablePath,
    args: chromium.args,
    headless: true,
    ignoreDefaultArgs: ["--enable-unsafe-swiftshader"],
  });
},
  sharedContext: [async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: "http://localhost:3100" });
    await use(context);
    await context.close();
  }, { scope: "worker" }],
  context: async ({ sharedContext }, use) => {
    await sharedContext.clearCookies();
    await use(sharedContext);
  },
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
    await page.close();
  },
});

export { expect };

export async function installProductionProviderBrowserFixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Listener = (event: { data?: string }) => void;
    type FakeTrack = { actorInput: boolean; enabled: boolean; stopped: boolean; stop(): void };
    const metrics: Record<string, number> = {
      microphoneRequests: 0,
      remoteTrackAttachments: 0,
      audioPlayCalls: 0,
      activeRoleResponses: 0,
      configuredAudioConstructed: 0,
      configuredAudioPlaying: 0,
      configuredAudioEnded: 0,
      failedActorConnectionAttempts: 0,
    };
    const microphoneTracks: FakeTrack[] = [];
    const roleRequests: Array<{ exactText: string; direction: string }> = [];
    let actorPeer: FakePeerConnection | null = null;
    let activeRole: { channel: FakeDataChannel; responseId: string } | null = null;
    let queuedRoleExactText: string | null = null;
    let responseSequence = 0;
    let failedActorConnections = 0;
    let expectedFailedActorConnectionAttempts = 0;
    let resolveFailedActorConnections: ((attempts: number) => void) | null = null;

    Object.defineProperty(metrics, "enabledMicrophoneTracks", { enumerable: true, get: () => (
      microphoneTracks.filter((track) => track.enabled && !track.stopped).length
    ) });
    Object.defineProperty(metrics, "enabledActorInputTracks", { enumerable: true, get: () => (
      microphoneTracks.filter((track) => track.actorInput && track.enabled && !track.stopped).length
    ) });

    class FakeDataChannel {
      readyState = "open" as const;
      private readonly listeners = new Map<string, Set<Listener>>();

      constructor(private readonly peer: FakePeerConnection) {}

      send(value: string): void {
        const event = JSON.parse(value) as { type?: string; item?: { content?: Array<{ type?: string; text?: string }> };
          response?: { instructions?: string } };
        if (event.type === "conversation.item.create") {
          const content = event.item?.content?.find((part) => part.type === "input_text");
          queuedRoleExactText = typeof content?.text === "string" ? content.text : null;
        }
        if (event.type === "response.create") {
          roleRequests.push({ exactText: queuedRoleExactText ?? "",
            direction: typeof event.response?.instructions === "string" ? event.response.instructions : "" });
          queuedRoleExactText = null;
          const responseId = `response-${++responseSequence}`;
          activeRole = { channel: this, responseId };
          metrics.activeRoleResponses = 1;
          queueMicrotask(() => {
            this.emit({ type: "response.created", response: { id: responseId } });
            this.emit({ type: "response.output_audio.delta", response_id: responseId, delta: "audio" });
          });
        }
        if (event.type === "response.cancel" && activeRole?.channel === this) {
          const responseId = activeRole.responseId;
          activeRole = null;
          metrics.activeRoleResponses = 0;
          queueMicrotask(() => this.emit({ type: "response.done",
            response: { id: responseId, status: "cancelled" } }));
        }
      }

      close(): void {}

      addEventListener(type: string, listener: Listener): void {
        const listeners = this.listeners.get(type) ?? new Set<Listener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: Listener): void {
        this.listeners.get(type)?.delete(listener);
      }

      emit(event: Record<string, unknown>): void {
        const message = { data: JSON.stringify(event) };
        for (const listener of this.listeners.get("message") ?? []) listener(message);
      }
    }

    class FakePeerConnection {
      connectionState = "new";
      onconnectionstatechange: (() => void) | null = null;
      ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
      readonly channel = new FakeDataChannel(this);
      private local = false;

      createDataChannel(): FakeDataChannel { return this.channel; }

      addTrack(): void {
        this.local = true;
        actorPeer = this;
      }

      async createOffer(): Promise<{ type: string; sdp: string }> {
        return { type: "offer", sdp: this.local ? "fake-actor-offer" : "fake-role-offer" };
      }

      async setLocalDescription(): Promise<void> {}

      async setRemoteDescription(): Promise<void> {
        this.connectionState = "connected";
        if (!this.local && this.ontrack) {
          metrics.remoteTrackAttachments += 1;
          this.ontrack({ streams: [new MediaStream()] });
        }
      }

      close(): void { this.connectionState = "closed"; }

      fail(): void {
        this.connectionState = "failed";
        this.onconnectionstatechange?.();
      }

      isActor(): boolean { return this.local; }
    }

    const mediaDevices = {
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        metrics.microphoneRequests += 1;
        const track: FakeTrack = { actorInput: !("video" in constraints), enabled: true, stopped: false,
          stop() { this.stopped = true; this.enabled = false; } };
        microphoneTracks.push(track);
        return { getTracks: () => [track] };
      },
    };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: mediaDevices });
    Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: undefined });
    Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: undefined });

    class FakeMediaRecorder {
      static isTypeSupported(mimeType: string): boolean { return mimeType.startsWith("audio/webm"); }
      readonly mimeType: string;
      private readonly listeners = new Map<string, Set<(event: Event | { data: Blob }) => void>>();

      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        this.mimeType = options?.mimeType ?? "audio/webm";
      }

      start(): void {}

      stop(): void {
        const data = new Blob([wavBytes()], { type: this.mimeType });
        queueMicrotask(() => {
          for (const listener of this.listeners.get("dataavailable") ?? []) listener({ data });
          for (const listener of this.listeners.get("stop") ?? []) listener(new Event("stop"));
        });
      }

      addEventListener(type: string, listener: (event: Event | { data: Blob }) => void): void {
        const listeners = this.listeners.get(type) ?? new Set<(event: Event | { data: Blob }) => void>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: FakeMediaRecorder });

    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function play() {
      metrics.audioPlayCalls += 1;
      return Promise.resolve();
    };
    void originalPlay;
    class FakeAudio {
      currentTime = 0;
      onended: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onplaying: ((event: Event) => void) | null = null;
      preload = "";
      src = "";

      constructor() { metrics.configuredAudioConstructed += 1; }

      play(): Promise<void> {
        metrics.audioPlayCalls += 1;
        setTimeout(() => {
          metrics.configuredAudioPlaying += 1;
          this.onplaying?.(new Event("playing"));
          metrics.configuredAudioEnded += 1;
          this.onended?.(new Event("ended"));
        }, 0);
        return Promise.resolve();
      }

      pause(): void {}
      remove(): void {}
    }
    Object.defineProperty(window, "Audio", { configurable: true, value: FakeAudio });

    Object.defineProperty(window, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://api.openai.com/v1/realtime/calls") {
        const actorOffer = init?.body === "fake-actor-offer";
        if (actorOffer && failedActorConnections > 0) {
          failedActorConnections -= 1;
          metrics.failedActorConnectionAttempts += 1;
          if (metrics.failedActorConnectionAttempts === expectedFailedActorConnectionAttempts) {
            resolveFailedActorConnections?.(metrics.failedActorConnectionAttempts);
            resolveFailedActorConnections = null;
          }
          return new Response("unavailable", { status: 503 });
        }
        return new Response("fake-answer", { status: 200, headers: { "content-type": "application/sdp" } });
      }
      return originalFetch(input, init);
    };

    const fixture = {
      metrics,
      roleRequests,
      emitActorTranscript(text: string, itemId: string) {
        if (!actorPeer?.isActor()) throw new Error("Actor provider channel is not connected");
        actorPeer.channel.emit({ type: "conversation.item.input_audio_transcription.delta",
          item_id: itemId, content_index: 0, delta: text });
        actorPeer.channel.emit({ type: "conversation.item.input_audio_transcription.completed",
          item_id: itemId, content_index: 0, transcript: text });
      },
      emitActorSpeechStarted() {
        if (!actorPeer?.isActor()) throw new Error("Actor provider channel is not connected");
        actorPeer.channel.emit({ type: "input_audio_buffer.speech_started", audio_start_ms: 0 });
      },
      completeActiveRole() {
        if (!activeRole) throw new Error("No role provider response is active");
        const current = activeRole;
        activeRole = null;
        metrics.activeRoleResponses = 0;
        current.channel.emit({ type: "response.done",
          response: { id: current.responseId, status: "completed" } });
      },
      failActorAndNextReconnects(attempts: number) {
        failedActorConnections = attempts;
        expectedFailedActorConnectionAttempts = metrics.failedActorConnectionAttempts + attempts;
        if (!actorPeer) throw new Error("Actor provider connection is not active");
        const failuresDelivered = attempts === 0
          ? Promise.resolve(metrics.failedActorConnectionAttempts)
          : new Promise<number>((resolve) => { resolveFailedActorConnections = resolve; });
        actorPeer.fail();
        return failuresDelivered;
      },
    };
    Object.defineProperty(window, "__dramaProductionProvider", { configurable: true, value: fixture });

    function wavBytes(): Uint8Array {
      const sampleRate = 16_000;
      const samples = Int16Array.from({ length: sampleRate }, (_, index) =>
        Math.round(8_192 * Math.sin(2 * Math.PI * 220 * index / sampleRate)));
      const bytes = new Uint8Array(44 + samples.length * 2);
      const view = new DataView(bytes.buffer);
      bytes.set([82, 73, 70, 70], 0);
      view.setUint32(4, bytes.length - 8, true);
      bytes.set([87, 65, 86, 69], 8);
      bytes.set([102, 109, 116, 32], 12);
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      bytes.set([100, 97, 116, 97], 36);
      view.setUint32(40, samples.length * 2, true);
      samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
      return bytes;
    }
  });
}
