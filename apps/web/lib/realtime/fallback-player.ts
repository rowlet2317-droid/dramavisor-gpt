import { TtsFallbackVoice, type TtsPlayback } from "@drama/ai/character-voice/tts-fallback";
import type { CharacterVoice } from "@drama/ai/character-voice/port";
import type { RealtimeSpeechRequest } from "@drama/ai/realtime/port";
import type { VoiceAssignment } from "@drama/domain/rehearsal/voice-assignment";

export type ScriptedVoiceCapability =
  | { ready: true; mode: "configured_tts" | "browser_distinct_voices" }
  | { ready: false; reason: "tts_unconfigured" | "distinct_browser_voices_unavailable" };

export type BrowserVoice = { name: string; lang: string; localService: boolean };

export type FallbackReadiness = {
  aiSpeech: "configured_tts" | "browser_distinct_voices" | "unavailable";
  actorProgress: "realtime_transcription" | "browser_recognition" | "manual";
  canContinue: boolean;
};

export function fallbackReadiness(input: { tts: boolean; browserDistinctVoices?: boolean;
  realtimeTranscript: boolean; browserRecognition: boolean }): FallbackReadiness {
  const aiSpeech = input.tts ? "configured_tts" : input.browserDistinctVoices
    ? "browser_distinct_voices" : "unavailable";
  const actorProgress = input.realtimeTranscript ? "realtime_transcription" : input.browserRecognition
    ? "browser_recognition" : "manual";
  return { aiSpeech, actorProgress, canContinue: aiSpeech !== "unavailable" };
}

export function browserActorRecognitionAvailable(): boolean {
  const source = globalThis as typeof globalThis & { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return typeof source.SpeechRecognition === "function" || typeof source.webkitSpeechRecognition === "function";
}

export function scriptedVoiceCapability(assignments: VoiceAssignment[], input: { configuredTts: boolean;
  browserVoices?: Iterable<BrowserVoice> }): ScriptedVoiceCapability {
  if (input.configuredTts) return { ready: true, mode: "configured_tts" };
  if (!input.browserVoices) return { ready: false, reason: "tts_unconfigured" };
  const voices = [...input.browserVoices];
  const selectedNames = assignments.map(({ voice }) => resolveBrowserVoice(voice, voices)?.name);
  if (selectedNames.some((name) => !name) || new Set(selectedNames).size !== assignments.length) {
    return { ready: false, reason: "distinct_browser_voices_unavailable" };
  }
  return { ready: true, mode: "browser_distinct_voices" };
}

type FallbackPlayerOptions = {
  assignments: VoiceAssignment[];
  createPlayback: (assignment: VoiceAssignment) => TtsPlayback;
  acknowledgedElementIds?: Iterable<string>;
  onSpeechStarted?: (input: { characterId: string; elementId: string; startedAtMs: number }) => void;
  onSpeechFinished?: (input: { characterId: string; elementId: string; endedAtMs: number }) => void;
  nowMs?: () => number;
};

export class ScriptedFallbackPlayer {
  private readonly assignments: Map<string, VoiceAssignment>;
  private readonly completed: Set<string>;
  private readonly voices = new Map<string, CharacterVoice>();
  private readonly nowMs: () => number;

  constructor(private readonly options: FallbackPlayerOptions) {
    this.assignments = new Map(options.assignments.map((assignment) => [assignment.characterId, assignment]));
    this.completed = new Set(options.acknowledgedElementIds);
    this.nowMs = options.nowMs ?? (() => performance.now());
  }

  async speak(input: RealtimeSpeechRequest): Promise<{ skipped: boolean }> {
    if (this.completed.has(input.elementId)) return { skipped: true };
    const voice = this.voiceFor(input.characterId);
    await voice.speak({ characterId: input.characterId, elementId: input.elementId,
      exactText: input.exactText, direction: input.performanceDirection }, { onStarted: (startedAtMs) => {
      this.options.onSpeechStarted?.({ characterId: input.characterId, elementId: input.elementId, startedAtMs });
    } });
    this.completed.add(input.elementId);
    this.options.onSpeechFinished?.({ characterId: input.characterId, elementId: input.elementId,
      endedAtMs: this.nowMs() });
    return { skipped: false };
  }

  async stop(): Promise<void> {
    const voices = [...this.voices.values()];
    this.voices.clear();
    await Promise.all(voices.map((voice) => voice.stop()));
  }

  private voiceFor(characterId: string): CharacterVoice {
    const existing = this.voices.get(characterId);
    if (existing) return existing;
    const assignment = this.assignments.get(characterId);
    if (!assignment) throw new Error(`No fallback voice assignment for character ${characterId}`);
    const voice = new TtsFallbackVoice(assignment.voice, this.options.createPlayback(assignment), this.nowMs);
    this.voices.set(characterId, voice);
    return voice;
  }
}

export class BrowserSpeechSynthesisPlayback implements TtsPlayback {
  private active: { utterance: SpeechSynthesisUtterance; cancel: () => void } | null = null;

  async speak(input: { voice: string; exactText: string; direction: string; onStarted?: () => void }): Promise<void> {
    if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") {
      throw new Error("Scripted voice playback is unavailable in this browser");
    }
    await this.stop();
    const utterance = new SpeechSynthesisUtterance(input.exactText);
    const selectedVoice = resolveBrowserVoice(input.voice, speechSynthesis.getVoices());
    if (!selectedVoice) throw new Error(`No suitable browser voice is available for ${input.voice}`);
    utterance.voice = selectedVoice;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let started = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        utterance.onstart = null;
        utterance.onend = null;
        utterance.onerror = null;
        if (this.active?.utterance === utterance) this.active = null;
        if (error) reject(error); else resolve();
      };
      utterance.onstart = () => {
        if (settled || started) return;
        started = true;
        input.onStarted?.();
      };
      utterance.onend = () => settle();
      utterance.onerror = () => settle(new Error("Scripted voice playback failed"));
      this.active = { utterance, cancel: () => settle(new Error("Scripted voice playback was cancelled")) };
      speechSynthesis.speak(utterance);
    });
  }

  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = null;
    active.cancel();
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }
}

