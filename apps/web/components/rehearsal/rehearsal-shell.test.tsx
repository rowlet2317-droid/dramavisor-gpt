import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TtsFallbackVoice, type TtsPlayback } from "@drama/ai/character-voice/tts-fallback";
import type { RealtimeEvent, RealtimeSpeechRequest } from "@drama/ai/realtime/port";
import type { PersistedRehearsalEvent } from "@drama/domain/rehearsal/types";
import type { TakeRecorder } from "../../lib/audio/recorder";
import type { ActorInputEvent, ActorInputSession } from "../../lib/realtime/actor-input-session";
import type { FallbackReadiness } from "../../lib/realtime/fallback-player";
import { RoleVoiceSessionPool } from "../../lib/realtime/voice-pool";

import { BrowserRehearsalClientTransport, ManualActorProgress, RehearsalShell, RehearsalShellController,
  type RehearsalClientTransport, type RehearsalScene } from "./rehearsal-shell";
import { RehearsalControls } from "./rehearsal-controls";
import { ConnectionRecovery } from "./connection-recovery";

const scene: RehearsalScene = { id: "scene_1", title: "The room", lines: [
  { elementId: "line_1", ordinal: 1, characterId: "char_alex", characterName: "Alex",
    text: "You came back.", voiceLabel: "cedar" },
  { elementId: "line_2", ordinal: 2, characterId: "char_actor", characterName: "Morgan",
    text: "I said I would.", voiceLabel: "You" },
  { elementId: "line_3", ordinal: 3, characterId: "char_alex", characterName: "Alex",
    text: "Then stay.", voiceLabel: "cedar" },
] };

