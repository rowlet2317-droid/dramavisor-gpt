# Plan 3 Production Rehearsal Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the normal browser rehearsal path audible, transcribed, multi-role, strictly ordered, lifecycle-safe, recoverable, and capable of producing truthful rehearsal-linked cue-responsiveness coaching evidence.

**Architecture:** One actor-input WebRTC session owns microphone capture and transcription; a separate, lazy pool owns at most four voice-fixed AI-role output sessions, with overflow routed through a capability-checked scripted TTS adapter. Every durable UI/provider action passes through one acknowledgement-gated FIFO command queue, while immediate local safety fences stop media before Pause, Stop, unmount, disconnect, or interruption waits on the network. Server row locks enforce the same terminal state model, and a forward-only owner-scoped schema link supplies deterministic rehearsal timing evidence to coaching.

**Tech Stack:** TypeScript 7, React 19, Next.js 16, OpenAI Realtime WebRTC, Vitest 4, Playwright, Drizzle ORM, PostgreSQL/PGlite, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-25-plan-3-production-rehearsal-completion-design.md`

## Global Constraints

- Release scope remains invite-only, English-only, voice-only, browser-first private beta.
- Microphone access occurs only after an explicit Start user gesture.
- Actor input uses one independent session; it does not consume one of the four AI-role session slots.
- No more than four AI roles use concurrent Realtime output sessions; every additional role uses scripted TTS.
- AI dialogue is exact pinned script text plus bounded performance direction; no invention or paraphrase is permitted.
- Durable state and sequence advance only after server acknowledgement; nondurable transcript preview and connection indicators may update optimistically.
- Pause, Stop, interruption, disconnect, and unmount install immediate local media fences before network acknowledgement.
- Provider credentials remain server-side; browser grants stay short-lived and owner/play/scene/role scoped.
- Operational logs never contain script, transcript, audio, prompt, credential, provider body, or arbitrary exception text.
- Provider-backed thresholds and ten-actor usefulness ratings remain external release gates and must never be fabricated.
- Each task ends with focused tests, typecheck, review, a local commit, and an immediate GitHub checkpoint before the next task begins.

## File Structure

- `packages/ai/src/realtime/port.ts`: provider-independent actor-input and role-output grants/events.
- `packages/ai/src/realtime/openai-credentials.ts`: server-authored Realtime session configuration.
- `apps/web/lib/realtime/webrtc-base.ts`: shared negotiation, data-channel, close, and intentional-close behavior.
- `apps/web/lib/realtime/actor-input-session.ts`: microphone, VAD, transcript accumulation, capture controls.
- `apps/web/lib/realtime/role-voice-session.ts`: remote audio attachment, exact-line output, cancellation.
- `apps/web/lib/realtime/remote-audio-sink.ts`: managed injectable audio sink with deterministic cleanup.
- `apps/web/lib/realtime/voice-pool.ts`: four-session AI-role pool and overflow TTS routing.
- `apps/web/lib/rehearsal/command-queue.ts`: acknowledgement-gated durable command serialization and recovery barrier.
- `apps/web/components/rehearsal/rehearsal-shell.tsx`: production composition and controller orchestration only.
- `packages/domain/src/rehearsal/{types,reducer,transitions}.ts`: status-aware durable state and legal transition rules.
- `packages/db/src/repositories/rehearsal.ts`: locked persistence and terminal retry enforcement.
- `apps/web/lib/realtime/fallback-player.ts`: explicit TTS/transcription/manual readiness contract.
- `packages/db/migrations/0020_rehearsal_linked_coaching.sql`: forward-only owner-scoped take/timing evidence schema.
- `packages/db/src/schema.ts`: Drizzle representation of migration 0020.
- `apps/web/app/api/plays/[playId]/takes/handler.ts`: validates and stores nullable rehearsal linkage.
- `apps/worker/src/jobs/measure-take.ts`: deterministic cue-response timing measurement publication.
- `apps/worker/src/jobs/synthesize-coaching.ts`: consumes, but never invents, cue-response measurement.
- `tests/e2e/plan-3-production-rehearsal.spec.ts`: production-shaped browser acceptance path.

---

### Task 1: Provider Session Contracts and Audible WebRTC Media

**Files:**
- Modify: `packages/ai/src/realtime/port.ts`
- Modify: `packages/ai/src/realtime/openai-credentials.ts`
- Modify: `packages/ai/src/realtime/openai-credentials.test.ts`
- Create: `apps/web/lib/realtime/webrtc-base.ts`
- Create: `apps/web/lib/realtime/remote-audio-sink.ts`
- Create: `apps/web/lib/realtime/actor-input-session.ts`
- Create: `apps/web/lib/realtime/role-voice-session.ts`
- Replace tests in: `apps/web/lib/realtime/session.test.ts`
- Modify: `apps/web/app/api/realtime/session/handler.ts`
- Modify: `apps/web/app/api/realtime/session/route.test.ts`

**Interfaces:**
- Consumes: existing short-lived credential issuance and `RealtimeSpeechRequest` exact text/direction.
- Produces: `RealtimeSessionPurpose`, `ActorInputSession`, `RoleVoiceSession`, `RemoteAudioSink`, and purpose-scoped grants used by Tasks 2–4.

- [ ] **Step 1: Write failing server configuration tests**

Add assertions that credential issuance sends distinct server-owned configurations:

```ts
await issuer.issue({ userId, purpose: { type: "actor_input" } });
expect(providerBody.session).toMatchObject({
  type: "realtime",
  output_modalities: ["text"],
  audio: { input: { transcription: { model: expect.any(String) },
    turn_detection: { type: "server_vad" } } },
});

