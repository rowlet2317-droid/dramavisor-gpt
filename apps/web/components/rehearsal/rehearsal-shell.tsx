"use client";

import { useEffect, useRef, useState } from "react";

import { TtsFallbackVoice } from "@drama/ai/character-voice/tts-fallback";
import type { RealtimeEvent, RealtimeSessionGrant, RealtimeSpeechRequest } from "@drama/ai/realtime/port";
import { createRehearsalState } from "@drama/domain/rehearsal/controller";
import { recoverSession } from "@drama/domain/rehearsal/recovery";
import { reduceRehearsal } from "@drama/domain/rehearsal/reducer";
import type { PersistedRehearsalEvent, RehearsalState } from "@drama/domain/rehearsal/types";
import type { VoiceAssignment } from "@drama/domain/rehearsal/voice-assignment";
import { BrowserTakeRecorder, type TakeRecorder } from "../../lib/audio/recorder";
import { RehearsalCommandQueue, RehearsalPersistenceError,
  type UnsequencedRehearsalEvent } from "../../lib/rehearsal/command-queue";
import { browserActorRecognitionAvailable, BrowserActorLineRecognition, BrowserSpeechSynthesisPlayback,
  fallbackReadiness, type FallbackReadiness, scriptedVoiceCapability,
  ServerConfiguredTtsPlayback } from "../../lib/realtime/fallback-player";
import { BrowserActorInputSession, type ActorInputEvent, type ActorInputSession } from "../../lib/realtime/actor-input-session";
import { BoundedReconnect, ReconnectCancelledError, ReconnectExhaustedError } from "../../lib/realtime/reconnect";
import { BrowserRoleVoiceSession } from "../../lib/realtime/role-voice-session";
import { BrowserRemoteAudioSink, type RemoteMediaStream } from "../../lib/realtime/remote-audio-sink";
import { RoleVoiceSessionPool, type QueuedCharacterSpeech, type RoleVoicePlayback,
  type VoiceCancellationReason } from "../../lib/realtime/voice-pool";

import { ConnectionRecovery } from "./connection-recovery";
import { PositionConfirmation } from "./position-confirmation";
import { RehearsalControls } from "./rehearsal-controls";
import { ScriptCursor } from "./script-cursor";

export type RehearsalScene = { id: string; title: string; lines: Array<{ elementId: string; ordinal: number;
  characterId: string; characterName: string; text: string; voiceLabel: string }> };

type ConnectInput = { playId: string; sceneId: string; actorRoleId: string; signal?: AbortSignal };

export interface RehearsalClientTransport {
  connect(input: ConnectInput): Promise<{ rehearsalSessionId: string; assignments: VoiceAssignment[] }>;
  resume(input: { sessionId: string; clientLastSequence: number; playModelVersion: number; signal?: AbortSignal }): Promise<{
    recovery: { events: PersistedRehearsalEvent[]; serverLastSequence: number; serverPlayModelVersion: number;
      assignments: VoiceAssignment[] };
  }>;
  useScriptedFallback(input: { assignments: VoiceAssignment[] }): Promise<void>;
  fallbackReadiness?(input: { assignments: VoiceAssignment[] }): FallbackReadiness;
  requestSpeech(input: RealtimeSpeechRequest): Promise<void>;
  onEvent(listener: (event: RealtimeEvent) => void): () => void;
  close(): Promise<void>;
  pauseCapture?(): void;
  resumeCapture?(): void;
  cancelActive?(atMs: number, reason?: VoiceCancellationReason): Promise<{ elementId: string } | null>;
  continueAfterInterruption?(elementId: string): void;
  restartLine?(elementId: string): void;
  setRecordingAudioSink?(sink: ((stream: MediaStream) => void) | null): void;
}

type PersistEvent = (sessionId: string, event: PersistedRehearsalEvent) => Promise<void>;

export interface RehearsalRolePool {
  speak(input: QueuedCharacterSpeech): Promise<RoleVoicePlayback>;
  speechFinished(elementId: string): Promise<void>;
  cancelActive(atMs: number, reason?: VoiceCancellationReason): Promise<{ elementId: string } | null>;
  continueAfterInterruption(elementId: string): void;
  restartLine(elementId: string): void;
  close(): Promise<void>;
}

type ControllerOptions = { playId: string; playModelVersion: number; scene: RehearsalScene; actorRoleId: string;
  beatElementIds?: string[]; transport: RehearsalClientTransport; persistEvent: PersistEvent;
  actorInputSession?: ActorInputSession; rolePool?: RehearsalRolePool;
  createRecorder?: () => TakeRecorder;
  uploadCoachingTake?: (take: { blob: Blob; durationMs: number; mediaType: string;
    rehearsalSessionId: string }) => Promise<string>;
  reconnectSleep?: (delayMs: number) => Promise<void>;
  e2eDisconnectAfterSpeechCount?: number;
  initialTimeline?: Array<{ elementId: string; characterName: string; voiceLabel: string; text: string }>;
  nowMs?: () => number };

export class RehearsalShellController {
  state: RehearsalState;
  readonly lineTimeline: Array<{ elementId: string; characterName: string; voiceLabel: string; text: string }>;
  recordForCoaching = false;
  uploadedTakeId: string | null = null;
  connectionState: "not_connected" | "connecting" | "connected" | "disconnected" | "stopped"
    = "not_connected";
  revealedElementId: string | null = null;
  error = "";
  recoveryOptionsVisible = false;
  reconnecting = false;
  fallbackActive = false;
  private readonly nowMs: () => number;
  private readonly unsubscribe: () => void;
  private readonly commandQueue: RehearsalCommandQueue;
  private sessionId: string | null = null;
  private requestedElementId: string | null = null;
  private recorder: TakeRecorder | null = null;
  private assignments: VoiceAssignment[] = [];
  private reconnectPromise: Promise<void> | null = null;
  private reconnectCoordinator: BoundedReconnect<Awaited<ReturnType<RehearsalClientTransport["resume"]>>> | null = null;
  private onChange: (() => void) | null = null;
  private terminalLocally = false;
  private disposed = false;
  private lifecycleGeneration = 0;
  private readonly lifecycleAbortController = new AbortController();