describe("RehearsalShell", () => {
  it("hides scripted continuation unless AI speech is actually ready", () => {
    const markup = renderToStaticMarkup(<ConnectionRecovery visible reconnecting={false}
      readiness={{ aiSpeech: "unavailable", actorProgress: "manual", canContinue: false }}
      onRetry={() => undefined} onFallback={() => undefined} onEndAndSave={() => undefined} />);

    expect(markup).not.toContain("Continue with Scripted Voices");
    expect(markup).toContain("End and Save");
  });


  it("does not restore a saved timeline during the initial render", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => JSON.stringify([{ elementId: "line_1", characterName: "Alex", voiceLabel: "cedar",
        text: "You came back." }]),
      setItem: () => undefined,
    });
    try {
      const markup = renderToStaticMarkup(<RehearsalShell playId="play_1" playModelVersion={1} scene={scene}
        actorRoleId="char_actor" transport={new FakeRehearsalTransport()} />);

      expect(markup).not.toContain("Rehearsal line order");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("binds the browser fetch receiver for the default realtime-session request", async () => {
    vi.stubGlobal("fetch", function (this: unknown) {
      if (this !== globalThis) throw new Error("default fetch lost its Window receiver");
      return Promise.resolve(Response.json({ clientSecret: "ek_actor", expiresAt: "2099-01-01T00:00:00.000Z",
        model: "realtime", rehearsalSessionId: "session_1", assignments: [] }, { status: 201 }));
    });
    try {
      const manager = new BrowserRehearsalClientTransport({ e2eMode: true });

      await manager.connect({ playId: "play_1", sceneId: "scene_1", actorRoleId: "char_actor" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows an explicit manual Line complete control without claiming to listen", () => {
    const markup = renderToStaticMarkup(<ManualActorProgress visible onComplete={() => undefined} />);

    expect(markup).toContain(">Line complete</button>");
    expect(markup).not.toContain("Listening");
  });

  it("composes separate actor input and role pool boundaries in the browser transport manager", async () => {
    const actorInput = new FakeActorInputSession();
    const rolePool = new FakeRolePool();
    const manager = new BrowserRehearsalClientTransport({
      fetch: async () => Response.json({ clientSecret: "ek_actor", expiresAt: "2099-01-01T00:00:00.000Z",
        model: "realtime", rehearsalSessionId: "session_1", assignments: [
          { characterId: "char_alex", voice: "cedar", engine: "realtime" },
        ] }, { status: 201 }),
      createActorInputSession: () => actorInput,
      createRolePool: () => rolePool,
    });

    await manager.connect({ playId: "play_1", sceneId: "scene_1", actorRoleId: "char_actor" });
    await manager.requestSpeech({ characterId: "char_alex", elementId: "line_1", exactText: "You came back.",
      performanceDirection: "Exact text." });

    expect(actorInput.connectCalls).toBe(1);
    expect(rolePool.spoken).toEqual([expect.objectContaining({ characterId: "char_alex", elementId: "line_1" })]);
  });


  it("surfaces a failed AI speech request instead of silently stalling rehearsal", async () => {
    const transport = new FakeRehearsalTransport();
    transport.requestSpeech = async () => { throw new Error("Realtime role session could not start"); };
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport, persistEvent: async () => undefined });

    await controller.start();

    await vi.waitFor(() => expect(controller.error).toBe("Realtime role session could not start"));
  });

  it("coalesces duplicate actor VAD starts while production role cancellation is pending", async () => {
    const actorInput = new FakeActorInputSession();
    const events: RealtimeEvent[] = [];
    let cancelCalls = 0;
    let releaseCancellation: () => void = () => undefined;
    const cancellation = new Promise<void>((resolve) => { releaseCancellation = resolve; });
    const manager = new BrowserRehearsalClientTransport({
      fetch: async () => startGrantResponse("session_1"), createActorInputSession: () => actorInput,
      createRolePool: ({ onEvent }) => ({
        async speak() { return { startedAtMs: 0, completion: Promise.resolve() }; },
        async speechFinished() {},
        async cancelActive(atMs: number) {
          cancelCalls += 1;
          onEvent({ type: "interrupted", atMs });
          await cancellation;
          return { elementId: "line_1" };
        },
        continueAfterInterruption() {}, restartLine() {}, async close() {},
      }),
    });
    manager.onEvent((event) => events.push(event));
    await manager.connect({ playId: "play_1", sceneId: "scene_1", actorRoleId: "char_actor" });

    actorInput.emit({ type: "actor_speech_started", startedAtMs: 1_000, providerAudioStartMs: 50 });
    actorInput.emit({ type: "actor_speech_started", startedAtMs: 1_001, providerAudioStartMs: 50 });
    await Promise.resolve();

    expect(cancelCalls).toBe(1);
    expect(events.filter(({ type }) => type === "interrupted")).toHaveLength(1);
    releaseCancellation();
    await Promise.resolve();
    await Promise.resolve();
    actorInput.emit({ type: "actor_speech_started", startedAtMs: 1_002, providerAudioStartMs: 50 });
    await Promise.resolve();

    expect(cancelCalls).toBe(1);
    expect(events.filter(({ type }) => type === "interrupted")).toHaveLength(1);
    await manager.close();
  });

  it("ignores an actor VAD callback already queued when browser capture is paused", async () => {
    // Break caught: a late VAD callback can reinstall an unseen interruption gate after Pause.
    const actorInput = new FakeActorInputSession();
    const rolePool = new FakeRolePool();
    const manager = new BrowserRehearsalClientTransport({
      fetch: async () => startGrantResponse("session_1"), createActorInputSession: () => actorInput,
      createRolePool: () => rolePool,
    });
    await manager.connect({ playId: "play_1", sceneId: "scene_1", actorRoleId: "char_actor" });
    manager.pauseCapture();
    await manager.cancelActive(800, "pause");

    actorInput.emit({ type: "actor_speech_started", startedAtMs: 801, providerAudioStartMs: 50 });
    await Promise.resolve();

    expect(rolePool.cancelActiveCalls).toBe(1);
    await manager.close();
  });

  it("uses the default server-TTS adapter when normal session composition reports it configured", async () => {
    const events: RealtimeEvent[] = [];
    const speechRequests: Array<Record<string, unknown>> = [];
    const audios: FakeServerAudio[] = [];
    class InstalledAudio extends FakeServerAudio { constructor() { super(); audios.push(this); } }
    vi.stubGlobal("Audio", InstalledAudio);
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:configured-speech");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const manager = new BrowserRehearsalClientTransport({
      fetch: async (input, init) => {
        if (String(input) === "/api/realtime/session") return configuredStartGrantResponse("session_1", true);
        speechRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(Uint8Array.of(1, 2, 3), { status: 200, headers: { "content-type": "audio/mpeg" } });
      },
      createActorInputSession: () => new FakeActorInputSession(),
    });
    try {
      manager.onEvent((event) => events.push(event));
      const connected = await manager.connect({ playId: "play_1", sceneId: "scene_1", actorRoleId: "char_actor" });

      expect(manager.fallbackReadiness({ assignments: connected.assignments })).toEqual({
        aiSpeech: "configured_tts", actorProgress: "manual", canContinue: true,
      });

      await manager.useScriptedFallback({ assignments: connected.assignments });
      const speaking = manager.requestSpeech({ characterId: "char_alex", elementId: "line_1",
        exactText: "You came back.", performanceDirection: "Exact text." });
      await vi.waitFor(() => expect(audios).toHaveLength(1));
      expect(events).toEqual([]);
      audios[0]!.onplaying?.(new Event("playing"));
      await vi.waitFor(() => expect(events.map(({ type }) => type)).toEqual(["speech_started"]));
      audios[0]!.onended?.(new Event("ended"));
      await speaking;

      expect(speechRequests).toEqual([{ elementId: "line_1" }]);
      expect(events.map(({ type }) => type)).toEqual(["speech_started", "speech_finished"]);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:configured-speech");
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("does not claim configured TTS in the default transport when the server reports it unavailable", async () => {
    vi.stubGlobal("speechSynthesis", undefined);
    const manager = new BrowserRehearsalClientTransport({
      fetch: async () => configuredStartGrantResponse("session_1", false),
      createActorInputSession: () => new FakeActorInputSession(),
    });
    try {
      const connected = await manager.connect({ playId: "play_1", sceneId: "scene_1", actorRoleId: "char_actor" });

      expect(manager.fallbackReadiness({ assignments: connected.assignments })).toEqual({
        aiSpeech: "unavailable", actorProgress: "manual", canContinue: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cancels default server-TTS playback without emitting a false normal finish", async () => {
    const events: RealtimeEvent[] = [];
    const audios: FakeServerAudio[] = [];
    class InstalledAudio extends FakeServerAudio { constructor() { super(); audios.push(this); } }
    vi.stubGlobal("Audio", InstalledAudio);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cancelled-speech");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const manager = new BrowserRehearsalClientTransport({
      fetch: async (input) => String(input) === "/api/realtime/session"
        ? configuredStartGrantResponse("session_1", true)
        : new Response(Uint8Array.of(1), { status: 200, headers: { "content-type": "audio/mpeg" } }),
      createActorInputSession: () => new FakeActorInputSession(),
    });
    try {
      manager.onEvent((event) => events.push(event));
      const connected = await manager.connect({ playId: "play_1", sceneId: "scene_1", actorRoleId: "char_actor" });
      await manager.useScriptedFallback({ assignments: connected.assignments });
      const speaking = manager.requestSpeech({ characterId: "char_alex", elementId: "line_1",
        exactText: "You came back.", performanceDirection: "Exact text." });
      await vi.waitFor(() => expect(audios).toHaveLength(1));
      audios[0]!.onplaying?.(new Event("playing"));
      await vi.waitFor(() => expect(events.map(({ type }) => type)).toEqual(["speech_started"]));

      await manager.cancelActive?.(800);
      await expect(speaking).rejects.toThrow("cancelled");

      expect(audios[0]).toMatchObject({ pauseCalls: 1, removed: true });
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:cancelled-speech");
      expect(events.map(({ type }) => type)).toEqual(["speech_started", "interrupted"]);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("aborts default server-TTS generation and discards a late artifact after cancellation", async () => {
    const events: RealtimeEvent[] = [];
    const speechResponse = new DeferredValue<Response>();
    let speechSignal: AbortSignal | undefined;
    let audioConstructions = 0;
    class InstalledAudio extends FakeServerAudio { constructor() { super(); audioConstructions += 1; } }
    vi.stubGlobal("Audio", InstalledAudio);
    const manager = new BrowserRehearsalClientTransport({
      fetch: async (input, init) => {
        if (String(input) === "/api/realtime/session") return configuredStartGrantResponse("session_1", true);
        speechSignal = init?.signal ?? undefined;
        return speechResponse.get();
      },
      createActorInputSession: () => new FakeActorInputSession(),
    });
    try {
      manager.onEvent((event) => events.push(event));
      const connected = await manager.connect({ playId: "play_1", sceneId: "scene_1", actorRoleId: "char_actor" });
      await manager.useScriptedFallback({ assignments: connected.assignments });
      const speaking = manager.requestSpeech({ characterId: "char_alex", elementId: "line_1",
        exactText: "You came back.", performanceDirection: "Exact text." });
      await speechResponse.requested;

      await manager.cancelActive?.(800);
      await expect(speaking).rejects.toThrow("cancelled");

      expect(speechSignal?.aborted).toBe(true);
      speechResponse.resolve(new Response(Uint8Array.of(1), { status: 200,
        headers: { "content-type": "audio/mpeg" } }));
      await Promise.resolve();
      await Promise.resolve();
      expect(audioConstructions).toBe(0);
      expect(events.map(({ type }) => type)).toEqual(["interrupted"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("emits scripted speech start at playback start and finish only after playback completion", async () => {
    const actorInput = new FakeActorInputSession();
    const rolePool = new DeferredCompletionRolePool();
    const events: RealtimeEvent[] = [];
    const manager = new BrowserRehearsalClientTransport({
      fetch: async () => Response.json({ clientSecret: "ek_actor", expiresAt: "2099-01-01T00:00:00.000Z",
        model: "realtime", rehearsalSessionId: "session_1", assignments: [
          { characterId: "char_alex", voice: "cedar", engine: "tts" },
        ] }, { status: 201 }),
      createActorInputSession: () => actorInput,
      createRolePool: () => rolePool,
      nowMs: () => 900,
    });
    manager.onEvent((event) => events.push(event));
    await manager.connect({ playId: "play_1", sceneId: "scene_1", actorRoleId: "char_actor" });

    const speaking = manager.requestSpeech({ characterId: "char_alex", elementId: "line_1",
      exactText: "You came back.", performanceDirection: "Exact text." });
    await rolePool.started;
    await Promise.resolve();

    expect(events).toEqual([{ type: "speech_started", characterId: "char_alex", elementId: "line_1",
      startedAtMs: 700 }]);
    rolePool.finish();
    await speaking;
    expect(events.at(-1)).toEqual({ type: "speech_finished", characterId: "char_alex", elementId: "line_1",
      endedAtMs: 900 });
  });

  it("keeps a scripted speech start without emitting a false finish when audible playback is interrupted", async () => {
    const rolePool = new DeferredCompletionRolePool();
    const events: RealtimeEvent[] = [];
    const manager = new BrowserRehearsalClientTransport({
      fetch: async () => Response.json({ clientSecret: "ek_actor", expiresAt: "2099-01-01T00:00:00.000Z",
        model: "realtime", rehearsalSessionId: "session_1", assignments: [
          { characterId: "char_alex", voice: "cedar", engine: "tts" },
        ] }, { status: 201 }),
      createActorInputSession: () => new FakeActorInputSession(),
      createRolePool: () => rolePool,
    });
    manager.onEvent((event) => events.push(event));
    await manager.connect({ playId: "play_1", sceneId: "scene_1", actorRoleId: "char_actor" });

    const speaking = manager.requestSpeech({ characterId: "char_alex", elementId: "line_1",
      exactText: "You came back.", performanceDirection: "Exact text." });
    await rolePool.started;
    await manager.cancelActive?.(800);

    await expect(speaking).rejects.toThrow("interrupted");
    expect(events.map(({ type }) => type)).toEqual(["speech_started"]);
  });

  it("keeps Pause distinct from actor interruption after audible cancellation", async () => {
    const playback = new ManualStartPlayback();
    let nowMs = 700;
    const manager = new BrowserRehearsalClientTransport({
      fetch: async () => Response.json({ clientSecret: "ek_actor", expiresAt: "2099-01-01T00:00:00.000Z",
        model: "realtime", rehearsalSessionId: "session_1", assignments: [
          { characterId: "char_alex", voice: "cedar", engine: "tts" },
        ] }, { status: 201 }),
      createActorInputSession: () => new FakeActorInputSession(),
      createRolePool: ({ assignments, onEvent }) => new RoleVoiceSessionPool({ assignments,
        createRealtimeSession: () => { throw new Error("unexpected realtime role"); },
        createTtsVoice: (assignment) => new TtsFallbackVoice(assignment.voice, playback, () => nowMs),
        onEvent: (event) => onEvent({ type: "interrupted", atMs: event.atMs }) }),
    });
    const persisted: PersistedRehearsalEvent[] = [];
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport: manager, nowMs: () => nowMs,
      persistEvent: async (_sessionId, event) => { persisted.push(event); } });

    await controller.start();
    await playback.requested;
    await Promise.resolve();
    await Promise.resolve();
    expect(persisted.map(({ type }) => type)).toEqual(["started"]);

    nowMs = 750;
    playback.start();
    await vi.waitFor(() => expect(persisted.map(({ type }) => type)).toContain("ai_speech_started"));
    expect(persisted.find(({ type }) => type === "ai_speech_started")).toMatchObject({ startedAtMs: 750 });
    nowMs = 800;
    await controller.pause();

    expect(persisted.map(({ type }) => type)).toEqual(["started", "ai_speech_started", "paused"]);
    expect(controller.state.status).toBe("paused");
    expect(persisted.map(({ type }) => type)).not.toContain("ai_speech_finished");
  });

  it("persists Pause while a previously acknowledged speech effect is still active", async () => {
    const transport = new DeferredSpeechTransport();
    const persisted: PersistedRehearsalEvent[] = [];
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport,
      persistEvent: async (_sessionId, event) => { persisted.push(event); } });

    await controller.start();
    await transport.speechStarted;
    await controller.pause();

    expect(persisted.map(({ type }) => type)).toEqual(["started", "paused"]);
    expect(controller.state.status).toBe("paused");
    transport.finishSpeech();
  });

  it("persists Stop while a previously acknowledged speech effect is still active", async () => {
    const transport = new DeferredSpeechTransport();
    const persisted: PersistedRehearsalEvent[] = [];
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport,
      persistEvent: async (_sessionId, event) => { persisted.push(event); } });

    await controller.start();
    await transport.speechStarted;
    await controller.stop();

    expect(persisted.map(({ type }) => type)).toEqual(["started", "stopped"]);
    expect(controller.state.status).toBe("stopped");
    transport.finishSpeech();
  });

  it("closes locally without appending an illegal Stop after the scene is durably completed", async () => {
    const transport = new FakeRehearsalTransport();
    const persisted: PersistedRehearsalEvent[] = [];
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport,
      persistEvent: async (_sessionId, event) => { persisted.push(event); } });
    await controller.start();
    await controller.handleRealtimeEvent({ type: "speech_finished", characterId: "char_alex",
      elementId: "line_1", endedAtMs: 10 });
    await controller.handleRealtimeEvent({ type: "actor_transcript_final", text: "I said I would.", endedAtMs: 20 });
    await controller.handleRealtimeEvent({ type: "speech_finished", characterId: "char_alex",
      elementId: "line_3", endedAtMs: 30 });
    expect(controller.state.status).toBe("completed");

    await controller.stop();

    expect(persisted.map(({ type }) => type)).toEqual([
      "started", "ai_speech_finished", "actor_line_final", "ai_speech_finished",
    ]);
    expect(controller.state.status).toBe("stopped");
    expect(transport.closeCalls).toBe(1);
  });

  it("requests the following AI line after the actor confirms an ambiguous position", async () => {
    const transport = new FakeRehearsalTransport();
    const persisted: PersistedRehearsalEvent[] = [];
    const controller = rehearsalController(transport, persisted);
    await controller.start();
    await controller.handleRealtimeEvent({ type: "speech_finished", characterId: "char_alex",
      elementId: "line_1", endedAtMs: 10 });

    await controller.handleRealtimeEvent({ type: "actor_transcript_final", text: "unclear transcript",
      endedAtMs: 20 });
    expect(controller.state).toMatchObject({ status: "needs_position_confirmation",
      pendingAction: { type: "confirm_position" } });

    await controller.confirmPosition("line_2");

    expect(controller.state).toMatchObject({ status: "active", cursorElementId: "line_3",
      pendingAction: { type: "speak", elementId: "line_3", characterId: "char_alex" } });
    expect(transport.speechRequests.map(({ elementId }) => elementId)).toEqual(["line_1", "line_3"]);
    expect(persisted.map(({ type }) => type).at(-1)).toBe("position_confirmed");
  });

  it("does not reduce a durable command or run its speech effect before server acknowledgement", async () => {
    const transport = new FakeRehearsalTransport();
    let acknowledge!: () => void;
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport,
      persistEvent: () => new Promise<void>((resolve) => { acknowledge = resolve; }) });

    const starting = controller.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.state).toMatchObject({ status: "ready", lastSequence: 0 });
    expect(transport.speechRequests).toEqual([]);
    acknowledge();
    await starting;
    expect(controller.state).toMatchObject({ status: "active", lastSequence: 1 });
    expect(transport.speechRequests).toHaveLength(1);
  });

  it("installs the Pause media fence before persistence and ignores late provider completion", async () => {
    const transport = new FakeRehearsalTransport();
    const actorInput = new FakeActorInputSession();
    const rolePool = new FakeRolePool();
    const persisted: PersistedRehearsalEvent[] = [];
    let acknowledgePause!: () => void;
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport, actorInputSession: actorInput, rolePool,
      persistEvent: async (_sessionId, event) => {
        persisted.push(event);
        if (event.type === "paused") await new Promise<void>((resolve) => { acknowledgePause = resolve; });
      } });
    await controller.start();

    const pausing = controller.pause();
    const lateCompletion = controller.handleRealtimeEvent({ type: "speech_finished", characterId: "char_alex",
      elementId: "line_1", endedAtMs: 1_000 });
    const lateActorFinal = controller.handleRealtimeEvent({ type: "actor_transcript_final", text: "Too late.",
      endedAtMs: 1_001 });
    actorInput.emit({ type: "actor_speech_started", startedAtMs: 1_002, providerAudioStartMs: 50 });

    expect(actorInput.pauseCalls).toBe(1);
    await Promise.resolve();
    expect(rolePool.cancelActiveCalls).toBe(1);
    expect(controller.state).toMatchObject({ status: "paused", cursorElementId: "line_1" });
    acknowledgePause();
    await pausing;
    await lateCompletion;
    await lateActorFinal;
    expect(controller.state).toMatchObject({ status: "paused", cursorElementId: "line_1" });
    expect(persisted.map(({ type }) => type)).toEqual(["started", "paused"]);
  });

  it("turns actor VAD speech-start into one explicit interrupted rehearsal event", async () => {
    const transport = new FakeRehearsalTransport();
    const actorInput = new FakeActorInputSession();
    const rolePool = new FakeRolePool();
    const persisted: PersistedRehearsalEvent[] = [];
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport, actorInputSession: actorInput, rolePool,
      persistEvent: async (_sessionId, event) => { persisted.push(event); } });
    await controller.start();

    actorInput.emit({ type: "actor_speech_started", startedAtMs: 1_000, providerAudioStartMs: 50 });
    await vi.waitFor(() => expect(persisted.map(({ type }) => type)).toContain("interrupted"));

    expect(rolePool.cancelActiveCalls).toBe(1);
    expect(persisted.filter(({ type }) => type === "interrupted")).toHaveLength(1);
    expect(controller.state).toMatchObject({ status: "await_interruption_choice",
      pendingAction: { type: "await_interruption_choice", elementId: "line_1" } });
  });

  it("stops locally and closes media before failed persistence without reconnecting on intentional close", async () => {
    const transport = new FakeRehearsalTransport();
    transport.emitDisconnectedOnClose = true;
    const actorInput = new FakeActorInputSession();
    const rolePool = new FakeRolePool();
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport, actorInputSession: actorInput, rolePool,
      persistEvent: async (_sessionId, event) => {
        if (event.type === "stopped") throw new Error("offline");
      } });
    await controller.start();

    const stopping = controller.stop();

    expect(controller.state.status).toBe("stopped");
    expect(actorInput.closeReasons).toEqual(["stop"]);
    expect(rolePool.closeCalls).toBe(1);
    expect(transport.closeCalls).toBe(1);
    await stopping;
    expect(controller.state.status).toBe("stopped");
    expect(transport.resumeCalls).toBe(0);
    expect(controller.error).toBe("Rehearsal ended locally, but Stop could not be saved after three attempts.");
  });

  it("keeps a failed durable Stop visible when coaching upload also fails", async () => {
    // Break caught: a later coaching-upload error can overwrite the more important failed-Stop warning.
    const transport = new FakeRehearsalTransport();
    const recorder = new FakeTakeRecorder();
    let stopAttempts = 0;
    let rejectUpload: (error: Error) => void = () => undefined;
    const upload = new Promise<string>((_resolve, reject) => { rejectUpload = reject; });
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport, createRecorder: () => recorder,
      uploadCoachingTake: () => upload,
      persistEvent: async (_sessionId, event) => {
        if (event.type === "stopped") { stopAttempts += 1; throw new Error("offline"); }
      } });
    controller.setRecordForCoaching(true);
    await controller.start();

    const stopping = controller.stop();
    await vi.waitFor(() => expect(stopAttempts).toBe(3));
    rejectUpload(new Error("upload offline"));
    await stopping;

    expect(controller.error).toContain("Stop could not be saved");
    expect(controller.state.status).toBe("stopped");
    expect(transport.resumeCalls).toBe(0);
  });

  it("keeps Stop terminal and refuses to open media when a deferred connect completes late", async () => {
    const fetchResponse = new DeferredValue<Response>();
    const actors: FakeActorInputSession[] = [];
    const manager = new BrowserRehearsalClientTransport({
      fetch: () => fetchResponse.get(),
      createActorInputSession: () => {
        const actor = new FakeActorInputSession(); actors.push(actor); return actor;
      },
      createRolePool: () => new FakeRolePool(),
    });
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport: manager, persistEvent: async () => undefined });

    const starting = controller.start();
    await fetchResponse.requested;
    await controller.stop();
    fetchResponse.resolve(startGrantResponse("session_late"));
    await starting;

    expect(controller.state.status).toBe("stopped");
    expect(controller.connectionState).toBe("stopped");
    expect(actors).toHaveLength(0);
  });

  it("refuses new resume or grant requests after Stop closes the transport", async () => {
    const fetch = vi.fn(async () => startGrantResponse("session_1"));
    const manager = new BrowserRehearsalClientTransport({ fetch });

    await manager.close();

    await expect(manager.resume({ sessionId: "session_1", clientLastSequence: 1, playModelVersion: 1 }))
      .rejects.toThrow("transport is closed");
    await expect(manager.connect({ playId: "play_1", sceneId: "scene_1", actorRoleId: "char_actor" }))
      .rejects.toThrow("transport is closed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("closes and unsubscribes on unmount without synthesizing a durable stopped event", async () => {
    const transport = new FakeRehearsalTransport();
    const actorInput = new FakeActorInputSession();
    const rolePool = new FakeRolePool();
    const persisted: PersistedRehearsalEvent[] = [];
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport, actorInputSession: actorInput, rolePool,
      persistEvent: async (_sessionId, event) => { persisted.push(event); } });
    await controller.start();

    controller.dispose();
    transport.emit({ type: "speech_finished", characterId: "char_alex", elementId: "line_1", endedAtMs: 1_000 });
    await Promise.resolve();

    expect(actorInput.closeReasons).toEqual(["unmount"]);
    expect(rolePool.closeCalls).toBe(1);
    expect(transport.closeCalls).toBe(1);
    expect(persisted.map(({ type }) => type)).toEqual(["started"]);
    expect(controller.state.cursorElementId).toBe("line_1");
  });

  it("does not reopen media or overwrite disconnected state when resume completes after dispose", async () => {
    const resumeResponse = new DeferredValue<Response>();
    const actors: FakeActorInputSession[] = [];
    let fetchCalls = 0;
    const manager = new BrowserRehearsalClientTransport({
      fetch: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) return startGrantResponse("session_1");
        return await resumeResponse.get();
      },
      createActorInputSession: () => {
        const actor = new FakeActorInputSession(); actors.push(actor); return actor;
      },
      createRolePool: () => new FakeRolePool(),
    });
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport: manager, reconnectSleep: async () => undefined,
      persistEvent: async () => undefined });
    await controller.start();

    actors[0]!.emit({ type: "disconnected", reason: "network" });
    await resumeResponse.requested;
    controller.dispose();
    resumeResponse.resolve(resumeGrantResponse());
    await controller.waitForReconnect();

    expect(fetchCalls).toBe(2);
    expect(actors).toHaveLength(1);
    expect(actors[0]!.closeReasons).toEqual(["stop"]);
    expect(controller.state.status).toBe("disconnected");
    expect(controller.connectionState).toBe("disconnected");
  });

  it("restores disconnect reporting when recovery media cleanup fails", async () => {
    const actor = new FailingRecoveryCloseActorInputSession();
    const manager = new BrowserRehearsalClientTransport({
      fetch: async (input) => String(input).includes("/resume") ? resumeGrantResponse()
        : startGrantResponse("session_1"),
      createActorInputSession: () => actor,
      createRolePool: () => new FakeRolePool(),
    });
    const events: RealtimeEvent[] = [];
    manager.onEvent((event) => events.push(event));
    await manager.connect({ playId: "play_1", sceneId: "scene_1", actorRoleId: "char_actor" });

    await expect(manager.resume({ sessionId: "session_1", clientLastSequence: 1, playModelVersion: 1 }))
      .rejects.toThrow("recovery close failed");
    actor.emit({ type: "disconnected", reason: "still-offline" });

    expect(events.at(-1)).toEqual({ type: "disconnected", reason: "still-offline" });
  });

  it("offers server recovery after exhausted persistence attempts without restarting media", async () => {
    const transport = new FakeRehearsalTransport();
    const actorInput = new FakeActorInputSession();
    const rolePool = new FakeRolePool();
    let pauseAttempts = 0;
    const persistedTypes: string[] = [];
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport, actorInputSession: actorInput, rolePool,
      persistEvent: async (_sessionId, event) => {
        persistedTypes.push(event.type);
        if (event.type === "paused") { pauseAttempts += 1; throw new Error("offline"); }
      } });
    await controller.start();

    await controller.pause();

    expect(pauseAttempts).toBe(3);
    expect(controller.state).toMatchObject({ status: "disconnected", cursorElementId: "line_1" });
    expect(controller.persistenceState).toBe("recovering");
    expect(actorInput.pauseCalls).toBe(1);
    expect(controller.connectionState).toBe("disconnected");
    expect(controller.recoveryOptionsVisible).toBe(true);
    expect(rolePool.cancelActiveCalls).toBe(1);

    transport.resumeResponses.push({ recovery: { events: [
      { type: "started", sequence: 1, startedAtMs: 0 },
    ], serverLastSequence: 1, serverPlayModelVersion: 1, assignments: [
      { characterId: "char_alex", voice: "recovered-voice", engine: "realtime" },
    ] } });
    await controller.retryConnection();

    expect(controller.state).toMatchObject({ status: "active", lastSequence: 1, cursorElementId: "line_1" });
    expect(controller.persistenceState).toBe("open");
    expect(controller.recoveryOptionsVisible).toBe(false);
    expect(actorInput.resumeCalls).toBe(1);
    expect(persistedTypes).toEqual(["started", "paused", "paused", "paused"]);
  });

  it("reinstalls the media fence when persistence fails after Pause and Resume", async () => {
    // Break caught: the retained Pause fence can make later recovery skip capture and role-output cancellation.
    const transport = new FakeRehearsalTransport();
    const actorInput = new FakeActorInputSession();
    const rolePool = new FakeRolePool();
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport, actorInputSession: actorInput, rolePool,
      persistEvent: async (_sessionId, event) => {
        if (event.type === "ai_speech_started") throw new Error("offline");
      } });
    await controller.start();
    await controller.pause();
    await controller.resume();

    await controller.handleRealtimeEvent({ type: "speech_started", characterId: "char_alex",
      elementId: "line_1", startedAtMs: 1_000 });

    expect(controller.state.status).toBe("disconnected");
    expect(controller.persistenceState).toBe("recovering");
    expect(actorInput.pauseCalls).toBe(2);
    expect(rolePool.cancelActiveCalls).toBe(2);
  });

  it("requires an explicit acknowledged Continue choice after interruption", async () => {
    const transport = new FakeRehearsalTransport();
    const rolePool = new FakeRolePool();
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport, rolePool, persistEvent: async () => undefined });
    await controller.start();

    await controller.handleRealtimeEvent({ type: "interrupted", atMs: 10 });
    expect(controller.state).toMatchObject({ status: "await_interruption_choice", cursorElementId: "line_1" });
    expect(rolePool.continueCalls).toBe(0);

    await controller.cue();
    await controller.restartBeat();
    await controller.resume();
    expect(controller.state).toMatchObject({ status: "await_interruption_choice", cursorElementId: "line_1" });

    await controller.continueAfterInterruption();
    expect(rolePool.continueCalls).toBe(1);
    expect(controller.state).toMatchObject({ status: "active", cursorElementId: "line_2" });

    const markup = renderToStaticMarkup(<RehearsalShell playId="play_1" playModelVersion={1}
      scene={scene} actorRoleId="char_actor" transport={new FakeRehearsalTransport()}
      persistEvent={async () => undefined} />);
    expect(markup).toContain("Continue");
    expect(markup).toContain("Restart line");
  });

  it("exposes only interruption choices and Stop while waiting for an interruption choice", () => {
    const markup = renderToStaticMarkup(<RehearsalControls status="await_interruption_choice"
      onStart={() => undefined} onPause={() => undefined} onResume={() => undefined}
      onCue={() => undefined} onRestartBeat={() => undefined} onContinue={() => undefined}
      onRestartLine={() => undefined} onStop={() => undefined} />);

    expect(markup).toMatch(/disabled="">Cue<\/button>/);
    expect(markup).toMatch(/disabled="">Restart beat<\/button>/);
    expect(markup).toMatch(/disabled="">Resume<\/button>/);
    expect(markup).toContain(">Continue</button>");
    expect(markup).toContain(">Restart line</button>");
    expect(markup).toContain(">Stop rehearsal</button>");
  });

  it("does not offer server-illegal Cue or Restart beat actions while paused or disconnected", () => {
    for (const status of ["paused", "disconnected"] as const) {
      const markup = renderToStaticMarkup(<RehearsalControls status={status}
        onStart={() => undefined} onPause={() => undefined} onResume={() => undefined}
        onCue={() => undefined} onRestartBeat={() => undefined} onContinue={() => undefined}
        onRestartLine={() => undefined} onStop={() => undefined} />);
      expect(markup).toMatch(/disabled="">Restart beat<\/button>/);
      if (status === "disconnected") expect(markup).toMatch(/disabled="">Cue<\/button>/);
    }
  });

  it("installs a local disconnect fence before connection-loss persistence acknowledges", async () => {
    const transport = new FakeRehearsalTransport();
    const actorInput = new FakeActorInputSession();
    const rolePool = new FakeRolePool();
    let acknowledgeDisconnect!: () => void;
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport, actorInputSession: actorInput, rolePool,
      reconnectSleep: async () => undefined,
      persistEvent: async (_sessionId, event) => {
        if (event.type === "connection_lost") {
          await new Promise<void>((resolve) => { acknowledgeDisconnect = resolve; });
        }
      } });
    await controller.start();

    const disconnecting = controller.handleRealtimeEvent({ type: "disconnected", reason: "network" });
    const lateCompletion = controller.handleRealtimeEvent({ type: "speech_finished", characterId: "char_alex",
      elementId: "line_1", endedAtMs: 1_000 });

    expect(controller.state).toMatchObject({ status: "disconnected", cursorElementId: "line_1" });
    expect(actorInput.pauseCalls).toBe(1);
    expect(rolePool.cancelActiveCalls).toBe(1);
    await lateCompletion;
    acknowledgeDisconnect();
    await disconnecting;
    await controller.waitForReconnect();
    expect(controller.state.cursorElementId).toBe("line_1");
  });

  it("does not reveal a Cue before its durable command acknowledges", async () => {
    const transport = new FakeRehearsalTransport();
    let acknowledgeCue!: () => void;
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport, persistEvent: async (_sessionId, event) => {
        if (event.type === "cue_requested") await new Promise<void>((resolve) => { acknowledgeCue = resolve; });
      } });
    await controller.start();

    const cueing = controller.cue();
    expect(controller.revealedElementId).toBeNull();
    acknowledgeCue();
    await cueing;
    expect(controller.revealedElementId).toBe("line_1");
  });

  it("orders Pause before a synchronous late interruption and keeps the session resumable", async () => {
    const transport = new FakeRehearsalTransport();
    transport.emitInterruptionOnCancel = true;
    const persisted: PersistedRehearsalEvent[] = [];
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport,
      persistEvent: async (_sessionId, event) => { persisted.push(event); } });
    await controller.start();

    await controller.pause();

    expect(persisted.map(({ type }) => type)).toEqual(["started", "paused"]);
    expect(controller.state).toMatchObject({ status: "paused", pendingAction: null });
  });

  it("does not request microphone permission before the explicit Start gesture", async () => {
    const transport = new FakeRehearsalTransport();
    const persisted: PersistedRehearsalEvent[] = [];
    const markup = renderToStaticMarkup(<RehearsalShell playId="play_1" playModelVersion={1}
      scene={scene} actorRoleId="char_actor" transport={transport}
      persistEvent={async (_sessionId, event) => { persisted.push(event); }} />);
    const controller = rehearsalController(transport, persisted);

    expect(markup).toContain("Start rehearsal");
    expect(transport.connectCalls).toBe(0);
    await controller.start();

    expect(transport.connectCalls).toBe(1);
    expect(persisted).toEqual([{ type: "started", sequence: 1, startedAtMs: expect.any(Number) }]);
    expect(transport.speechRequests).toEqual([{ characterId: "char_alex", elementId: "line_1",
      exactText: "You came back.", performanceDirection: expect.stringContaining("exact supplied script text") }]);
  });

  it("hides the actor's upcoming line until Cue and persists cue_requested without advancing", async () => {
    const transport = new FakeRehearsalTransport();
    const persisted: PersistedRehearsalEvent[] = [];
    const controller = rehearsalController(transport, persisted);
    await controller.start();
    await controller.handleRealtimeEvent({ type: "speech_finished", characterId: "char_alex",
      elementId: "line_1", endedAtMs: 1_000 });

    expect(controller.state.cursorElementId).toBe("line_2");
    expect(controller.revealedElementId).toBeNull();
    await controller.cue();

    expect(controller.revealedElementId).toBe("line_2");
    expect(controller.state.cursorElementId).toBe("line_2");
    expect(persisted.map(({ type }) => type)).toEqual(["started", "ai_speech_finished", "cue_requested"]);
    expect(persisted.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
  });

  it("restarts from the nearest stored beat and closes transport on Stop", async () => {
    const transport = new FakeRehearsalTransport();
    const persisted: PersistedRehearsalEvent[] = [];
    const controller = rehearsalController(transport, persisted, ["line_1", "line_3"]);
    await controller.start();
    await controller.restartBeat();
    await controller.stop();

    expect(persisted.find(({ type }) => type === "restart_requested")).toMatchObject({ elementId: "line_1" });
    expect(persisted.at(-1)?.type).toBe("stopped");
    expect(transport.closeCalls).toBe(1);
  });

  it("starts optional actor-track coaching capture only on Start and uploads it on Stop", async () => {
    const transport = new FakeRehearsalTransport();
    const recorder = new FakeTakeRecorder();
    const uploads: Array<{ durationMs: number; mediaType: string; rehearsalSessionId?: string }> = [];
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport, persistEvent: async () => undefined,
      createRecorder: () => recorder, uploadCoachingTake: async (take) => {
        uploads.push({ durationMs: take.durationMs, mediaType: take.mediaType,
          rehearsalSessionId: take.rehearsalSessionId }); return "take_1";
      } });
    controller.setRecordForCoaching(true);

    expect(recorder.startCalls).toBe(0);
    await controller.start();
    expect(recorder.startCalls).toBe(1);
    const aiStream = { getTracks: () => [] } as unknown as MediaStream;
    transport.recordingAudioSink?.(aiStream);
    expect(recorder.audioStreams).toEqual([aiStream]);
    await controller.stop();

    expect(recorder.stopCalls).toBe(1);
    expect(transport.recordingAudioSink).toBeNull();
    expect(uploads).toEqual([{ durationMs: 2_000, mediaType: "audio/wav", rehearsalSessionId: "session_1" }]);
    expect(controller.uploadedTakeId).toBe("take_1");
  });

  it("tries three fresh resumptions before continuing from the uncompleted line with scripted voices", async () => {
    const transport = new FakeRehearsalTransport();
    const actorInput = new FakeActorInputSession();
    const persisted: PersistedRehearsalEvent[] = [];
    const delays: number[] = [];
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport, actorInputSession: actorInput,
      persistEvent: async (_sessionId, event) => { persisted.push(event); },
      reconnectSleep: async (delayMs) => { delays.push(delayMs); } });

    await controller.start();
    await controller.handleRealtimeEvent({ type: "disconnected", reason: "network" });
    await controller.waitForReconnect();

    expect(delays).toEqual([250, 1_000, 3_000]);
    expect(transport.resumeCalls).toBe(3);
    expect(controller.recoveryOptionsVisible).toBe(true);
    expect(controller.state.status).toBe("disconnected");
    expect(controller.state.pendingAction).toBeNull();
    expect(actorInput.resumeCalls).toBe(0);

    await controller.continueWithScriptedVoices();

    expect(persisted.map(({ type }) => type)).toEqual(["started", "connection_lost", "fallback_selected"]);
    expect(transport.scriptedFallbackCalls).toBe(1);
    expect(transport.scriptedFallbackAssignments).toEqual([{ characterId: "char_alex", voice: "persisted-voice",
      engine: "realtime" }]);
    expect(controller.state.cursorElementId).toBe("line_1");
    expect(transport.speechRequests.at(-1)).toEqual({ characterId: "char_alex", elementId: "line_1",
      exactText: "You came back.", performanceDirection: expect.stringContaining("exact supplied script text") });
  });

  it("rehydrates acknowledged history before capture resumes", async () => {
    const operations: Array<{ name: string; status?: string; cursor?: string | null; pending?: string | null;
      sequence?: number }> = [];
    const transport = new FakeRehearsalTransport();
    transport.resumeResponses.push(recoveryResponse(1));
    transport.onResume = () => operations.push({ name: "resume-response" });
    const actorInput = new FakeActorInputSession();
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport, actorInputSession: actorInput,
      persistEvent: async (_sessionId, event) => { if (event.type === "resumed") {
        operations.push({ name: "persist-resumed", sequence: event.sequence });
      } }, reconnectSleep: async () => undefined });
    actorInput.onResume = () => operations.push({ name: "capture-resume", status: controller.state.status,
      cursor: controller.state.cursorElementId, pending: controller.state.pendingAction?.type ?? null,
      sequence: controller.state.lastSequence });
    await controller.start();

    await controller.handleRealtimeEvent({ type: "disconnected", reason: "network" });
    await controller.waitForReconnect();

    expect(operations).toEqual([
      { name: "resume-response" },
      { name: "persist-resumed", sequence: 3 },
      { name: "capture-resume", status: "active", cursor: "line_1", pending: "speak", sequence: 3 },
    ]);
    expect(controller.state).toMatchObject({ status: "active", cursorElementId: "line_1", lastSequence: 3,
      pendingAction: { type: "speak", elementId: "line_1", characterId: "char_alex" } });
  });

  it("persists manual actor completion and advances only after fallback acknowledgement", async () => {
    const transport = new FakeRehearsalTransport();
    transport.readiness = { aiSpeech: "configured_tts", actorProgress: "manual", canContinue: true };
    const persisted: PersistedRehearsalEvent[] = [];
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport, persistEvent: async (_sessionId, event) => { persisted.push(event); },
      reconnectSleep: async () => undefined });
    await controller.start();
    await controller.handleRealtimeEvent({ type: "speech_finished", characterId: "char_alex",
      elementId: "line_1", endedAtMs: 100 });
    await controller.handleRealtimeEvent({ type: "disconnected", reason: "network" });
    await controller.waitForReconnect();
    await controller.continueWithScriptedVoices();

    await controller.completeActorLineManually();

    expect(persisted.at(-1)).toMatchObject({ type: "manual_actor_line_completed", sequence: 5,
      elementId: "line_2" });
    expect(controller.state.cursorElementId).toBe("line_3");
  });

  it("does not advance the local scene while the realtime connection is recovering", async () => {
    const transport = new FakeRehearsalTransport();
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport, persistEvent: async () => undefined,
      reconnectSleep: async () => undefined });
    await controller.start();
    await controller.handleRealtimeEvent({ type: "disconnected", reason: "network" });
    await controller.handleRealtimeEvent({ type: "speech_finished", characterId: "char_alex",
      elementId: "line_1", endedAtMs: 1_000 });

    expect(controller.state.cursorElementId).toBe("line_1");
    expect(controller.state.status).toBe("disconnected");
  });

  it("ends and saves when recovery reports a newer approved play model", async () => {
    const transport = new FakeRehearsalTransport();
    transport.resumeResponses.push(recoveryResponse(2));
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport, persistEvent: async () => undefined,
      reconnectSleep: async () => undefined });

    await controller.start();
    await controller.handleRealtimeEvent({ type: "disconnected", reason: "network" });
    await controller.waitForReconnect();

    expect(controller.state.status).toBe("disconnected");
    expect(controller.recoveryOptionsVisible).toBe(true);
    expect(controller.error).toContain("newer play version");
  });

  it("uses assignments returned by recovery when scripted fallback is later selected", async () => {
    const transport = new FakeRehearsalTransport();
    transport.resumeResponses.push(recoveryResponse(1, [{ characterId: "char_alex", voice: "recovered-voice",
      engine: "realtime" }]));
    const controller = new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
      actorRoleId: "char_actor", transport, persistEvent: async () => undefined,
      reconnectSleep: async () => undefined });

    await controller.start();
    await controller.handleRealtimeEvent({ type: "disconnected", reason: "network" });
    await controller.waitForReconnect();
    await controller.handleRealtimeEvent({ type: "disconnected", reason: "network" });
    await controller.waitForReconnect();
    await controller.continueWithScriptedVoices();

    expect(transport.scriptedFallbackAssignments).toEqual([{ characterId: "char_alex", voice: "recovered-voice",
      engine: "realtime" }]);
  });
});