await issuer.issue({ userId, purpose: { type: "role_output", roleId, voice: "cedar" } });
expect(providerBody.session).toMatchObject({
  type: "realtime",
  output_modalities: ["audio"],
  audio: { output: { voice: "cedar" } },
});
```

- [ ] **Step 2: Run the credential tests and verify RED**

Run: `pnpm vitest packages/ai/src/realtime/openai-credentials.test.ts apps/web/app/api/realtime/session/route.test.ts --run`

Expected: FAIL because `issue()` accepts no purpose and provider configuration omits transcription/output voice.

- [ ] **Step 3: Add explicit purpose-scoped types and issuance**

Define and use these exact public types:

```ts
export type RealtimeSessionPurpose =
  | { type: "actor_input" }
  | { type: "role_output"; roleId: string; voice: string };

export interface RealtimeCredentialIssuer {
  issue(input: { userId: string; purpose: RealtimeSessionPurpose }): Promise<IssuedRealtimeCredentials>;
}
```

Use a discriminated request union: `{ type: "start"; playId; sceneId; actorRoleId }` creates the rehearsal and returns its actor-input grant plus persisted assignments; `{ type: "role_output"; rehearsalSessionId; roleId }` issues a later role-output grant without creating another rehearsal. The API handler must validate that the requested role belongs to the pinned scene and persisted assignment before issuing a role-output grant. Never accept a browser-selected arbitrary voice.

- [ ] **Step 4: Write failing browser contract tests**

Use injected peer connections, tracks, data channels, media streams, and an audio sink to prove:

```ts
expect(getUserMedia).not.toHaveBeenCalled();
await actor.connectAfterUserGesture();
expect(getUserMedia).toHaveBeenCalledTimes(1);

peer.emitTrack(remoteStream);
expect(audioSink.attach).toHaveBeenCalledWith(remoteStream);

channel.emit({ type: "conversation.item.input_audio_transcription.delta",
  item_id: "item-1", content_index: 0, delta: "To " });
channel.emit({ type: "conversation.item.input_audio_transcription.completed",
  item_id: "item-1", content_index: 0, transcript: "To be" });
expect(events).toContainEqual({ type: "actor_transcript_final", text: "To be",
  endedAtMs: 1200, providerItemId: "item-1", contentIndex: 0 });
```

Also assert role output adds no microphone track, installs `ontrack` before offer creation, marks speech complete only on the provider completion event, sends `response.cancel`, and closes sink/channel/peer idempotently.

- [ ] **Step 5: Run the browser tests and verify RED**

Run: `pnpm vitest apps/web/lib/realtime/session.test.ts --run`

Expected: FAIL because the current combined transport always captures the microphone and never attaches remote media.

- [ ] **Step 6: Implement shared WebRTC base and split sessions**

Expose these exact interfaces:

```ts
export interface ActorInputSession {
  connectAfterUserGesture(): Promise<void>;
  pauseCapture(): void;
  resumeCapture(): void;
  onEvent(listener: (event: ActorInputEvent) => void): () => void;
  close(reason: "stop" | "unmount" | "recovery"): Promise<void>;
}