  get persistenceState() { return this.commandQueue.queueState; }
  get scriptedFallbackReadiness(): FallbackReadiness {
    const assignments = this.fallbackAssignments();
    return this.options.transport.fallbackReadiness?.({ assignments })
      ?? { aiSpeech: "unavailable", actorProgress: "manual", canContinue: false };
  }

  constructor(private readonly options: ControllerOptions) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.state = createRehearsalState({ sessionId: "pending", actorRoleId: options.actorRoleId,
      lines: options.scene.lines.map(({ elementId, ordinal, characterId, text }) => (
        { elementId, ordinal, characterId, text })) });
    this.lineTimeline = [...(options.initialTimeline ?? [])];
    this.commandQueue = new RehearsalCommandQueue({ state: this.state, persistEvent: async (event) => {
      if (!this.sessionId) throw new Error("Rehearsal session is not connected");
      await options.persistEvent(this.sessionId, event);
    }, onAcknowledged: async (event, state, previousState) => {
      const generation = this.lifecycleGeneration;
      if (!this.isLifecycleCurrent(generation)) return;
      this.state = state;
      this.error = "";
      if (event.type === "cue_requested") this.revealedElementId = state.cursorElementId;
      if (event.type === "restart_requested") {
        this.revealedElementId = null;
        this.requestedElementId = null;
      }
      if (event.type === "position_confirmed") this.requestedElementId = null;
      if (event.type === "actor_line_final") this.recordActorLine(event.text, previousState.cursorElementId);
      if (event.type === "ai_speech_started") this.recordAiLine(event.characterId, event.elementId);
      if (event.type === "resumed" && state.status === "active") {
        if (this.options.actorInputSession) this.options.actorInputSession.resumeCapture();
        else this.options.transport.resumeCapture?.();
      }
      if (event.type === "continue_after_interruption") {
        if (this.options.rolePool) this.options.rolePool.continueAfterInterruption(event.elementId);
        else this.options.transport.continueAfterInterruption?.(event.elementId);
      }
      if (event.type === "restart_line") {
        if (this.options.rolePool) this.options.rolePool.restartLine(event.elementId);
        else this.options.transport.restartLine?.(event.elementId);
      }
      if (event.type === "fallback_selected") {
        const assignments = this.fallbackAssignments();
        try {
          await this.options.transport.useScriptedFallback({ assignments });
          if (!this.isLifecycleCurrent(generation)) return;
          this.recoveryOptionsVisible = false;
          this.connectionState = "connected";
          this.fallbackActive = true;
        } catch (error) {
          this.error = error instanceof Error ? error.message : "Scripted fallback voices are unavailable.";
          this.notify();
          return;
        }
      }
      if (!this.isLifecycleCurrent(generation)) return;
      this.notify();
      await this.performPendingAction();
    }, onEffectError: (error) => {
      if (this.terminalLocally || this.disposed) return;
      this.requestedElementId = null;
      this.error = error instanceof Error ? error.message : "AI rehearsal speech failed.";
      this.notify();
    } });
    const unsubscribers = [options.transport.onEvent((event) => { void this.handleRealtimeEvent(event); })];
    if (options.actorInputSession) unsubscribers.push(options.actorInputSession.onEvent((event) => {
      void this.handleActorInputEvent(event);
    }));
    this.unsubscribe = () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
  }

  setChangeListener(listener: (() => void) | null): void { this.onChange = listener; }

  setRecordForCoaching(enabled: boolean): void {
    if (this.state.status !== "ready") return;
    this.recordForCoaching = enabled; this.notify();
  }

  async start(): Promise<void> {
    if (this.state.status !== "ready" || this.terminalLocally || this.disposed) return;
    const generation = this.lifecycleGeneration;
    this.lineTimeline.splice(0);
    this.connectionState = "connecting"; this.notify();
    try {
      if (this.recordForCoaching) {
        if (!this.options.createRecorder) throw new Error("Coaching recorder is unavailable");
        this.recorder = this.options.createRecorder();
        await this.recorder.start();
        this.options.transport.setRecordingAudioSink?.((stream) => this.recorder?.addAudioStream?.(stream));
        if (!this.isLifecycleCurrent(generation)) return;
      }
      const session = await this.options.transport.connect({ playId: this.options.playId,
        sceneId: this.options.scene.id, actorRoleId: this.options.actorRoleId,
        signal: this.lifecycleAbortController.signal });
      if (!this.isLifecycleCurrent(generation)) {
        await this.options.transport.close();
        return;
      }
      this.sessionId = session.rehearsalSessionId;
      this.assignments = session.assignments;
      this.state = { ...this.state, sessionId: session.rehearsalSessionId };
      this.commandQueue.state = this.state;
      await this.options.actorInputSession?.connectAfterUserGesture();
      if (!this.isLifecycleCurrent(generation)) {
        await Promise.all([this.options.actorInputSession?.close("stop"), this.options.transport.close()]);
        return;
      }
      this.connectionState = "connected";
      await this.accept({ type: "started", startedAtMs: this.nowMs() });
    } catch (error) {
      if (!this.isLifecycleCurrent(generation)) return;
      this.recorder?.cancel(); this.recorder = null;
      this.options.transport.setRecordingAudioSink?.(null);
      this.connectionState = "disconnected";
      this.error = error instanceof Error ? error.message : "Rehearsal could not start";
      this.notify();
    }
  }

  async cue(): Promise<void> {
    if (!this.sessionId || !this.state.cursorElementId
      || !["active", "paused", "needs_position_confirmation"].includes(this.state.status)) return;
    await this.accept({ type: "cue_requested" });
  }

  async pause(): Promise<void> {
    if (this.state.status === "active" || this.state.status === "disconnected") {
      this.commandQueue.installSafetyFence("pause");
      this.state = { ...this.state, status: "paused", pendingAction: null };
      if (this.options.actorInputSession) this.options.actorInputSession.pauseCapture();
      else this.options.transport.pauseCapture?.();
      const persistence = this.accept({ type: "paused" });
      const cancellation = this.options.rolePool
        ? this.options.rolePool.cancelActive(this.nowMs(), "pause")
        : this.options.transport.cancelActive?.(this.nowMs(), "pause");
      this.notify();
      await Promise.all([persistence, cancellation]);
    }
  }

  async resume(): Promise<void> {
    if (this.state.status === "paused" || this.state.status === "disconnected") {
      await this.accept({ type: "resumed" });
    }
  }

  async restartBeat(): Promise<void> {
    if (!this.sessionId || !["active", "needs_position_confirmation"].includes(this.state.status)) return;
    const elementId = this.nearestBeat();
    await this.accept({ type: "restart_requested", elementId });
  }

  async continueAfterInterruption(): Promise<void> {
    const action = this.state.pendingAction;
    if (action?.type !== "await_interruption_choice") return;
    await this.accept({ type: "continue_after_interruption", elementId: action.elementId });
  }

  async restartInterruptedLine(): Promise<void> {
    const action = this.state.pendingAction;
    if (action?.type !== "await_interruption_choice") return;
    this.requestedElementId = null;
    await this.accept({ type: "restart_line", elementId: action.elementId });
  }

  async confirmPosition(elementId: string): Promise<void> {
    await this.accept({ type: "position_confirmed", elementId });
  }

  async submitActorLine(text?: string): Promise<void> {
    const line = this.options.scene.lines.find(({ elementId }) => elementId === this.state.cursorElementId);
    if (!line || line.characterId !== this.options.actorRoleId) return;
    await this.accept({ type: "actor_line_final", text: text ?? line.text,
      endedAtMs: this.nowMs() });
  }

  async completeActorLineManually(): Promise<void> {
    const line = this.options.scene.lines.find(({ elementId }) => elementId === this.state.cursorElementId);
    if (!this.fallbackActive || this.scriptedFallbackReadiness.actorProgress !== "manual"
      || !line || line.characterId !== this.options.actorRoleId || this.state.status !== "active") return;
    await this.accept({ type: "manual_actor_line_completed", elementId: line.elementId, endedAtMs: this.nowMs() });
  }

  async stop(): Promise<void> {
    if (this.terminalLocally) return;
    const shouldPersist = this.sessionId !== null && this.state.status !== "stopped" && this.state.status !== "completed";
    this.terminalLocally = true;
    this.error = "";
    this.cancelLifecycleWork();
    this.commandQueue.installSafetyFence("stop");
    this.state = { ...this.state, status: "stopped", pendingAction: null };
    this.connectionState = "stopped";
    this.notify();
    const persistence = shouldPersist ? this.persistTerminalStop() : Promise.resolve(true);
    const closing = Promise.all([
      this.options.actorInputSession?.close("stop"),
      this.options.rolePool?.close(),
      this.options.transport.close(),
    ]);
    const recorder = this.recorder;
    this.recorder = null;
    this.options.transport.setRecordingAudioSink?.(null);
    let coachingUploadFailed = false;
    if (recorder && this.options.uploadCoachingTake && this.sessionId) {
      try {
        const take = await recorder.stop();
        this.uploadedTakeId = await this.options.uploadCoachingTake({ blob: take.blob,
          durationMs: take.durationMs, mediaType: take.mimeType, rehearsalSessionId: this.sessionId });
      } catch {
        recorder.cancel();
        coachingUploadFailed = true;
      }
    }
    await closing;
    const stopSaved = await persistence;
    if (!stopSaved) {
      this.error = coachingUploadFailed
        ? "Rehearsal ended locally, but Stop could not be saved after three attempts. The actor coaching track also could not be uploaded."
        : "Rehearsal ended locally, but Stop could not be saved after three attempts.";
    } else if (coachingUploadFailed) {
      this.error = "The actor coaching track could not be uploaded.";
    }
    this.commandQueue.close();
    this.connectionState = "stopped"; this.notify();
  }

  async retryConnection(): Promise<void> {
    if (!this.sessionId || this.reconnectPromise || this.terminalLocally || this.disposed) {
      return this.reconnectPromise ?? Promise.resolve();
    }
    const generation = this.lifecycleGeneration;
    this.recoveryOptionsVisible = false;
    this.reconnecting = true;
    this.notify();
    const reconnect = new BoundedReconnect({ reconnect: async () => {
      if (!this.isLifecycleCurrent(generation)) throw new ReconnectCancelledError();
      const result = await this.options.transport.resume({
        sessionId: this.sessionId!, clientLastSequence: this.commandQueue.state.lastSequence,
        playModelVersion: this.options.playModelVersion, signal: this.lifecycleAbortController.signal,
      });
      if (!this.isLifecycleCurrent(generation)) throw new ReconnectCancelledError();
      return result;
    }, sleep: this.options.reconnectSleep });
    this.reconnectCoordinator = reconnect;
    this.reconnectPromise = reconnect.run().then(async ({ recovery }) => {
      if (!this.isLifecycleCurrent(generation)) return;
      this.assignments = recovery.assignments;
      const initial = createRehearsalState({ sessionId: this.sessionId!, actorRoleId: this.options.actorRoleId,
        lines: this.options.scene.lines.map(({ elementId, ordinal, characterId, text }) => (
          { elementId, ordinal, characterId, text })) });
      const decision = recoverSession(initial, recovery.events, { clientLastSequence: this.commandQueue.state.lastSequence,
        serverLastSequence: recovery.serverLastSequence, expectedPlayModelVersion: this.options.playModelVersion,
        serverPlayModelVersion: recovery.serverPlayModelVersion });
      this.state = decision.state;
      this.commandQueue.rehydrate({ state: decision.state, lastSequence: decision.lastSequence });
      if (!this.isLifecycleCurrent(generation)) return;
      if (decision.kind === "end_and_save") {
        this.error = "This rehearsal uses a newer play version. End and save this session.";
        this.recoveryOptionsVisible = true;
        return;
      }
      this.connectionState = "connected";
      if (this.state.status === "disconnected" || this.state.status === "paused") {
        await this.accept({ type: "resumed" });
      } else {
        this.error = "";
        this.recoveryOptionsVisible = false;
        if (this.state.status === "active") {
          if (this.options.actorInputSession) this.options.actorInputSession.resumeCapture();
          else this.options.transport.resumeCapture?.();
        }
        this.notify();
        await this.performPendingAction();
      }
    }).catch((error: unknown) => {
      if (!this.isLifecycleCurrent(generation) || error instanceof ReconnectCancelledError) return;
      this.connectionState = "disconnected";
      this.recoveryOptionsVisible = error instanceof ReconnectExhaustedError;
      this.error = this.recoveryOptionsVisible ? "Realtime connection could not be restored."
        : error instanceof Error ? error.message : "Realtime connection could not be restored.";
    }).finally(() => {
      if (this.reconnectCoordinator === reconnect) this.reconnectCoordinator = null;
      this.reconnectPromise = null;
      if (!this.isLifecycleCurrent(generation)) return;
      this.reconnecting = false;
      this.notify();
    });
    return this.reconnectPromise;
  }

  async waitForReconnect(): Promise<void> { await this.reconnectPromise; }

  async continueWithScriptedVoices(): Promise<void> {
    if (!this.sessionId || this.state.status !== "disconnected" || !this.scriptedFallbackReadiness.canContinue) return;
    await this.accept({ type: "fallback_selected" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelLifecycleWork();
    this.unsubscribe();
    if (!this.terminalLocally) {
      this.terminalLocally = true;
      this.commandQueue.installSafetyFence("unmount");
      this.commandQueue.close();
      void Promise.all([
        this.options.actorInputSession?.close("unmount"),
        this.options.rolePool?.close(),
        this.options.transport.close(),
      ]);
    }
    this.recorder?.cancel();
    this.recorder = null;
    this.options.transport.setRecordingAudioSink?.(null);
  }

  async handleRealtimeEvent(event: RealtimeEvent): Promise<void> {
    if (this.terminalLocally) return;
    if (!this.sessionId) return;
    if (this.connectionState === "disconnected" && event.type !== "disconnected") return;
    if (!this.providerEventPermitted(event)) return;
    switch (event.type) {
      case "actor_transcript_partial":
        this.state = reduceRehearsal(this.state, { type: "actor_partial", text: event.text });
        this.commandQueue.state = this.state;
        this.notify(); return;
      case "actor_transcript_final":
        await this.accept({ type: "actor_line_final", text: event.text,
          endedAtMs: event.endedAtMs }); return;
      case "speech_started":
        await this.accept({ type: "ai_speech_started",
          characterId: event.characterId, elementId: event.elementId, startedAtMs: event.startedAtMs }); return;
      case "speech_finished":
        await this.accept({ type: "ai_speech_finished",
          characterId: event.characterId, elementId: event.elementId, endedAtMs: event.endedAtMs }); return;
      case "interrupted":
        this.commandQueue.installSafetyFence("interruption");
        if (this.state.cursorElementId) this.state = { ...this.state, status: "await_interruption_choice",
          pendingAction: { type: "await_interruption_choice", elementId: this.state.cursorElementId } };
        this.notify();
        await this.accept({ type: "interrupted", elementId: this.state.cursorElementId ?? undefined,
          atMs: event.atMs }); return;
      case "disconnected": {
        this.commandQueue.installSafetyFence("disconnect");
        this.connectionState = "disconnected";
        this.requestedElementId = null;
        this.state = { ...this.state, status: "disconnected", pendingAction: null };
        if (this.options.actorInputSession) this.options.actorInputSession.pauseCapture();
        else this.options.transport.pauseCapture?.();
        const cancellation = this.options.rolePool
          ? this.options.rolePool.cancelActive(this.nowMs(), "disconnect")
          : this.options.transport.cancelActive?.(this.nowMs(), "disconnect");
        this.notify();
        await Promise.all([this.accept({ type: "connection_lost", reason: event.reason }), cancellation]);
        void this.retryConnection();
        return;
      }
    }
  }

  private async handleActorInputEvent(event: ActorInputEvent): Promise<void> {
    if (event.type === "actor_speech_started") {
      if (this.state.status !== "active") return;
      const cancellation = this.options.rolePool
        ? this.options.rolePool.cancelActive(event.startedAtMs)
        : this.options.transport.cancelActive?.(event.startedAtMs);
      const interrupted = await cancellation;
      if (interrupted) await this.handleRealtimeEvent({ type: "interrupted", atMs: event.startedAtMs });
      return;
    }
    if (event.type === "actor_transcript_partial") {
      await this.handleRealtimeEvent({ type: "actor_transcript_partial", text: event.text });
      return;
    }
    if (event.type === "actor_transcript_final") {
      await this.handleRealtimeEvent({ type: "actor_transcript_final", text: event.text,
        endedAtMs: event.endedAtMs });
      return;
    }
    await this.handleRealtimeEvent(event);
  }

  private async accept(event: UnsequencedRehearsalEvent): Promise<void> {
    try {
      await this.commandQueue.enqueue(event);
    } catch (error) {
      if (this.terminalLocally || this.disposed) return;
      this.enterPersistenceRecovery(error);
    }
  }

  private async persistTerminalStop(): Promise<boolean> {
    try {
      await this.commandQueue.enqueue({ type: "stopped" });
      return true;
    } catch {
      return false;
    }
  }

  private enterPersistenceRecovery(error: unknown): void {
    const mediaAlreadyFenced = this.state.status === "paused" || this.connectionState === "disconnected";
    this.commandQueue.installSafetyFence("disconnect");
    if (!mediaAlreadyFenced) {
      if (this.options.actorInputSession) this.options.actorInputSession.pauseCapture();
      else this.options.transport.pauseCapture?.();
      const cancellation = this.options.rolePool
        ? this.options.rolePool.cancelActive(this.nowMs(), "disconnect")
        : this.options.transport.cancelActive?.(this.nowMs(), "disconnect");
      void cancellation?.catch(() => undefined);
    }
    this.state = { ...this.state, status: "disconnected", pendingAction: null };
    this.connectionState = "disconnected";
    this.recoveryOptionsVisible = true;
    this.error = error instanceof RehearsalPersistenceError && error.status === 409
      ? "This rehearsal changed on the server. Retry to recover the latest saved position."
      : "This rehearsal event could not be saved after three attempts. Retry to recover from the server.";
    this.notify();
  }

  private providerEventPermitted(event: RealtimeEvent): boolean {
    switch (event.type) {
      case "actor_transcript_partial":
      case "actor_transcript_final":
        return this.state.status === "active" || this.state.status === "needs_position_confirmation";
      case "speech_started":
        return this.state.status === "active";
      case "speech_finished":
        return this.state.status === "active" || this.state.status === "await_interruption_choice";
      case "interrupted":
        return this.state.status === "active";
      case "disconnected":
        return true;
    }
  }

  private async performPendingAction(): Promise<void> {
    if (this.terminalLocally || this.disposed) return;
    const action = this.state.pendingAction;
    if (action?.type !== "speak") { this.requestedElementId = null; return; }
    if (this.requestedElementId === action.elementId) return;
    const line = this.options.scene.lines.find(({ elementId }) => elementId === action.elementId);
    if (!line) return;
    this.requestedElementId = action.elementId;
    this.notify();
    const performanceDirection = `${line.characterName} (${line.voiceLabel}). `
      + "Use only the exact supplied script text; never invent or paraphrase dialogue.";
    if (this.options.rolePool) {
      await this.options.rolePool.speak({ characterId: line.characterId, elementId: line.elementId,
        ordinal: line.ordinal, exactText: line.text, direction: performanceDirection });
    } else {
      await this.options.transport.requestSpeech({ characterId: line.characterId, elementId: line.elementId,
        exactText: line.text, performanceDirection });
    }
  }

  private nearestBeat(): string {
    const current = this.options.scene.lines.find(({ elementId }) => elementId === this.state.cursorElementId);
    const beats = new Set(this.options.beatElementIds ?? []);
    return this.options.scene.lines.filter((line) => beats.has(line.elementId)
      && line.ordinal <= (current?.ordinal ?? Number.MAX_SAFE_INTEGER)).at(-1)?.elementId
      ?? this.options.scene.lines[0]?.elementId ?? "";
  }

  private fallbackAssignments(): VoiceAssignment[] {
    return this.assignments.length ? this.assignments.filter(({ characterId }) => (
      characterId !== this.options.actorRoleId
    )) : fallbackAssignments(this.options.scene, this.options.actorRoleId);
  }

  private isLifecycleCurrent(generation: number): boolean {
    return generation === this.lifecycleGeneration && !this.terminalLocally && !this.disposed;
  }

  private cancelLifecycleWork(): void {
    this.lifecycleGeneration += 1;
    this.lifecycleAbortController.abort();
    this.reconnectCoordinator?.cancel();
    this.reconnecting = false;
  }

  private recordActorLine(text: string, elementId: string | null): void {
    const line = this.options.scene.lines.find((candidate) => candidate.elementId === elementId);
    if (line?.characterId === this.options.actorRoleId) this.lineTimeline.push({ elementId: line.elementId,
      characterName: line.characterName, voiceLabel: line.voiceLabel, text });
  }

  private recordAiLine(characterId: string, elementId: string): void {
    const line = this.options.scene.lines.find((candidate) => candidate.elementId === elementId
      && candidate.characterId === characterId);
    if (line) this.lineTimeline.push({ elementId: line.elementId, characterName: line.characterName,
      voiceLabel: line.voiceLabel, text: line.text });
  }

  private notify(): void { this.onChange?.(); }
}

export function RehearsalShell({ playId, playModelVersion, scene, actorRoleId, beatElementIds = [], transport,
  persistEvent = persistRehearsalEvent, e2eMode = false, e2eDisconnectAfterSpeechCount }: { playId: string; playModelVersion: number;
  scene: RehearsalScene; actorRoleId: string; beatElementIds?: string[]; transport?: RehearsalClientTransport;
  persistEvent?: PersistEvent; e2eMode?: boolean; e2eDisconnectAfterSpeechCount?: number }) {
  const [, render] = useState(0);
  const controllerRef = useRef<RehearsalShellController | null>(null);
  const timelineStorageKey = `dramavisor:rehearsal-timeline:${playId}:${scene.id}:${actorRoleId}`;
  if (!controllerRef.current) controllerRef.current = new RehearsalShellController({ playId, playModelVersion,
    scene, actorRoleId, beatElementIds,
    transport: transport ?? new BrowserRehearsalClientTransport({ e2eMode, e2eDisconnectAfterSpeechCount }),
    reconnectSleep: e2eMode ? async () => undefined : undefined,
    persistEvent, createRecorder: () => e2eMode ? new E2eTakeRecorder() : new BrowserTakeRecorder(),
    uploadCoachingTake: (take) => uploadActorCoachingTake(playId, playModelVersion, scene.id, actorRoleId, take) });
  const controller = controllerRef.current;
  useEffect(() => { controller.setChangeListener(() => render((value) => value + 1));
    return () => { controller.setChangeListener(null); controller.dispose(); }; }, [controller]);
  useEffect(() => {
    const restored = readTimeline(timelineStorageKey);
    if (!restored.length) return;
    controller.lineTimeline.splice(0, controller.lineTimeline.length, ...restored);
    render((value) => value + 1);
  }, [controller, timelineStorageKey]);
  useEffect(() => { if (typeof sessionStorage !== "undefined") {
    sessionStorage.setItem(timelineStorageKey, JSON.stringify(controller.lineTimeline));
  } });
  const state = controller.state;
  const confirmation = state.pendingAction?.type === "confirm_position" ? state.pendingAction.candidates : null;
  const current = scene.lines.find(({ elementId }) => elementId === state.cursorElementId);
  return <section className="rehearsal-shell" aria-labelledby="rehearsal-heading">
    <header><p className="eyebrow">Voice-only rehearsal</p><h1 id="rehearsal-heading">Rehearse {scene.title}</h1>
      <p>Connection: {controller.connectionState.replaceAll("_", " ")} · Sequence {state.lastSequence}</p></header>
    <ScriptCursor scene={scene} actorRoleId={actorRoleId} cursorElementId={state.cursorElementId}
      revealedElementId={controller.revealedElementId} transcriptPreview={state.transcriptPreview} />
    <label><input type="checkbox" checked={controller.recordForCoaching} disabled={state.status !== "ready"}
      onChange={(event) => controller.setRecordForCoaching(event.target.checked)} /> Record for coaching</label>
    {confirmation ? <PositionConfirmation candidates={confirmation}
      onSelect={(elementId) => void controller.confirmPosition(elementId)} /> : null}
    <RehearsalControls status={state.status} onStart={() => void controller.start()}
      onPause={() => void controller.pause()} onResume={() => void controller.resume()}
      onCue={() => void controller.cue()} onRestartBeat={() => void controller.restartBeat()}
      onContinue={() => void controller.continueAfterInterruption()}
      onRestartLine={() => void controller.restartInterruptedLine()}
      onStop={() => void controller.stop()} />
    <ConnectionRecovery visible={controller.recoveryOptionsVisible} reconnecting={controller.reconnecting}
      readiness={controller.scriptedFallbackReadiness}
      onRetry={() => void controller.retryConnection()} onFallback={() => void controller.continueWithScriptedVoices()}
      onEndAndSave={() => void controller.stop()} />
    <ManualActorProgress visible={controller.fallbackActive && current?.characterId === actorRoleId
      && state.status === "active" && controller.scriptedFallbackReadiness.actorProgress === "manual"}
      onComplete={() => void controller.completeActorLineManually()} />
    {e2eMode && current?.characterId === actorRoleId && state.status === "active"
      ? <button type="button" onClick={() => void controller.submitActorLine()}>Speak actor line</button> : null}
    {controller.lineTimeline.length ? <section aria-labelledby="timeline-heading"><h2 id="timeline-heading">
      Rehearsal line order</h2><ol aria-label="Rehearsal line order">{controller.lineTimeline.map((line, index) =>
        <li key={`${line.elementId}:${index}`} data-element-id={line.elementId} data-voice={line.voiceLabel}>
          {line.characterName} — {line.voiceLabel}: {line.text}</li>)}</ol></section> : null}
    {state.status === "completed" ? <p role="status">Scene complete. Stop and save when you are ready.</p> : null}
    {controller.uploadedTakeId ? <a className="button-link"
      href={`/plays/${encodeURIComponent(playId)}/takes/${encodeURIComponent(controller.uploadedTakeId)}`}>
      Open queued coaching take</a> : null}
    {controller.error ? <p role="alert">{controller.error}</p> : null}
  </section>;
}

export function ManualActorProgress({ visible, onComplete }: { visible: boolean; onComplete: () => void }) {
  return visible ? <button type="button" onClick={onComplete}>Line complete</button> : null;
}

type BrowserTransportOptions = {
  e2eMode?: boolean;
  e2eDisconnectAfterSpeechCount?: number;
  fetch?: typeof fetch;
  createActorInputSession?: (grant: RealtimeSessionGrant) => ActorInputSession;
  createRolePool?: (input: { assignments: VoiceAssignment[];
    onEvent: (event: RealtimeEvent) => void }) => RehearsalRolePool;
  nowMs?: () => number;
};

export class BrowserRehearsalClientTransport implements RehearsalClientTransport {
  private readonly listeners = new Set<(event: RealtimeEvent) => void>();
  private readonly fetch: typeof fetch;
  private readonly nowMs: () => number;
  private actorInput: ActorInputSession | null = null;
  private rolePool: RehearsalRolePool | null = null;
  private assignments = new Map<string, VoiceAssignment>();
  private e2eSpeechRequestCount = 0;
  private e2eDisconnected = false;
  private terminal = false;
  private mediaGeneration = 0;
  private suppressDisconnect = false;
  private fallbackRecognition: BrowserActorLineRecognition | null = null;
  private configuredTts = false;
  private closePromise: Promise<void> | null = null;
  private actorInterruption: Promise<void> | null = null;
  private capturePaused = false;
  private recordingAudioSink: ((stream: MediaStream) => void) | null = null;

  constructor(private readonly options: BrowserTransportOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async connect(input: ConnectInput): Promise<{ rehearsalSessionId: string; assignments: VoiceAssignment[] }> {
    const generation = this.mediaGeneration;
    const { signal, ...requestInput } = input;
    this.assertMediaOpen(generation, signal);
    const response = await this.fetch("/api/realtime/session", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "start", ...requestInput }), signal });
    this.assertMediaOpen(generation, signal);
    if (!response.ok) throw new Error("Realtime rehearsal session could not start");
    const grant = await response.json() as RealtimeSessionGrant & { assignments?: VoiceAssignment[];
      ttsConfigured?: boolean };
    this.assertMediaOpen(generation, signal);
    const assignments = grant.assignments ?? [];
    this.configuredTts = grant.ttsConfigured === true;
    this.currentSessionId = grant.rehearsalSessionId;
    if (!this.options.e2eMode) await this.openMedia(grant, assignments, generation, signal);
    this.assertMediaOpen(generation, signal);
    return { rehearsalSessionId: grant.rehearsalSessionId, assignments };
  }

  async requestSpeech(input: RealtimeSpeechRequest): Promise<void> {
    if (this.terminal) throw new Error("Realtime rehearsal transport is closed");
    if (this.rolePool) {
      const pool = this.rolePool;
      const assignment = this.assignments.get(input.characterId);
      const started = await pool.speak({ characterId: input.characterId, elementId: input.elementId,
        ordinal: this.e2eSpeechRequestCount += 1, exactText: input.exactText,
        direction: input.performanceDirection });
      if (assignment?.engine === "tts") {
        if (this.terminal) return;
        this.emit({ type: "speech_started", characterId: input.characterId, elementId: input.elementId,
          startedAtMs: started.startedAtMs });
        try {
          await started.completion;
          if (!this.terminal) this.emit({ type: "speech_finished", characterId: input.characterId,
            elementId: input.elementId, endedAtMs: this.nowMs() });
        } finally {
          await pool.speechFinished(input.elementId);
        }
      }
      return;
    }
    if (!this.options.e2eMode) throw new Error("Realtime rehearsal transport is not connected");
    this.e2eSpeechRequestCount += 1;
    if (!this.e2eDisconnected && this.e2eSpeechRequestCount === this.options.e2eDisconnectAfterSpeechCount) {
      this.e2eDisconnected = true;
      this.emit({ type: "disconnected", reason: "e2e_fake_realtime_disconnected" });
      return;
    }
    this.emit({ type: "speech_started", characterId: input.characterId, elementId: input.elementId,
      startedAtMs: Date.now() });
    queueMicrotask(() => this.emit({ type: "speech_finished", characterId: input.characterId,
      elementId: input.elementId, endedAtMs: Date.now() }));
  }

  async resume(input: { sessionId: string; clientLastSequence: number; playModelVersion: number;
    signal?: AbortSignal }) {
    const generation = this.mediaGeneration;
    const { signal } = input;
    this.assertMediaOpen(generation, signal);
    const response = await this.fetch(`/api/rehearsals/${encodeURIComponent(input.sessionId)}/resume`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({
        clientLastSequence: input.clientLastSequence, playModelVersion: input.playModelVersion }), signal });
    this.assertMediaOpen(generation, signal);
    if (!response.ok) throw new Error("Realtime rehearsal could not resume");
    const body = await response.json() as { grant: RealtimeSessionGrant; recovery: { events: PersistedRehearsalEvent[];
      serverLastSequence: number; serverPlayModelVersion: number; assignments: VoiceAssignment[] } };
    this.assertMediaOpen(generation, signal);
    if (this.options.e2eMode && this.options.e2eDisconnectAfterSpeechCount) {
      throw new Error("e2e fake realtime reconnect failed");
    }
    if (body.recovery.serverPlayModelVersion !== input.playModelVersion) return body;
    if (!this.options.e2eMode) {
      this.suppressDisconnect = true;
      try {
        await this.closeMedia("recovery");
        this.assertMediaOpen(generation, signal);
        await this.openMedia(body.grant, body.recovery.assignments, generation, signal, true);
        this.assertMediaOpen(generation, signal);
        this.pauseCapture();
      } finally {
        if (this.canUseMedia(generation, signal)) this.suppressDisconnect = false;
      }
    }
    return body;
  }

  async useScriptedFallback(input: { assignments: VoiceAssignment[] }): Promise<void> {
    const generation = this.mediaGeneration;
    this.assertMediaOpen(generation);
    if (this.options.e2eMode) return;
    const fallbackAssignments = input.assignments.map((assignment) => ({ ...assignment, engine: "tts" as const }));
    const readiness = this.fallbackReadiness({ assignments: fallbackAssignments });
    if (!readiness.canContinue) throw new Error("Distinct scripted fallback voices are unavailable in this browser");
    await this.rolePool?.close();
    this.assertMediaOpen(generation);
    this.rolePool = this.createRolePool(fallbackAssignments);
    this.assignments = new Map(fallbackAssignments.map((assignment) => [assignment.characterId, assignment]));
    if (readiness.actorProgress === "browser_recognition") {
      this.fallbackRecognition = new BrowserActorLineRecognition(({ text, final }) => this.emit(final
        ? { type: "actor_transcript_final", text, endedAtMs: this.nowMs() }
        : { type: "actor_transcript_partial", text }));
      this.fallbackRecognition.start();
    }
  }

  fallbackReadiness(input: { assignments: VoiceAssignment[] }): FallbackReadiness {
    if (this.options.e2eMode) return fallbackReadiness({ tts: true, realtimeTranscript: false,
      browserRecognition: false });
    const assignments = input.assignments.map((assignment) => ({ ...assignment, engine: "tts" as const }));
    const browserVoices = typeof speechSynthesis === "undefined" ? undefined : speechSynthesis.getVoices();
    const capability = scriptedVoiceCapability(assignments,
      { configuredTts: this.configuredTts, browserVoices });
    return fallbackReadiness({ tts: capability.ready && capability.mode === "configured_tts",
      browserDistinctVoices: capability.ready && capability.mode === "browser_distinct_voices",
      realtimeTranscript: false, browserRecognition: browserActorRecognitionAvailable() });
  }

  onEvent(listener: (event: RealtimeEvent) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.terminal = true;
    this.mediaGeneration += 1;
    this.suppressDisconnect = true;
    this.closePromise = this.closeMedia("stop");
    return this.closePromise;
  }

  pauseCapture(): void { this.capturePaused = true; this.actorInput?.pauseCapture(); }
  resumeCapture(): void { this.capturePaused = false; this.actorInput?.resumeCapture(); }
  async cancelActive(atMs: number, reason: VoiceCancellationReason = "interruption"):
    Promise<{ elementId: string } | null> {
    return await this.rolePool?.cancelActive(atMs, reason) ?? null;
  }
  continueAfterInterruption(elementId: string): void { this.rolePool?.continueAfterInterruption(elementId); }
  restartLine(elementId: string): void { this.rolePool?.restartLine(elementId); }
  setRecordingAudioSink(sink: ((stream: MediaStream) => void) | null): void { this.recordingAudioSink = sink; }

  private async openMedia(grant: RealtimeSessionGrant, assignments: VoiceAssignment[], generation: number,
    signal?: AbortSignal, startPaused = false): Promise<void> {
    this.assertMediaOpen(generation, signal);
    this.suppressDisconnect = false;
    this.capturePaused = startPaused;
    this.assignments = new Map(assignments.map((assignment) => [assignment.characterId, assignment]));
    const actor = this.options.createActorInputSession?.(grant) ?? new BrowserActorInputSession({
      requestGrant: async () => grant,
    });
    const pool = this.createRolePool(assignments);
    this.actorInput = actor;
    this.rolePool = pool;
    actor.onEvent((event) => {
      if (event.type === "actor_speech_started") {
        if (this.capturePaused) return;
        // The role pool is the sole producer of the interruption event.  Cancelling
        // here keeps actor VAD at the provider boundary and prevents duplicate events.
        if (!this.actorInterruption) {
          const interruption = pool.cancelActive(event.startedAtMs).then(() => undefined, () => undefined);
          this.actorInterruption = interruption;
          void interruption.finally(() => {
            if (this.actorInterruption === interruption) this.actorInterruption = null;
          });
        }
        return;
      }
      this.emit(actorInputRealtimeEvent(event));
    });
    await actor.connectAfterUserGesture({ startPaused });
    if (!this.canUseMedia(generation, signal)) {
      if (this.actorInput === actor) {
        this.actorInput = null;
        this.rolePool = null;
        await Promise.all([actor.close("stop"), pool.close()]);
      }
      this.assertMediaOpen(generation, signal);
    }
  }

  private createRolePool(assignments: VoiceAssignment[]): RehearsalRolePool {
    const onEvent = (event: RealtimeEvent) => this.emit(event);
    if (this.options.createRolePool) return this.options.createRolePool({ assignments, onEvent });
    const pool = new RoleVoiceSessionPool({ assignments,
      createRealtimeSession: (assignment) => new BrowserRoleVoiceSession({
        requestGrant: () => this.requestRoleGrant(assignment),
        audioSink: new BrowserRemoteAudioSink(undefined, (stream: RemoteMediaStream) => {
          this.recordingAudioSink?.(stream as MediaStream);
        }),
        onEvent: (event) => {
          if (event.type === "interrupted") return;
          this.emit(event);
          if (event.type === "speech_finished") void pool.speechFinished(event.elementId);
        },
      }),
      createTtsVoice: (assignment) => new TtsFallbackVoice(assignment.voice,
        this.configuredTts && this.currentSessionId
          ? new ServerConfiguredTtsPlayback({ rehearsalSessionId: this.currentSessionId, fetch: this.fetch,
            onAudioStream: (stream) => this.recordingAudioSink?.(stream) })
          : new BrowserSpeechSynthesisPlayback(), this.nowMs),
      nowMs: this.nowMs,
      onEvent: (event) => onEvent({ type: "interrupted", atMs: event.atMs }),
    });
    return pool;
  }

  private async requestRoleGrant(assignment: VoiceAssignment): Promise<RealtimeSessionGrant> {
    const generation = this.mediaGeneration;
    this.assertMediaOpen(generation);
    const rehearsalSessionId = this.currentSessionId;
    if (!rehearsalSessionId) throw new Error("Realtime rehearsal transport is not connected");
    const response = await this.fetch("/api/realtime/session", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "role_output",
        rehearsalSessionId, roleId: assignment.characterId }) });
    this.assertMediaOpen(generation);
    if (!response.ok) throw new Error("Realtime role session could not start");
    const grant = await response.json() as RealtimeSessionGrant;
    this.assertMediaOpen(generation);
    return grant;
  }

  private currentSessionId: string | null = null;

  private async closeMedia(reason: "stop" | "recovery"): Promise<void> {
    const actor = this.actorInput;
    const pool = this.rolePool;
    this.actorInput = null;
    this.rolePool = null;
    this.actorInterruption = null;
    this.fallbackRecognition?.stop();
    this.fallbackRecognition = null;
    await Promise.all([actor?.close(reason), pool?.close()]);
  }

  private emit(event: RealtimeEvent): void {
    if (this.terminal || (event.type === "disconnected" && this.suppressDisconnect)) return;
    for (const listener of this.listeners) listener(event);
  }

  private canUseMedia(generation: number, signal?: AbortSignal): boolean {
    return !this.terminal && generation === this.mediaGeneration && !signal?.aborted;
  }

  private assertMediaOpen(generation: number, signal?: AbortSignal): void {
    if (!this.canUseMedia(generation, signal)) throw new Error("Realtime rehearsal transport is closed");
  }
}