function rehearsalController(transport: FakeRehearsalTransport, persisted: PersistedRehearsalEvent[],
  beatElementIds: string[] = []) {
  return new RehearsalShellController({ playId: "play_1", playModelVersion: 1, scene,
    actorRoleId: "char_actor", beatElementIds, transport,
    persistEvent: async (_sessionId, event) => { persisted.push(event); } });
}

class FakeRehearsalTransport implements RehearsalClientTransport {
  connectCalls = 0;
  closeCalls = 0;
  resumeCalls = 0;
  scriptedFallbackCalls = 0;
  emitDisconnectedOnClose = false;
  emitInterruptionOnCancel = false;
  readiness: FallbackReadiness = { aiSpeech: "configured_tts", actorProgress: "manual", canContinue: true };
  onResume: () => void = () => undefined;
  readonly resumeResponses: Array<{ recovery: { events: PersistedRehearsalEvent[]; serverLastSequence: number;
    serverPlayModelVersion: number; assignments: Array<{ characterId: string; voice: string;
      engine: "realtime" | "tts" }> } }> = [];
  readonly scriptedFallbackAssignments: Array<{ characterId: string; voice: string; engine: "realtime" | "tts" }> = [];
  readonly speechRequests: RealtimeSpeechRequest[] = [];
  recordingAudioSink: ((stream: MediaStream) => void) | null = null;
  private readonly listeners = new Set<(event: RealtimeEvent) => void>();
  async connect() { this.connectCalls += 1; return { rehearsalSessionId: "session_1", assignments: [
    { characterId: "char_alex", voice: "persisted-voice", engine: "realtime" as const },
  ] }; }
  async requestSpeech(input: RealtimeSpeechRequest) { this.speechRequests.push(input); }
  setRecordingAudioSink(sink: ((stream: MediaStream) => void) | null) { this.recordingAudioSink = sink; }
  async resume(_input: { sessionId: string; clientLastSequence: number; playModelVersion: number }): Promise<{
    recovery: { events: PersistedRehearsalEvent[]; serverLastSequence: number; serverPlayModelVersion: number;
      assignments: Array<{ characterId: string; voice: string; engine: "realtime" | "tts" }> };
  }> { this.resumeCalls += 1; const response = this.resumeResponses.shift();
    if (response) { this.onResume(); return response; }
    throw new Error("offline"); }
  fallbackReadiness() { return this.readiness; }
  async useScriptedFallback(input: { assignments: Array<{ characterId: string; voice: string;
    engine: "realtime" | "tts" }> }) { this.scriptedFallbackCalls += 1;
    this.scriptedFallbackAssignments.push(...input.assignments); }
  onEvent(listener: (event: RealtimeEvent) => void) { this.listeners.add(listener);
    return () => this.listeners.delete(listener); }
  emit(event: RealtimeEvent) { for (const listener of this.listeners) listener(event); }
  async cancelActive() { if (this.emitInterruptionOnCancel) this.emit({ type: "interrupted", atMs: 10 });
    return { elementId: "line_1" }; }
  async close() { this.closeCalls += 1;
    if (this.emitDisconnectedOnClose) this.emit({ type: "disconnected", reason: "closed" }); }
}