export interface RoleVoiceSession {
  speak(input: RealtimeSpeechRequest): Promise<void>;
  cancelSpeech(): Promise<void>;
  close(): Promise<void>;
}
```

`WebRtcBase` must distinguish intentional close from provider disconnect, remove all listeners during close, and expose neither provider bodies nor credentials through errors/logs. `RemoteAudioSink` must set `autoplay`, attach the remote stream, call `play()`, and clear/pause/remove its element on close.

- [ ] **Step 7: Run focused GREEN gates**

Run: `pnpm vitest packages/ai/src/realtime/openai-credentials.test.ts apps/web/app/api/realtime/session/route.test.ts apps/web/lib/realtime/session.test.ts --run`

Run: `pnpm typecheck && pnpm eslint packages/ai/src/realtime apps/web/lib/realtime apps/web/app/api/realtime/session`

Expected: all pass; `git diff --check` returns no output.

- [ ] **Step 8: Review, commit, and persist checkpoint 1**

Review for credential scope, microphone gesture gating, `ontrack` ordering, intentional-close suppression, and log redaction.

Commit: `git commit -m "feat: split realtime input and role media sessions"`

Upload the exact tree to `agent/plan-3-realtime-20260822` and verify the remote tree hash before Task 2.

---

### Task 2: Stable AI Role Sessions, Four-Role Cap, Overflow TTS, and Interruption

**Files:**
- Modify: `apps/web/lib/realtime/voice-pool.ts`
- Modify: `apps/web/lib/realtime/voice-pool.test.ts`
- Modify: `apps/web/lib/realtime/fallback-player.ts`
- Modify: `apps/web/lib/realtime/fallback-player.test.ts`
- Modify: `packages/ai/src/character-voice/realtime-role.ts`
- Modify: `packages/ai/src/character-voice/tts-fallback.ts`

**Interfaces:**
- Consumes: `RoleVoiceSession` and purpose-scoped role grants from Task 1; persisted `VoiceAssignment[]`.
- Produces: `RoleVoiceSessionPool`, `ScriptedVoiceCapability`, interruption metadata, and exact speech completion promises used by Task 3.

- [ ] **Step 1: Write failing pool and overflow tests**

Prove four deterministic role sessions remain stable and a fifth assignment never evicts/reuses a Realtime voice:

```ts
for (const role of firstFourRoles) await pool.speak(lineFor(role));
await pool.speak(lineFor(fifthRole));

expect(createRealtimeSession).toHaveBeenCalledTimes(4);
expect(createTtsVoice).toHaveBeenCalledWith(expect.objectContaining({ characterId: fifthRole }));
expect(pool.assignmentFor(firstFourRoles[0])).toEqual(originalAssignment);
```

Add tests that actor speech-start cancels active output immediately, rejects queued output, preserves the interrupted element ID, and requires an explicit later Continue or Restart Line command.

- [ ] **Step 2: Run pool tests and verify RED**

Run: `pnpm vitest apps/web/lib/realtime/voice-pool.test.ts apps/web/lib/realtime/fallback-player.test.ts --run`

Expected: FAIL because the current pool evicts a Realtime session and fallback silently chooses the first browser voice.

- [ ] **Step 3: Replace LRU behavior with assignment-enforced routing**

Implement:

```ts
export type ScriptedVoiceCapability =
  | { ready: true; mode: "configured_tts" | "browser_distinct_voices" }
  | { ready: false; reason: "tts_unconfigured" | "distinct_browser_voices_unavailable" };