function actorInputRealtimeEvent(event: ActorInputEvent): RealtimeEvent {
  if (event.type === "actor_transcript_partial") {
    return { type: "actor_transcript_partial", text: event.text };
  }
  if (event.type === "actor_transcript_final") {
    return { type: "actor_transcript_final", text: event.text, endedAtMs: event.endedAtMs };
  }
  if (event.type === "disconnected") return event;
  throw new Error("Actor speech-start events must be handled at the actor-input boundary");
}

async function persistRehearsalEvent(sessionId: string, event: PersistedRehearsalEvent): Promise<void> {
  const response = await fetch(`/api/rehearsals/${encodeURIComponent(sessionId)}/events`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ event }) });
  if (!response.ok) throw new RehearsalPersistenceError(response.status);
}

async function uploadActorCoachingTake(playId: string, playModelVersion: number, sceneId: string,
  actorRoleId: string, take: { blob: Blob; durationMs: number; mediaType: string;
    rehearsalSessionId: string }): Promise<string> {
  const form = new FormData();
  form.set("audio", new File([take.blob], take.mediaType.includes("wav") ? "rehearsal.wav" : "rehearsal.webm",
    { type: take.mediaType }));
  form.set("durationMs", String(take.durationMs));
  form.set("playModelVersion", String(playModelVersion));
  form.set("sceneId", sceneId); form.set("roleId", actorRoleId); form.set("retentionChoice", "retain");
  form.set("practiceMode", "complete_take");
  form.set("rehearsalSessionId", take.rehearsalSessionId);
  const response = await fetch(`/api/plays/${encodeURIComponent(playId)}/takes`, { method: "POST", body: form });
  if (!response.ok) throw new Error("Coaching take upload failed");
  const body = await response.json() as { take?: { id?: string } };
  if (!body.take?.id) throw new Error("Coaching take response is invalid");
  return body.take.id;
}

