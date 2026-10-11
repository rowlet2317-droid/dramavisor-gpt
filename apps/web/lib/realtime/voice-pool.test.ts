import { describe, expect, it, vi } from "vitest";

import { TtsFallbackVoice, type TtsPlayback } from "@drama/ai/character-voice/tts-fallback";
import type { CharacterVoice } from "@drama/ai/character-voice/port";
import type { VoiceAssignment } from "@drama/domain/rehearsal/voice-assignment";

import type { RoleVoiceSession } from "./role-voice-session";
import { RoleVoiceSessionPool, VoicePoolInterruptedError, VoicePoolStoppedError } from "./voice-pool";

const assignments: VoiceAssignment[] = [
  { characterId: "char_a", voice: "alloy", engine: "realtime" },
  { characterId: "char_b", voice: "ash", engine: "realtime" },
  { characterId: "char_c", voice: "cedar", engine: "realtime" },
  { characterId: "char_d", voice: "marin", engine: "realtime" },
  { characterId: "char_e", voice: "sage", engine: "tts" },
];

describe("RoleVoiceSessionPool", () => {
  it("keeps four persisted realtime role sessions stable and routes a fifth role to TTS", async () => {
    const sessions = new Map<string, FakeRoleVoiceSession>();
    const tts = new Map<string, FakePlayback>();
    const createRealtimeSession = vi.fn((assignment: VoiceAssignment) => {
      const session = new FakeRoleVoiceSession();
      sessions.set(assignment.characterId, session);
      return session;
    });
    const createTtsVoice = vi.fn((assignment: VoiceAssignment) => {
      const playback = new FakePlayback();
      tts.set(assignment.characterId, playback);
      return new TtsFallbackVoice(assignment.voice, playback, () => 1_000);
    });
    const pool = new RoleVoiceSessionPool({ assignments, createRealtimeSession, createTtsVoice, nowMs: () => 500 });

    for (const [index, assignment] of assignments.entries()) {
      const elementId = `line_${index + 1}`;
      await pool.speak(lineFor(assignment.characterId, elementId, index + 1));
      await pool.speechFinished(elementId);
    }
    await pool.speak(lineFor("char_a", "line_6", 6));

    expect(createRealtimeSession).toHaveBeenCalledTimes(4);
    expect(createRealtimeSession).toHaveBeenNthCalledWith(1, assignments[0]);
    expect(createTtsVoice).toHaveBeenCalledWith(expect.objectContaining({ characterId: "char_e", engine: "tts" }));
    expect(pool.assignmentFor("char_a")).toEqual(assignments[0]);
    expect(sessions.get("char_a")?.requests).toEqual([
      { characterId: "char_a", elementId: "line_1", exactText: "Pinned line for char_a.", performanceDirection: direction },
      { characterId: "char_a", elementId: "line_6", exactText: "Pinned line for char_a.", performanceDirection: direction },
    ]);
    expect(sessions.get("char_a")?.cancelCalls).toBe(0);
    expect(tts.get("char_e")?.spoken).toEqual([
      { voice: "sage", elementId: "line_5", exactText: "Pinned line for char_e.", direction },
    ]);
  });

  it("signals TTS playback start separately from its later completion", async () => {
    const playback = new DeferredPlayback();
    let nowMs = 500;
    const pool = new RoleVoiceSessionPool({ assignments, createRealtimeSession: () => new FakeRoleVoiceSession(),
      createTtsVoice: (assignment) => new TtsFallbackVoice(assignment.voice, playback, () => nowMs),
      nowMs: () => 999 });

    const speech = pool.speak(lineFor("char_e", "line_5", 5));
    await playback.requested;
    let started: Awaited<typeof speech> | undefined;
    void speech.then((value) => { started = value; });
    await Promise.resolve();

    expect(started).toBeUndefined();
    nowMs = 700;
    playback.start();
    await vi.waitFor(() => expect(started).toBeDefined());
    expect(started).toMatchObject({ startedAtMs: 700, completion: expect.any(Promise) });
    let completed = false;
    void started?.completion.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);

    playback.finish();
    await started?.completion;
    expect(completed).toBe(true);
  });

  it("cancels an active role, rejects queued output, and waits for an explicit continuation choice", async () => {
    const active = new DeferredRoleVoiceSession();
    const events: Array<{ type: string; elementId: string; atMs: number }> = [];
    const pool = new RoleVoiceSessionPool({ assignments, createRealtimeSession: () => active,
      createTtsVoice: (assignment) => new TtsFallbackVoice(assignment.voice, new FakePlayback()),
      onEvent: (event) => events.push(event) });
    const first = pool.speak(lineFor("char_a", "line_1", 1));
    await active.requested;
    const queued = pool.speak(lineFor("char_b", "line_2", 2));

    const interruption = pool.cancelActive(1_750);
    await active.cancelRequested;
    expect(pool.interruptedElementId).toBe("line_1");
    expect(events).toEqual([{ type: "interrupted", elementId: "line_1", atMs: 1_750 }]);
    await expect(queued).rejects.toBeInstanceOf(VoicePoolInterruptedError);
    await expect(pool.speak(lineFor("char_b", "line_2", 2))).rejects.toBeInstanceOf(VoicePoolInterruptedError);
    expect(active.cancelCalls).toBe(1);
    active.releaseCancellation();
    await expect(interruption).resolves.toEqual({ elementId: "line_1" });

    pool.continueAfterInterruption("line_1");
    await expect(pool.speak(lineFor("char_b", "line_2", 2))).resolves.toMatchObject({
      startedAtMs: expect.any(Number), completion: expect.any(Promise) });
    active.resolve();
    await first;
  });

  it("cancels Pause output without installing an actor-interruption choice", async () => {
    // Break caught: Pause can be persisted as an actor interruption and block Resume behind Continue/Restart.
    const active = new DeferredRoleVoiceSession();
    const events: Array<{ type: string; elementId: string; atMs: number }> = [];
    const pool = new RoleVoiceSessionPool({ assignments, createRealtimeSession: () => active,
      createTtsVoice: (assignment) => new TtsFallbackVoice(assignment.voice, new FakePlayback()),
      onEvent: (event) => events.push(event) });
    const first = pool.speak(lineFor("char_a", "line_1", 1));
    await active.requested;

    const pausing = pool.cancelActive(1_750, "pause");
    await active.cancelRequested;
    active.releaseCancellation();
    await pausing;

    expect(pool.interruptedElementId).toBeNull();
    expect(events).toEqual([]);
    await expect(pool.speak(lineFor("char_b", "line_2", 2))).resolves.toMatchObject({
      startedAtMs: expect.any(Number), completion: expect.any(Promise) });
    await first;
  });

  it("only restarts the interrupted line after an explicit restart command", async () => {
    const active = new DeferredRoleVoiceSession();
    const pool = new RoleVoiceSessionPool({ assignments, createRealtimeSession: () => active,
      createTtsVoice: (assignment) => new TtsFallbackVoice(assignment.voice, new FakePlayback()) });
    const first = pool.speak(lineFor("char_a", "line_1", 1));
    await active.requested;
    const interruption = pool.cancelActive(1_750);
    await active.cancelRequested;
    active.releaseCancellation();
    await interruption;

    pool.restartLine("line_1");
    active.resolve();
    await first;
    await expect(pool.speak(lineFor("char_a", "line_1", 1))).resolves.toMatchObject({
      startedAtMs: expect.any(Number), completion: expect.any(Promise) });
  });

  it("waits for a late realtime session to close before close returns", async () => {
    const session = new FakeRoleVoiceSession();
    const factory = new DeferredFactory<RoleVoiceSession>();
    const pool = new RoleVoiceSessionPool({ assignments, createRealtimeSession: () => factory.create(),
      createTtsVoice: (assignment) => new TtsFallbackVoice(assignment.voice, new FakePlayback()) });
    const speech = pool.speak(lineFor("char_a", "line_1", 1));
    await factory.entered;
    const rejected = expect(speech).rejects.toBeInstanceOf(VoicePoolStoppedError);
    let closeReturned = false;
    const close = pool.close().then(() => { closeReturned = true; });

    await Promise.resolve();
    expect(closeReturned).toBe(false);
    factory.resolve(session);
    await close;
    await rejected;
    expect(session.closeCalls).toBe(1);
    expect(session.requests).toEqual([]);
  });

  it("rejects an opening line before waiting for its late factory result during close", async () => {
    const session = new FakeRoleVoiceSession();
    const factory = new DeferredFactory<RoleVoiceSession>();
    const pool = new RoleVoiceSessionPool({ assignments, createRealtimeSession: () => factory.create(),
      createTtsVoice: (assignment) => new TtsFallbackVoice(assignment.voice, new FakePlayback()) });
    const speech = pool.speak(lineFor("char_a", "line_1", 1));
    await factory.entered;
    let rejection: unknown;
    void speech.catch((error: unknown) => { rejection = error; });
    let closeReturned = false;
    const close = pool.close().then(() => { closeReturned = true; });

    await Promise.resolve();
    expect(rejection).toBeInstanceOf(VoicePoolStoppedError);
    expect(closeReturned).toBe(false);
    factory.resolve(session);
    await close;
    expect(session.closeCalls).toBe(1);
    expect(session.requests).toEqual([]);
  });

  it("waits for a late TTS voice to stop before close returns", async () => {
    const voice = new FakeOutputVoice();
    const factory = new DeferredFactory<FakeOutputVoice>();
    const pool = new RoleVoiceSessionPool({ assignments, createRealtimeSession: () => new FakeRoleVoiceSession(),
      createTtsVoice: () => factory.create() });
    const speech = pool.speak(lineFor("char_e", "line_5", 5));
    await factory.entered;
    const rejected = expect(speech).rejects.toBeInstanceOf(VoicePoolStoppedError);
    let closeReturned = false;
    const close = pool.close().then(() => { closeReturned = true; });
    await Promise.resolve();
    expect(closeReturned).toBe(false);
    factory.resolve(voice);
    await close;
    await rejected;
    expect(voice.stopCalls).toBe(1);
    expect(voice.calls).toEqual([]);
  });

  it("interrupts a line while its realtime session is still opening", async () => {
    const session = new FakeRoleVoiceSession();
    const factory = new DeferredFactory<RoleVoiceSession>();
    const pool = new RoleVoiceSessionPool({ assignments, createRealtimeSession: () => factory.create(),
      createTtsVoice: (assignment) => new TtsFallbackVoice(assignment.voice, new FakePlayback()) });
    const speech = pool.speak(lineFor("char_a", "line_1", 1));
    await factory.entered;
    const rejected = expect(speech).rejects.toBeInstanceOf(VoicePoolInterruptedError);

    await expect(pool.cancelActive(1_750)).resolves.toEqual({ elementId: "line_1" });
    expect(pool.interruptedElementId).toBe("line_1");
    await expect(pool.speak(lineFor("char_b", "line_2", 2))).rejects.toBeInstanceOf(VoicePoolInterruptedError);
    factory.resolve(session);
    await rejected;
    expect(session.closeCalls).toBe(1);
    expect(session.requests).toEqual([]);
  });

  it.each([
    ["continue", (pool: RoleVoiceSessionPool) => pool.continueAfterInterruption("line_1")],
    ["restart", (pool: RoleVoiceSessionPool) => pool.restartLine("line_1")],
  ])("does not start the next line before %s cancellation settles", async (_choice, choose) => {
    const active = new DeferredRoleVoiceSession();
    const pool = new RoleVoiceSessionPool({ assignments, createRealtimeSession: () => active,
      createTtsVoice: (assignment) => new TtsFallbackVoice(assignment.voice, new FakePlayback()) });
    const first = pool.speak(lineFor("char_a", "line_1", 1));
    await active.requested;
    const cancelling = pool.cancelActive(1_750);
    await active.cancelRequested;
    choose(pool);
    const next = pool.speak(lineFor("char_b", "line_2", 2));

    await Promise.resolve();
    expect(active.requests.map(({ elementId }) => elementId)).toEqual(["line_1"]);
    active.releaseCancellation();
    await cancelling;
    await next;
    await first;
    expect(active.requests.map(({ elementId }) => elementId)).toEqual(["line_1", "line_2"]);
  });

  it("reinstalls the interruption fence when cancellation fails after Continue", async () => {
    const active = new FailingCancellationSession();
    const pool = new RoleVoiceSessionPool({ assignments, createRealtimeSession: () => active,
      createTtsVoice: (assignment) => new TtsFallbackVoice(assignment.voice, new FakePlayback()) });
    await pool.speak(lineFor("char_a", "line_1", 1));
    const cancelling = pool.cancelActive(1_750);
    await active.cancelRequested;
    pool.continueAfterInterruption("line_1");
    const queued = pool.speak(lineFor("char_b", "line_2", 2));

    active.failCancellation();
    await cancelling;
    await expect(queued).rejects.toBeInstanceOf(VoicePoolInterruptedError);
    expect(pool.interruptedElementId).toBe("line_1");
    expect(active.requests.map(({ elementId }) => elementId)).toEqual(["line_1"]);
  });

  it("closes a cached realtime session exactly once across the opening handoff", async () => {
    const session = new NonIdempotentRoleVoiceSession();
    const pool = new RoleVoiceSessionPool({ assignments, createRealtimeSession: () => session,
      createTtsVoice: (assignment) => new TtsFallbackVoice(assignment.voice, new FakePlayback()) });
    await pool.speak(lineFor("char_a", "line_1", 1));
    await pool.speechFinished("line_1");
    const next = pool.speak(lineFor("char_a", "line_2", 2));
    await Promise.resolve();

    const rejected = expect(next).rejects.toBeInstanceOf(VoicePoolStoppedError);
    await expect(pool.close()).resolves.toBeUndefined();
    await rejected;
    expect(session.closeCalls).toBe(1);
    expect(session.requests.map(({ elementId }) => elementId)).toEqual(["line_1"]);
  });
});