export class RoleVoiceSessionPool {
  speak(input: QueuedCharacterSpeech): Promise<{ startedAtMs: number }>;
  cancelActive(atMs: number): Promise<{ elementId: string } | null>;
  close(): Promise<void>;
}
```

The four persisted Realtime assignments own stable lazy sessions for the whole rehearsal. An assignment marked `tts` always uses the configured TTS adapter. Browser synthesis is eligible only when all assigned voice names resolve to distinct suitable local voices; never fall back to `supported[0]`.

- [ ] **Step 4: Add exact-text and fixed-voice assertions**

Assert each role request contains the exact pinned line and bounded direction, the role grant is requested once with its persisted voice before first output, and later lines reuse that session without voice mutation.

- [ ] **Step 5: Run focused GREEN gates**

Run: `pnpm vitest apps/web/lib/realtime/voice-pool.test.ts apps/web/lib/realtime/fallback-player.test.ts packages/ai/src/character-voice/character-voice.test.ts --run`

Run: `pnpm typecheck && pnpm eslint apps/web/lib/realtime packages/ai/src/character-voice`

Expected: all pass and `git diff --check` is clean.

- [ ] **Step 6: Review, commit, and persist checkpoint 2**

Review stable voice identity, exact script preservation, the hard four-session cap, fifth-role TTS, and interruption cancellation.

Commit: `git commit -m "feat: add stable role voice session pool"`

Upload and verify the branch before Task 3.

---

### Task 3: Serialized Commands and Lifecycle-Safe Rehearsal Composition

**Files:**
- Create: `apps/web/lib/rehearsal/command-queue.ts`
- Create: `apps/web/lib/rehearsal/command-queue.test.ts`
- Modify: `apps/web/components/rehearsal/rehearsal-shell.tsx`
- Modify: `apps/web/components/rehearsal/rehearsal-shell.test.tsx`
- Modify: `apps/web/components/rehearsal/rehearsal-controls.tsx`
- Modify: `packages/domain/src/rehearsal/types.ts`
- Modify: `packages/domain/src/rehearsal/reducer.ts`
- Create: `packages/domain/src/rehearsal/reducer.test.ts`
- Modify: `packages/domain/src/rehearsal/controller.test.ts`

**Interfaces:**
- Consumes: actor-input session, `RoleVoiceSessionPool`, cancellation, and fallback capability from Tasks 1–2.
- Produces: `RehearsalCommandQueue`, terminal/local fence state, `continue_after_interruption` and `restart_line` events used by Task 4.

- [ ] **Step 1: Write failing FIFO/acknowledgement tests**

Use deferred persistence promises to prove:

```ts
const first = queue.enqueue({ type: "actor_line_final", text: "A", endedAtMs: 10 });
const second = queue.enqueue({ type: "ai_speech_started", characterId: "b", elementId: "2", startedAtMs: 11 });
expect(posted).toEqual([{ ...firstEvent, sequence: 1 }]);
ackFirst();
await first;
expect(posted).toEqual([expect.objectContaining({ sequence: 1 }), expect.objectContaining({ sequence: 2 })]);
```

Add cases for failed POST not reducing local state, retrying an identical event with the same sequence, 409 conflict entering recovery, and no N+1 send before N acknowledgement.

- [ ] **Step 2: Run queue tests and verify RED**

Run: `pnpm vitest apps/web/lib/rehearsal/command-queue.test.ts --run`

Expected: FAIL because the queue does not exist and the current controller increments/reduces before persistence.

- [ ] **Step 3: Implement acknowledgement-gated queue**

Create:

```ts
export type QueueState = "open" | "recovering" | "terminal";
type Unsequenced<T> = T extends { sequence: number } ? Omit<T, "sequence"> : never;
export type UnsequencedRehearsalEvent = Unsequenced<PersistedRehearsalEvent>;

export class RehearsalCommandQueue {
  enqueue(command: UnsequencedRehearsalEvent): Promise<PersistedRehearsalEvent>;
  installSafetyFence(kind: "pause" | "stop" | "unmount" | "disconnect" | "interruption"): void;
  rehydrate(input: { state: RehearsalState; lastSequence: number }): void;
  close(): void;
}
```

Assign `lastAcknowledgedSequence + 1` only when a command reaches the head. Reduce and run effects only after successful acknowledgement. On conflict/nonretryable/exhausted retry, keep the local fence, reject queued commands, and require rehydration.

- [ ] **Step 4: Write failing Pause/Stop/unmount/late-event tests**

Prove immediately, before deferred persistence resolves:

```ts
const pause = controller.pause();
expect(actor.pauseCapture).toHaveBeenCalled();
expect(rolePool.cancelActive).toHaveBeenCalled();
lateSpeechFinished();
expect(controller.state.cursorElementId).toBe(interruptedElement);