class E2eTakeRecorder implements TakeRecorder {
  async start(): Promise<void> {}
  async stop() { return { blob: new Blob([e2eWav().buffer as ArrayBuffer], { type: "audio/wav" }), durationMs: 1_000,
    mimeType: "audio/wav" }; }
  cancel(): void {}
}

function e2eWav(): Uint8Array {
  const sampleRate = 16_000;
  const samples = Int16Array.from({ length: sampleRate }, (_, index) =>
    Math.round(8_192 * Math.sin(2 * Math.PI * 220 * index / sampleRate)));
  const bytes = new Uint8Array(44 + samples.length * 2); const view = new DataView(bytes.buffer);
  bytes.set([82, 73, 70, 70], 0); view.setUint32(4, bytes.length - 8, true); bytes.set([87, 65, 86, 69], 8);
  bytes.set([102, 109, 116, 32], 12); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); bytes.set([100, 97, 116, 97], 36);
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true)); return bytes;
}

function readTimeline(key: string): Array<{ elementId: string; characterName: string; voiceLabel: string; text: string }> {
  if (typeof sessionStorage === "undefined") return [];
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(value) && value.every((line) => line && typeof line === "object"
      && typeof (line as { elementId?: unknown }).elementId === "string"
      && typeof (line as { characterName?: unknown }).characterName === "string"
      && typeof (line as { voiceLabel?: unknown }).voiceLabel === "string"
      && typeof (line as { text?: unknown }).text === "string")
      ? value as Array<{ elementId: string; characterName: string; voiceLabel: string; text: string }> : [];
  } catch { return []; }
}

function fallbackAssignments(scene: RehearsalScene, actorRoleId: string): VoiceAssignment[] {
  return [...new Map(scene.lines.filter(({ characterId }) => characterId !== actorRoleId)
    .map(({ characterId, voiceLabel }) => [characterId, { characterId, voice: voiceLabel,
      engine: "tts" as const }])).values()];
}