function recoveryResponse(serverPlayModelVersion: number, assignments: Array<{ characterId: string; voice: string;
  engine: "realtime" | "tts" }> = [{ characterId: "char_alex", voice: "persisted-voice", engine: "realtime" }]) {
  return { recovery: { events: [
    { type: "started" as const, sequence: 1, startedAtMs: 0 },
    { type: "connection_lost" as const, sequence: 2, reason: "network" },
  ], serverLastSequence: 2, serverPlayModelVersion, assignments } };
}

class FakeTakeRecorder implements TakeRecorder {
  startCalls = 0;
  stopCalls = 0;
  readonly audioStreams: MediaStream[] = [];
  async start() { this.startCalls += 1; }
  addAudioStream(stream: MediaStream) { this.audioStreams.push(stream); }
  async stop() { this.stopCalls += 1; return { blob: new Blob([new Uint8Array([1, 2])]), durationMs: 2_000,
    mimeType: "audio/wav" as const }; }
  cancel() {}
}

class FakeActorInputSession implements ActorInputSession {
  connectCalls = 0;
  pauseCalls = 0;
  resumeCalls = 0;
  readonly closeReasons: Array<"stop" | "unmount" | "recovery"> = [];
  onResume: () => void = () => undefined;
  private readonly listeners = new Set<(event: ActorInputEvent) => void>();
  async connectAfterUserGesture() { this.connectCalls += 1; }
  pauseCapture() { this.pauseCalls += 1; }
  resumeCapture() { this.resumeCalls += 1; this.onResume(); }
  onEvent(listener: (event: ActorInputEvent) => void) { this.listeners.add(listener);
    return () => this.listeners.delete(listener); }
  emit(event: ActorInputEvent) { for (const listener of this.listeners) listener(event); }
  async close(reason: "stop" | "unmount" | "recovery") { this.closeReasons.push(reason); }
}