const stop = controller.stop();
expect(micTracks.every((track) => track.stopped)).toBe(true);
expect(rolePool.close).toHaveBeenCalled();
intentionalPeerClose();
expect(resumeTransport).not.toHaveBeenCalled();
```

Unmount must unsubscribe and close media without persisting a synthetic `stopped` event. Pause persistence failure must remain fenced and enter recovery.

- [ ] **Step 5: Add explicit interruption controls and status-aware reduction**

Extend the event union with:

```ts
| Sequenced<{ type: "continue_after_interruption"; elementId: string }>
| Sequenced<{ type: "restart_line"; elementId: string }>
| Sequenced<{ type: "manual_actor_line_completed"; elementId: string; endedAtMs: number }>
```

`interrupted` moves to `await_interruption_choice` without advancing. Continue resumes after the interrupted AI element; Restart Line requests the same element again. Late actor/AI completion is ignored for cursor advancement while locally paused, terminal, recovering, or awaiting choice.

- [ ] **Step 6: Compose the production sessions in `RehearsalShell`**

Remove the production reliance on the combined `BrowserWebRtcTransport`. Inject/build one `ActorInputSession`, one `RoleVoiceSessionPool`, one queue, and one transport manager. Route every durable UI/provider event through the queue; keep only partial transcript preview and connection labels outside it.

- [ ] **Step 7: Run focused GREEN gates**

Run: `pnpm vitest apps/web/lib/rehearsal/command-queue.test.ts apps/web/components/rehearsal/rehearsal-shell.test.tsx packages/domain/src/rehearsal/controller.test.ts packages/domain/src/rehearsal/reducer.test.ts --run --testTimeout=30000 --hookTimeout=30000`

Run: `pnpm typecheck && pnpm eslint apps/web/lib/rehearsal apps/web/components/rehearsal packages/domain/src/rehearsal`

Expected: all pass; mutation check that restores pre-ack reduction must fail the FIFO test.

- [ ] **Step 8: Review, commit, and persist checkpoint 3**

Review ordering, local safety timing, listener cleanup, late-event suppression, explicit interruption choice, and no reconnect after intentional close.

Commit: `git commit -m "feat: serialize rehearsal commands and media lifecycle"`

Upload and verify before Task 4.

---

### Task 4: Locked Server Transitions, Reconnect, and Honest Fallback

**Files:**
- Create: `packages/domain/src/rehearsal/transitions.ts`
- Create: `packages/domain/src/rehearsal/transitions.test.ts`
- Modify: `packages/db/src/repositories/rehearsal.ts`
- Modify: `packages/db/src/repositories/rehearsal.integration.test.ts`
- Modify: `apps/web/app/api/rehearsals/[sessionId]/events/handler.ts`
- Modify: `apps/web/app/api/rehearsals/[sessionId]/events/route.test.ts`
- Modify: `apps/web/app/api/rehearsals/[sessionId]/resume/handler.ts`
- Modify: `apps/web/app/api/rehearsals/[sessionId]/resume/handler.test.ts`
- Modify: `apps/web/lib/realtime/reconnect.ts`
- Modify: `apps/web/lib/realtime/reconnect.test.ts`
- Modify: `apps/web/lib/realtime/fallback-player.ts`
- Modify: `apps/web/components/rehearsal/connection-recovery.tsx`
- Modify: `apps/web/components/rehearsal/rehearsal-shell.test.tsx`

**Interfaces:**
- Consumes: durable events and queue recovery barrier from Task 3; fallback capabilities from Task 2.
- Produces: one shared legal-transition function, terminal server enforcement, and `FallbackReadiness` used by the UI/E2E gate.

- [ ] **Step 1: Write failing legal-transition matrix tests**

Build a table covering every status/event pair and assert especially:

```ts
expect(validateTransition("stopped", resumed)).toEqual({ legal: false, code: "TERMINAL_SESSION" });
expect(validateTransition("stopped", identicalStoppedRetry)).toEqual({ legal: true, idempotent: true });
expect(validateTransition("paused", aiSpeechFinished)).toEqual({ legal: false, code: "PAUSED_SESSION" });
```

Repository integration tests must race concurrent appends under a session row lock and prove contiguous sequence, identical retry idempotency, nonidentical duplicate conflict, and zero mutation after Stop.

- [ ] **Step 2: Run transition tests and verify RED**

Run: `pnpm vitest packages/domain/src/rehearsal/transitions.test.ts packages/db/src/repositories/rehearsal.integration.test.ts 'apps/web/app/api/rehearsals/[sessionId]/events/route.test.ts' --run --hookTimeout=30000`

Expected: FAIL because current persistence checks sequence but does not enforce the complete terminal state model.

- [ ] **Step 3: Enforce transitions while holding the session row lock**

`appendEvent()` must select the owner/session row `FOR UPDATE`, compare the exact last acknowledged event for idempotency, call `validateTransition`, append only the exact next sequence, and update session status atomically. Map illegal transitions to a generic 409 body without resource or state details.

Resume/grant issuance must recheck active owner and nonterminal session after provider issuance and before returning the secret; if deletion or Stop wins, discard the grant and return nonleaking 404/409.

- [ ] **Step 4: Write failing disconnect/fallback readiness tests**

Prove disconnect immediately pauses capture/advancement, attempts delays `[250, 1000, 3000]`, rehydrates before enabling capture, and starts fallback at the first unacknowledged element. Add readiness cases:

```ts
expect(readiness({ tts: true, realtimeTranscript: false, browserRecognition: false }))
  .toEqual({ aiSpeech: "configured_tts", actorProgress: "manual", canContinue: true });