const direction = "Objective: win the argument. Use only the exact supplied script text; never invent or paraphrase dialogue.";

function lineFor(characterId: string, elementId: string, ordinal: number) {
  return { characterId, elementId, ordinal, exactText: `Pinned line for ${characterId}.`, direction };
}

class FakeRoleVoiceSession implements RoleVoiceSession {
  readonly requests: Array<{ characterId: string; elementId: string; exactText: string; performanceDirection: string }> = [];
  cancelCalls = 0;
  closeCalls = 0;
  async speak(input: { characterId: string; elementId: string; exactText: string; performanceDirection: string }) {
    this.requests.push(input);
  }
  async cancelSpeech() { this.cancelCalls += 1; }
  async close() { this.closeCalls += 1; }
}

class DeferredRoleVoiceSession extends FakeRoleVoiceSession {
  private resolveSpeak: (() => void) | null = null;
  readonly requested = new Promise<void>((resolve) => { this.resolveSpeak = resolve; });
  private resolvePlayback: () => void = () => undefined;
  private readonly complete = new Promise<void>((resolve) => { this.resolvePlayback = resolve; });
  private resolveCancellation: () => void = () => undefined;
  private resolveCancelRequested: () => void = () => undefined;
  readonly cancelRequested = new Promise<void>((resolve) => { this.resolveCancelRequested = resolve; });
  private readonly cancellation = new Promise<void>((resolve) => { this.resolveCancellation = resolve; });
  override async speak(input: { characterId: string; elementId: string; exactText: string; performanceDirection: string }) {
    this.requests.push(input);
    this.resolveSpeak?.();
    await this.complete;
  }
  override async cancelSpeech() {
    await super.cancelSpeech();
    this.resolveCancelRequested();
    await this.cancellation;
    this.resolvePlayback();
  }
  releaseCancellation() { this.resolveCancellation(); }
  resolve() { this.resolvePlayback(); }
}