class FailingRecoveryCloseActorInputSession extends FakeActorInputSession {
  override async close(reason: "stop" | "unmount" | "recovery") {
    if (reason === "recovery") throw new Error("recovery close failed");
    await super.close(reason);
  }
}

class FakeRolePool {
  cancelActiveCalls = 0;
  closeCalls = 0;
  continueCalls = 0;
  restartCalls = 0;
  readonly spoken: Array<{ elementId: string }> = [];
  async speak(input: { elementId: string }) {
    this.spoken.push(input); return { startedAtMs: 0, completion: Promise.resolve() };
  }
  async speechFinished() {}
  async cancelActive() { this.cancelActiveCalls += 1; return { elementId: "line_1" }; }
  continueAfterInterruption() { this.continueCalls += 1; }
  restartLine() { this.restartCalls += 1; }
  async close() { this.closeCalls += 1; }
}

class DeferredCompletionRolePool extends FakeRolePool {
  private resolveStarted: () => void = () => undefined;
  readonly started = new Promise<void>((resolve) => { this.resolveStarted = resolve; });
  private resolveCompletion: () => void = () => undefined;
  private rejectCompletion: (error: Error) => void = () => undefined;
  private completion = new Promise<void>((resolve, reject) => {
    this.resolveCompletion = resolve;
    this.rejectCompletion = reject;
  });
  override async speak(input: { elementId: string }) {
    this.spoken.push(input);
    this.resolveStarted();
    return { startedAtMs: 700, completion: this.completion };
  }
  override async cancelActive() {
    this.cancelActiveCalls += 1;
    this.rejectCompletion(new Error("playback interrupted"));
    return { elementId: "line_1" };
  }
  finish() { this.resolveCompletion(); }
}

