import type { CharacterSpeechInput, CharacterVoice } from "@drama/ai/character-voice/port";
import type { VoiceAssignment } from "@drama/domain/rehearsal/voice-assignment";

import type { RoleVoiceSession } from "./role-voice-session";

const REALTIME_ROLE_LIMIT = 4;

export type QueuedCharacterSpeech = CharacterSpeechInput & { ordinal: number };
export type VoicePoolEvent = { type: "interrupted"; elementId: string; atMs: number };
export type RoleVoicePlayback = { startedAtMs: number; completion: Promise<void> };
export type VoiceCancellationReason = "interruption" | "pause" | "disconnect";

type PoolOptions = {
  assignments: VoiceAssignment[];
  createRealtimeSession: (assignment: VoiceAssignment) => RoleVoiceSession | Promise<RoleVoiceSession>;
  createTtsVoice: (assignment: VoiceAssignment) => CharacterVoice | Promise<CharacterVoice>;
  nowMs?: () => number;
  onEvent?: (event: VoicePoolEvent) => void;
};

type PendingSpeech = {
  input: QueuedCharacterSpeech;
  resolve: (result: RoleVoicePlayback) => void;
  reject: (error: unknown) => void;
};

type OpenRoleVoice =
  | { assignment: VoiceAssignment; kind: "realtime"; session: RoleVoiceSession }
  | { assignment: VoiceAssignment; kind: "tts"; voice: CharacterVoice };

export class VoicePoolStoppedError extends Error {
  constructor() {
    super("Character voice pool has stopped");
    this.name = "VoicePoolStoppedError";
  }
}

export class VoicePoolInterruptedError extends Error {
  constructor() {
    super("Queued speech was cancelled by an interruption");
    this.name = "VoicePoolInterruptedError";
  }
}

export class RoleVoiceSessionPool {
  private readonly assignments: Map<string, VoiceAssignment>;
  private readonly voices = new Map<string, OpenRoleVoice>();
  private readonly closedVoices = new WeakSet<object>();
  private readonly queue: PendingSpeech[] = [];
  private readonly cancelledPending = new WeakSet<PendingSpeech>();
  private readonly nowMs: () => number;
  private active: { elementId: string; characterId: string; cancel: () => Promise<void> } | null = null;
  private opening: { pending: PendingSpeech; characterId: string } | null = null;
  private activeCancellation: { elementId: string; promise: Promise<void> } | null = null;
  private draining = false;
  private drainScheduled = false;
  private drainTask: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private stopped = false;
  private interruptedElement: string | null = null;
  private awaitingInterruptionChoice = false;

  constructor(private readonly options: PoolOptions) {
    this.assignments = new Map(options.assignments.map((assignment) => [assignment.characterId, { ...assignment }]));
    if (this.assignments.size !== options.assignments.length) throw new Error("Voice assignments require unique character IDs");
    if ([...this.assignments.values()].filter(({ engine }) => engine === "realtime").length > REALTIME_ROLE_LIMIT) {
      throw new Error(`A rehearsal may use at most ${REALTIME_ROLE_LIMIT} realtime role assignments`);
    }
    this.nowMs = options.nowMs ?? (() => performance.now());
  }

  get connectedRealtimeCount(): number {
    return [...this.voices.values()].filter(({ kind }) => kind === "realtime").length;
  }

  get activeElementId(): string | null {
    return this.active?.elementId ?? null;
  }

  get interruptedElementId(): string | null {
    return this.interruptedElement;
  }

  assignmentFor(characterId: string): VoiceAssignment | undefined {
    const assignment = this.assignments.get(characterId);
    return assignment && { ...assignment };
  }

  speak(input: QueuedCharacterSpeech): Promise<RoleVoicePlayback> {
    if (this.stopped) return Promise.reject(new VoicePoolStoppedError());
    if (this.awaitingInterruptionChoice) return Promise.reject(new VoicePoolInterruptedError());
    const promise = new Promise<RoleVoicePlayback>((resolve, reject) => {
      this.queue.push({ input: structuredClone(input), resolve, reject });
      this.queue.sort((left, right) => left.input.ordinal - right.input.ordinal
        || left.input.elementId.localeCompare(right.input.elementId));
    });
    this.scheduleDrain();
    return promise;
  }

  async speechFinished(elementId: string): Promise<void> {
    if (this.active?.elementId !== elementId) return;
    this.active = null;
    await this.startDrain();
  }

  async cancelActive(atMs: number, reason: VoiceCancellationReason = "interruption"):
    Promise<{ elementId: string } | null> {
    const active = this.active;
    if (active) {
      const cancellation = active.cancel();
      if (this.active?.elementId === active.elementId) this.active = null;
      if (reason === "interruption") this.installInterruption(active.elementId, atMs);
      else this.rejectQueue(new VoicePoolInterruptedError());
      const tracked = cancellation.then(() => undefined, () => {
        if (reason === "interruption") this.installInterruption(active.elementId, atMs);
      });
      this.activeCancellation = { elementId: active.elementId, promise: tracked };
      void tracked.then(() => {
        if (this.activeCancellation?.promise !== tracked) return;
        this.activeCancellation = null;
        if (!this.stopped && !this.awaitingInterruptionChoice) this.scheduleDrain();
      });
      await tracked;
      return { elementId: active.elementId };
    }
    const opening = this.opening;
    if (!opening) return null;
    if (reason === "interruption") this.installInterruption(opening.pending.input.elementId, atMs);
    else {
      this.cancelledPending.add(opening.pending);
      opening.pending.reject(new VoicePoolInterruptedError());
      this.rejectQueue(new VoicePoolInterruptedError());
    }
    return { elementId: opening.pending.input.elementId };
  }