class FakePlayback implements TtsPlayback {
  readonly spoken: Array<{ voice: string; exactText: string; direction: string }> = [];
  async speak(input: { voice: string; exactText: string; direction: string; onStarted?: () => void }) {
    const { onStarted, ...speech } = input;
    this.spoken.push(speech);
    onStarted?.();
  }
  async stop() {}
}

class DeferredPlayback implements TtsPlayback {
  private resolveRequested: () => void = () => undefined;
  readonly requested = new Promise<void>((resolve) => { this.resolveRequested = resolve; });
  private resolveCompletion: () => void = () => undefined;
  private readonly completion = new Promise<void>((resolve) => { this.resolveCompletion = resolve; });
  private onStarted: () => void = () => undefined;
  async speak(input: { onStarted?: () => void }) {
    this.onStarted = input.onStarted ?? (() => undefined);
    this.resolveRequested();
    await this.completion;
  }
  async stop() {}
  start() { this.onStarted(); }
  finish() { this.resolveCompletion(); }
}

class FakeOutputVoice implements CharacterVoice {
  readonly calls: Array<{ characterId: string; elementId: string; exactText: string; direction: string }> = [];
  stopCalls = 0;
  async speak(input: { characterId: string; elementId: string; exactText: string; direction: string }) {
    this.calls.push(input);
    return { startedAtMs: 0 };
  }
  async stop() { this.stopCalls += 1; }
}

class DeferredFactory<T> {
  private resolveValue: (value: T) => void = () => undefined;
  private readonly value = new Promise<T>((resolve) => { this.resolveValue = resolve; });
  private resolveEntered: () => void = () => undefined;
  readonly entered = new Promise<void>((resolve) => { this.resolveEntered = resolve; });
  create(): Promise<T> { this.resolveEntered(); return this.value; }
  resolve(value: T) { this.resolveValue(value); }
}

class FailingCancellationSession extends FakeRoleVoiceSession {
  private rejectCancellation: (error: Error) => void = () => undefined;
  private readonly cancellation = new Promise<void>((_resolve, reject) => { this.rejectCancellation = reject; });
  private resolveCancelRequested: () => void = () => undefined;
  readonly cancelRequested = new Promise<void>((resolve) => { this.resolveCancelRequested = resolve; });
  override async cancelSpeech() {
    await super.cancelSpeech();
    this.resolveCancelRequested();
    await this.cancellation;
  }
  failCancellation() { this.rejectCancellation(new Error("cancel failed")); }
}

class NonIdempotentRoleVoiceSession extends FakeRoleVoiceSession {
  override async close() {
    this.closeCalls += 1;
    if (this.closeCalls > 1) throw new Error("session closed twice");
  }
}