class ManualStartPlayback implements TtsPlayback {
  private resolveRequested: () => void = () => undefined;
  readonly requested = new Promise<void>((resolve) => { this.resolveRequested = resolve; });
  private onStarted: () => void = () => undefined;
  private rejectCompletion: (error: Error) => void = () => undefined;
  private readonly completion = new Promise<void>((_resolve, reject) => { this.rejectCompletion = reject; });
  async speak(input: { onStarted?: () => void }) {
    this.onStarted = input.onStarted ?? (() => undefined);
    this.resolveRequested();
    await this.completion;
  }
  async stop() { this.rejectCompletion(new Error("playback interrupted")); }
  start() { this.onStarted(); }
}

class DeferredSpeechTransport extends FakeRehearsalTransport {
  private resolveStarted: () => void = () => undefined;
  readonly speechStarted = new Promise<void>((resolve) => { this.resolveStarted = resolve; });
  private resolveSpeech: () => void = () => undefined;
  private readonly speech = new Promise<void>((resolve) => { this.resolveSpeech = resolve; });
  override async requestSpeech(input: RealtimeSpeechRequest) {
    this.speechRequests.push(input);
    this.resolveStarted();
    await this.speech;
  }
  finishSpeech() { this.resolveSpeech(); }
}

class DeferredValue<T> {
  private resolveRequested: () => void = () => undefined;
  readonly requested = new Promise<void>((resolve) => { this.resolveRequested = resolve; });
  private resolveValue: (value: T) => void = () => undefined;
  readonly promise = new Promise<T>((resolve) => { this.resolveValue = resolve; });
  get(): Promise<T> { this.resolveRequested(); return this.promise; }
  resolve(value: T) { this.resolveValue(value); }
}