type ServerAudioElement = Pick<HTMLAudioElement, "currentTime" | "onended" | "onerror" | "onplaying"
  | "pause" | "play" | "preload" | "remove" | "src"> & { captureStream?: () => MediaStream };

type ServerConfiguredTtsPlaybackOptions = {
  rehearsalSessionId: string;
  fetch?: typeof fetch;
  createAudio?: () => ServerAudioElement;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  onAudioStream?: (stream: MediaStream) => void;
};

type ActiveServerPlayback = {
  abortController: AbortController;
  audio: ServerAudioElement | null;
  objectUrl: string | null;
  settled: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
};

export class ServerConfiguredTtsPlayback implements TtsPlayback {
  private active: ActiveServerPlayback | null = null;
  private readonly fetch: typeof fetch;
  private readonly createAudio: () => ServerAudioElement;
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (url: string) => void;

  constructor(private readonly options: ServerConfiguredTtsPlaybackOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.createAudio = options.createAudio ?? (() => new Audio());
    this.createObjectUrl = options.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectUrl = options.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url));
  }

  async speak(input: { elementId: string; onStarted?: () => void }): Promise<void> {
    await this.stop();
    let resolve: () => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const completion = new Promise<void>((resolveCompletion, rejectCompletion) => {
      resolve = resolveCompletion;
      reject = rejectCompletion;
    });
    const active: ActiveServerPlayback = { abortController: new AbortController(), audio: null,
      objectUrl: null, settled: false, resolve, reject };
    this.active = active;
    void this.start(active, input);
    return completion;
  }

  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.abortController.abort();
    active.audio?.pause();
    if (active.audio) active.audio.currentTime = 0;
    this.settle(active, new Error("Configured TTS playback was cancelled"));
  }

  private async start(active: ActiveServerPlayback, input: { elementId: string; onStarted?: () => void }) {
    try {
      const response = await this.fetch(`/api/rehearsals/${encodeURIComponent(this.options.rehearsalSessionId)}/speech`,
        { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ elementId: input.elementId }), signal: active.abortController.signal });
      if (!response.ok) throw new Error("Configured TTS audio could not be generated");
      const contentType = response.headers.get("content-type")?.split(";", 1)[0];
      if (!contentType?.startsWith("audio/")) throw new Error("Configured TTS returned invalid audio");
      const blob = await response.blob();
      if (!this.isCurrent(active)) return;
      const objectUrl = this.createObjectUrl(blob);
      const audio = this.createAudio();
      active.objectUrl = objectUrl;
      active.audio = audio;
      audio.preload = "auto";
      audio.src = objectUrl;
      let started = false;
      audio.onplaying = () => {
        if (!this.isCurrent(active) || started) return;
        started = true;
        const stream = audio.captureStream?.();
        if (stream) this.options.onAudioStream?.(stream);
        input.onStarted?.();
      };
      audio.onended = () => this.settle(active);
      audio.onerror = () => this.settle(active, new Error("Configured TTS playback failed"));
      await audio.play();
    } catch (error) {
      if (!active.settled) this.settle(active, active.abortController.signal.aborted
        ? new Error("Configured TTS playback was cancelled")
        : new Error("Configured TTS audio could not be played"));
    }
  }

  private isCurrent(active: ActiveServerPlayback): boolean {
    return this.active === active && !active.settled && !active.abortController.signal.aborted;
  }

  private settle(active: ActiveServerPlayback, error?: Error): void {
    if (active.settled) return;
    active.settled = true;
    if (this.active === active) this.active = null;
    if (active.audio) {
      active.audio.onplaying = null;
      active.audio.onended = null;
      active.audio.onerror = null;
      active.audio.remove();
    }
    if (active.objectUrl) this.revokeObjectUrl(active.objectUrl);
    if (error) active.reject(error); else active.resolve();
  }
}

type SpeechRecognitionResultLike = { isFinal: boolean; 0?: { transcript?: string } };
type SpeechRecognitionEventLike = { resultIndex: number; results: ArrayLike<SpeechRecognitionResultLike> };
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};

export class BrowserActorLineRecognition {
  private recognition: SpeechRecognitionLike | null = null;

  constructor(private readonly onTranscript: (input: { text: string; final: boolean }) => void,
    private readonly createRecognition: (() => SpeechRecognitionLike | null) = browserRecognition) {}

  start(): void {
    if (this.recognition) return;
    const recognition = this.createRecognition();
    if (!recognition) return;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript?.trim();
        if (text) this.onTranscript({ text, final: result.isFinal });
      }
    };
    recognition.onerror = () => undefined;
    this.recognition = recognition;
    recognition.start();
  }

  stop(): void {
    this.recognition?.stop();
    this.recognition = null;
  }
}

function resolveBrowserVoice<T extends BrowserVoice>(requestedVoice: string, supported: Iterable<T>): T | undefined {
  const requested = requestedVoice.trim().toLocaleLowerCase();
  return [...supported].find((voice) => voice.localService && /^en(?:-|$)/i.test(voice.lang)
    && voice.name.toLocaleLowerCase().includes(requested));
}

function browserRecognition(): SpeechRecognitionLike | null {
  const source = globalThis as typeof globalThis & { SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  const Constructor = source.SpeechRecognition ?? source.webkitSpeechRecognition;
  return Constructor ? new Constructor() : null;
}