expect(ui.getByRole("button", { name: "Line complete" })).toBeVisible();
```

- [ ] **Step 5: Implement explicit readiness and manual progress**

Define:

```ts
export type FallbackReadiness = {
  aiSpeech: "configured_tts" | "browser_distinct_voices" | "unavailable";
  actorProgress: "realtime_transcription" | "browser_recognition" | "manual";
  canContinue: boolean;
};
```

Display Continue with Scripted Voices only when AI speech is actually ready. If actor recognition is unavailable, show `Line complete`; its click queues `manual_actor_line_completed`. Never advertise listening when only manual mode exists. Preserve acknowledged element IDs so fallback cannot duplicate dialogue.

- [ ] **Step 6: Run focused GREEN gates**

Run: `pnpm vitest packages/domain/src/rehearsal/transitions.test.ts packages/db/src/repositories/rehearsal.integration.test.ts 'apps/web/app/api/rehearsals/[sessionId]/events/route.test.ts' 'apps/web/app/api/rehearsals/[sessionId]/resume/handler.test.ts' apps/web/lib/realtime/reconnect.test.ts apps/web/lib/realtime/fallback-player.test.ts apps/web/components/rehearsal/rehearsal-shell.test.tsx --run --testTimeout=30000 --hookTimeout=30000`

Run: `pnpm typecheck && pnpm eslint packages/domain/src/rehearsal packages/db/src/repositories/rehearsal.ts apps/web/app/api/rehearsals apps/web/lib/realtime apps/web/components/rehearsal`

- [ ] **Step 7: Review, commit, and persist checkpoint 4**

Review row-lock boundaries, idempotency, stopped-session grants, disconnect fencing, fallback honesty, and duplicate-line prevention.

Commit: `git commit -m "feat: enforce rehearsal transitions and fallback readiness"`

Upload and verify before Task 5.

---

### Task 5: Owner-Scoped Rehearsal-Linked Coaching Evidence

**Files:**
- Create: `packages/db/migrations/0020_rehearsal_linked_coaching.sql`
- Create: `packages/db/migrations/down/0020_rehearsal_linked_coaching.sql`
- Modify: `packages/db/src/migrations.ts`
- Modify: `packages/db/src/migrations.integration.test.ts`
- Modify: `packages/db/src/schema.ts`
- Modify: `apps/web/app/api/plays/[playId]/takes/handler.ts`
- Modify: `apps/web/app/api/plays/[playId]/takes/route.test.ts`
- Modify: `apps/web/components/rehearsal/rehearsal-shell.tsx`
- Create: `packages/domain/src/rehearsal/cue-response.ts`
- Create: `packages/domain/src/rehearsal/cue-response.test.ts`
- Modify: `apps/worker/src/jobs/measure-take.ts`
- Modify: `apps/worker/src/jobs/measure-take.test.ts`
- Modify: `apps/worker/src/jobs/synthesize-coaching.ts`
- Modify: `apps/worker/src/jobs/synthesize-coaching.test.ts`
- Modify: `tests/security/private-resource-fixture.ts`
- Modify: `tests/security/private-resource-matrix.test.ts`

**Interfaces:**
- Consumes: acknowledged rehearsal events and terminal session data from Tasks 3–4.
- Produces: nullable take `rehearsalSessionId`, versioned `CueResponseEvidence`, and deterministic cue-responsiveness rating.

- [ ] **Step 1: Write failing migration and ownership tests**

Migration tests must prove nullable legacy compatibility, forward/down migration, and an owner-scoped FK from takes to rehearsal sessions. Route tests must reject cross-owner, play, Play Model version, scene, or actor-role mismatch while still allowing ordinary non-rehearsal takes.

Use this schema shape:

```sql
ALTER TABLE takes ADD COLUMN rehearsal_session_id uuid NULL;
ALTER TABLE takes ADD CONSTRAINT takes_rehearsal_owner_fk
  FOREIGN KEY (rehearsal_session_id, owner_user_id)
  REFERENCES rehearsal_sessions(id, owner_user_id);