class FakeServerAudio {
  src = "";
  preload = "";
  currentTime = 0;
  pauseCalls = 0;
  playCalls = 0;
  removed = false;
  onplaying: ((event: Event) => void) | null = null;
  onended: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  async play() { this.playCalls += 1; }
  pause() { this.pauseCalls += 1; }
  remove() { this.removed = true; }
}

function startGrantResponse(sessionId: string): Response {
  return Response.json({ clientSecret: "ek_actor", expiresAt: "2099-01-01T00:00:00.000Z",
    model: "realtime", rehearsalSessionId: sessionId, assignments: [
      { characterId: "char_alex", voice: "cedar", engine: "realtime" },
  ] }, { status: 201 });
}

function configuredStartGrantResponse(sessionId: string, ttsConfigured: boolean): Response {
  return Response.json({ clientSecret: "ek_actor", expiresAt: "2099-01-01T00:00:00.000Z",
    model: "realtime", rehearsalSessionId: sessionId, ttsConfigured, assignments: [
      { characterId: "char_alex", voice: "cedar", engine: "realtime" },
    ] }, { status: 201 });
}

function resumeGrantResponse(): Response {
  return Response.json({
    grant: { clientSecret: "ek_actor_2", expiresAt: "2099-01-01T00:00:00.000Z",
      model: "realtime", rehearsalSessionId: "session_1" },
    recovery: recoveryResponse(1).recovery,
  });
}