  continueAfterInterruption(elementId: string): void {
    this.resolveInterruptionChoice(elementId);
  }

  restartLine(elementId: string): void {
    this.resolveInterruptionChoice(elementId);
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.active = null;
    this.opening?.pending.reject(new VoicePoolStoppedError());
    this.rejectQueue(new VoicePoolStoppedError());
    const voices = [...this.voices.values()];
    this.voices.clear();
    const cancellation = this.activeCancellation?.promise;
    const drain = this.drainTask;
    this.closing = Promise.all([
      ...voices.map((voice) => this.closeVoice(voice)),
      cancellation,
      drain,
    ]).then(() => undefined);
    return this.closing;
  }

  private resolveInterruptionChoice(elementId: string): void {
    if (!this.awaitingInterruptionChoice || this.interruptedElement !== elementId) {
      throw new Error("Interruption choice does not match the interrupted element");
    }
    this.awaitingInterruptionChoice = false;
    this.interruptedElement = null;
    if (!this.activeCancellation) this.scheduleDrain();
  }

  private installInterruption(elementId: string, atMs: number): void {
    this.interruptedElement = elementId;
    this.awaitingInterruptionChoice = true;
    this.opening?.pending.reject(new VoicePoolInterruptedError());
    this.rejectQueue(new VoicePoolInterruptedError());
    this.options.onEvent?.({ type: "interrupted", elementId, atMs });
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.startDrain();
    });
  }

  private startDrain(): Promise<void> {
    if (this.drainTask) return this.drainTask;
    const task = this.drain();
    this.drainTask = task;
    void task.finally(() => {
      if (this.drainTask !== task) return;
      this.drainTask = null;
      if (!this.stopped && !this.awaitingInterruptionChoice && !this.active && !this.activeCancellation
        && this.queue.length > 0) this.scheduleDrain();
    });
    return task;
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped || this.awaitingInterruptionChoice || this.active || this.activeCancellation
      || this.queue.length === 0) return;
    this.draining = true;
    const pending = this.queue.shift()!;
    this.opening = { pending, characterId: pending.input.characterId };
    try {
      const open = await this.openVoice(pending.input.characterId, pending);
      if (!this.canStart(pending)) {
        this.voices.delete(pending.input.characterId);
        await this.closeVoice(open);
        throw this.fenceError();
      }
      this.opening = null;
      this.active = { elementId: pending.input.elementId, characterId: pending.input.characterId,
        cancel: () => open.kind === "realtime" ? open.session.cancelSpeech() : open.voice.stop() };
      if (open.kind === "realtime") {
        const startedAtMs = this.nowMs();
        await open.session.speak({ characterId: pending.input.characterId, elementId: pending.input.elementId,
          exactText: pending.input.exactText, performanceDirection: pending.input.direction });
        pending.resolve({ startedAtMs, completion: Promise.resolve() });
      } else {
        let resolveStarted: (startedAtMs: number) => void = () => undefined;
        let rejectStarted: (error: unknown) => void = () => undefined;
        const started = new Promise<number>((resolve, reject) => {
          resolveStarted = resolve;
          rejectStarted = reject;
        });
        const completion = open.voice.speak(pending.input, { onStarted: resolveStarted }).then(() => undefined);
        void completion.catch(() => undefined);
        void completion.then(() => rejectStarted(new Error("TTS playback completed before it started")), rejectStarted);
        pending.resolve({ startedAtMs: await started, completion });
      }
    } catch (error) {
      if (this.active?.elementId === pending.input.elementId) this.active = null;
      pending.reject(error);
    } finally {
      if (this.opening?.pending === pending) this.opening = null;
      this.draining = false;
      if (!this.active && this.queue.length > 0) this.scheduleDrain();
    }
  }

  private async openVoice(characterId: string, pending: PendingSpeech): Promise<OpenRoleVoice> {
    const alreadyOpen = this.voices.get(characterId);
    if (alreadyOpen) return alreadyOpen;
    const assignment = this.assignments.get(characterId);
    if (!assignment) throw new Error(`No voice assignment for character ${characterId}`);
    const open: OpenRoleVoice = assignment.engine === "realtime"
      ? { assignment, kind: "realtime", session: await this.options.createRealtimeSession({ ...assignment }) }
      : { assignment, kind: "tts", voice: await this.options.createTtsVoice({ ...assignment }) };
    if (!this.canStart(pending)) {
      await this.closeVoice(open);
      throw this.fenceError();
    }
    this.voices.set(characterId, open);
    return open;
  }

  private canStart(pending: PendingSpeech): boolean {
    return !this.stopped && !this.awaitingInterruptionChoice && !this.cancelledPending.has(pending)
      && this.opening?.pending === pending;
  }

  private fenceError(): Error {
    return this.stopped ? new VoicePoolStoppedError() : new VoicePoolInterruptedError();
  }

  private async closeVoice(voice: OpenRoleVoice): Promise<void> {
    if (this.closedVoices.has(voice)) return;
    this.closedVoices.add(voice);
    await (voice.kind === "realtime" ? voice.session.close() : voice.voice.stop());
  }

  private rejectQueue(error: Error): void {
    for (const pending of this.queue.splice(0)) pending.reject(error);
  }
}