```

Add a timing evidence table keyed by owner/take/measurement version with source cue/actor event IDs, delay, confidence, and a shared clock identifier; its FKs must prevent evidence crossing owner, take, or rehearsal session.

- [ ] **Step 2: Run migration/route tests and verify RED**

Run: `pnpm vitest packages/db/src/migrations.integration.test.ts 'apps/web/app/api/plays/[playId]/takes/route.test.ts' --run --hookTimeout=30000`

Expected: FAIL because the linkage columns and validation do not exist.

- [ ] **Step 3: Implement the forward-only link and upload validation**

Include `rehearsalSessionId` in the multipart take request only when recording in rehearsal. Under the active-owner transaction, verify same owner, play, Play Model ID/version, scene, and actor role before inserting the take. Do not weaken the existing pre-write cleanup reservation or deletion fencing.

- [ ] **Step 4: Write failing deterministic cue-response tests**

Cover qualifying, missing, low-confidence, wrong-clock, wrong-element, and reversed ordering:

```ts
expect(measureCueResponse(validTimeline)).toEqual({
  version: "cue-response-v1",
  cueEventId: "cue-finished",
  actorEventId: "actor-finished",
  delayMs: 740,
  confidence: "high",
  score: 85,
});
expect(measureCueResponse(missingCue)).toMatchObject({ score: null, confidence: "low" });
```

Define the complete versioned score mapping in `cue-response.ts`; do not delegate scoring to the synthesis model.

For `cue-response-v1`, use literal thresholds: delay `<= 500 ms` → 100, `501–1000 ms` → 85, `1001–1500 ms` → 70, `1501–2500 ms` → 55, and `> 2500 ms` → 40. Evidence is `high` confidence when both acknowledged events carry provider-derived timestamps on the same rehearsal clock, `medium` when both carry server-receipt timestamps on that clock, and `low`/null score for mixed clocks, missing timestamps, reversed order, or unmatched cue/actor elements.

- [ ] **Step 5: Load and publish owner-scoped timing evidence**

During measurement, load only acknowledged AI completion followed by the corresponding acknowledged actor completion from the linked, matching rehearsal. Persist source IDs, clock, delay, confidence, and deterministic score. Extend the review/synthesis chain so `synthesize-coaching` replaces the default null cue rating only with medium/high persisted evidence; otherwise retain `{ score: null, confidence: "low" }`.

- [ ] **Step 6: Extend behavioral authorization coverage**

Add rehearsal-linked take and timing evidence to the real-handler cross-owner matrix. Prove another owner receives nonleaking not-found behavior and cannot infer whether the session/evidence exists.

- [ ] **Step 7: Run focused GREEN gates**

Run: `pnpm vitest packages/db/src/migrations.integration.test.ts 'apps/web/app/api/plays/[playId]/takes/route.test.ts' packages/domain/src/rehearsal/cue-response.test.ts apps/worker/src/jobs/measure-take.test.ts apps/worker/src/jobs/synthesize-coaching.test.ts tests/security/private-resource-matrix.test.ts --run --testTimeout=30000 --hookTimeout=30000`

Run: `pnpm typecheck && pnpm eslint packages/db 'apps/web/app/api/plays/[playId]/takes' packages/domain/src/rehearsal apps/worker/src/jobs tests/security`

Run: `git diff --check`

- [ ] **Step 8: Review, commit, and persist checkpoint 5**

Review migration reversibility, owner-chain FKs, deletion behavior, clock validity, deterministic scoring, and the no-invention synthesis boundary.

Commit: `git commit -m "feat: link rehearsal timing to coaching evidence"`

Upload and verify before Task 6.

---

### Task 6: Production-Shaped E2E, Whole-Branch Verification, Review, and Integration

**Files:**
- Create: `tests/e2e/plan-3-production-rehearsal.spec.ts`
- Modify: `apps/web/lib/e2e/composition.ts`
- Modify: `scripts/e2e-server.ts`
- Modify: `tests/e2e/plan-3-rehearsal-flow.spec.ts`
- Modify: `tests/e2e/plan-3-reconnect-fallback.spec.ts`
- Modify: `docs/runbooks/provider-failure.md`
- Modify: `.superpowers/sdd/2026-08-01-drama-practice-app-plan-3-realtime-rehearsal/task-6-report.md`

**Interfaces:**
- Consumes: all production components and persisted contracts from Tasks 1–5.
- Produces: merge-readiness evidence and an accurate remaining-external-gates record.

- [ ] **Step 1: Write a production-shaped browser test**

The fake boundary may replace provider/network primitives, but the page must instantiate the real actor session, role pool, remote audio sink, command queue, reducer, API persistence, and fallback logic. Assert microphone is untouched before Start, then observe remote track attachment/play, final actor transcript, stable role labels, four-role cap plus fifth-role TTS, Pause/Resume, interruption Continue and Restart Line, manual fallback, Stop, reload recovery, and coaching linkage.

- [ ] **Step 2: Run E2E and verify RED before fixture completion**

Run: `pnpm playwright test tests/e2e/plan-3-production-rehearsal.spec.ts --config=playwright.config.ts`

Expected: FAIL until the production-shaped fake provider composition is wired; a direct controller bypass is not an acceptable fix.

- [ ] **Step 3: Implement the minimal provider-boundary fixture**

Expose deterministic fake peer connections/data channels/media tracks through browser initialization, and seed only server/provider responses. Do not call controller methods from the test to simulate transcript/audio behavior; send the same provider events the production adapters parse.

- [ ] **Step 4: Run the complete current-head verification matrix**

Run in this order, recording exact counts and commit SHA:

```bash
pnpm typecheck
pnpm vitest --run --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000
pnpm playwright test --config=playwright.config.ts
pnpm lint
pnpm --filter @drama/web exec next build
pnpm db:migrate:test
pnpm vitest tests/security/private-resource-matrix.test.ts --run --hookTimeout=30000
pnpm vitest apps/web/app/api/account/delete/route.test.ts 'apps/web/app/api/plays/[playId]/takes/route.test.ts' packages/storage/src/storage.test.ts --run --testTimeout=30000 --hookTimeout=30000
git diff --check
```

Expected: every applicable local gate passes. The provider-evidence-only Playwright case may skip only when real nonproduction credentials/evidence are absent; no other regression may be waived.

- [ ] **Step 5: Run mutation checks for load-bearing proofs**

Temporarily and one at a time demonstrate tests fail when: `ontrack` attachment is removed; input transcription config is removed; role cap becomes five; queue reduces before acknowledgement; Stop permits resume/grant; cross-owner rehearsal linkage is accepted; cue response is synthesized without timing. Restore each mutation and rerun the affected test.

- [ ] **Step 6: Conduct scoped security and whole-branch reviews**

Review the final task range first for credential/media lifecycle, deletion races, transition locks, owner-scoped timing, and redaction. Then review the complete Plan 3 diff against `main` for spec coverage. Resolve every Critical/Important finding test-first; checkpoint each approved fix to GitHub before rerunning full gates.

- [ ] **Step 7: Update operational and recovery evidence**

Keep the direct-browser provider-termination limitation explicit. Record the exact green commands/counts, remote commit, skipped external provider evidence, and pending ten-actor study. The report must contain no credentials, prompts, transcripts, provider bodies, or sensitive environment details.

- [ ] **Step 8: Commit and persist final Plan 3 branch**

Commit: `git commit -m "test: verify production rehearsal completion"`

Upload the final exact tree to `agent/plan-3-realtime-20260822`; verify branch head and every changed blob/tree hash. Confirm it is ahead of and not behind `main` before integration.

- [ ] **Step 9: Merge only after applicable gates pass**

Fast-forward or merge the isolated Plan 3 branch into `main` according to repository policy, rerun the required post-merge smoke/typecheck gate, push `main`, and verify the remote main tree equals the tested local tree. Do not label provider thresholds or ten-actor usefulness as complete; retain them as private-beta release gates.

## Completion Definition

Plan 3 code is complete only when Tasks 1–6 are implemented, individually reviewed, persisted, and all applicable local regressions/security/build/migration gates are green. Provider-backed measurements and the ten invited-actor usefulness study remain separate private-beta release evidence and are never prerequisites for truthfully merging code unless repository policy is explicitly changed.
