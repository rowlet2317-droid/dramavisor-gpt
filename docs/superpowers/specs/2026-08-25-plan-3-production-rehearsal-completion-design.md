# Plan 3 Production Rehearsal Completion Design

Date: 2026-08-25  
Status: Proposed design awaiting user review

## 1. Purpose

Complete the production path promised by Plan 3. The current branch has strong deterministic rehearsal, authorization, deletion, observability, and acceptance-harness foundations, but its browser composition does not yet connect those foundations into an audible, transcribed, multi-role rehearsal. This correction makes the normal application path—not only fake transports and E2E shortcuts—deliver that behavior.

The release remains an invite-only, English-language, voice-only private beta. Camera analysis, custom voice enrollment, public signup, and mobile-native clients remain out of scope.

## 2. Required outcomes

An actor can start a scene rehearsal and receive all of the following behavior:

1. Microphone capture begins only after the actor presses Start.
2. Actor speech produces partial and final transcripts used by the deterministic scene controller.
3. AI roles speak exact script text through audible remote media with stable, distinct built-in voices.
4. At most four AI roles use concurrent Realtime output sessions; additional roles use scripted TTS.
5. Cue, Pause, Resume, Restart Beat, Continue after interruption, Restart Line, and Stop remain available.
6. Pause and Stop are authoritative across local state, microphone tracks, AI speech, provider events, persistence, reconnect, and unmount.
7. Persisted rehearsal events remain contiguous and authoritative even when provider and UI events arrive concurrently or a request fails.
8. A rehearsal take may carry its owner-scoped rehearsal timeline into coaching so cue responsiveness is scored only when qualifying timing evidence exists.
9. Connection failure produces an honest fallback choice; the UI never reports fallback readiness when neither automatic nor manual actor-line advancement is available.

## 3. Session architecture

### 3.1 Actor input session

One `ActorInputSession` owns the microphone, voice-activity events, and actor transcription. It uses a short-lived browser credential whose Realtime session configuration explicitly enables input transcription and turn detection. It does not generate partner dialogue.

The session exposes a provider-independent interface:

```ts
interface ActorInputSession {
  connectAfterUserGesture(): Promise<void>;
  pauseCapture(): void;
  resumeCapture(): void;
  onEvent(listener: (event: ActorInputEvent) => void): () => void;
  close(reason: "stop" | "unmount" | "recovery"): Promise<void>;
}
```

Partial transcript deltas are accumulated by provider item/content identity and remain nonpersistent UI preview. Final transcripts and speech-start events enter the serialized rehearsal command queue.

### 3.2 AI role sessions

`RoleVoiceSessionPool` owns up to four lazily-created Realtime output sessions. A role session has one persisted built-in voice fixed before its first audio response. It receives no actor microphone track. Each request contains exact script text and a bounded performance direction derived from pinned scene and role analysis; the model is never asked to invent or paraphrase dialogue.

Each peer connection installs an `ontrack` handler before negotiation. The remote stream is attached to a managed autoplay audio element or equivalent injectable audio sink. Speech completion is acknowledged from provider lifecycle events, not inferred from raw audio-delta arrival.

```ts
interface RoleVoiceSession {
  speak(input: ExactRoleLine): Promise<void>;
  cancelSpeech(): Promise<void>;
  close(): Promise<void>;
}
```

The four-role cap applies only to AI output sessions. The separate actor-input session does not consume an AI role slot.

### 3.3 Overflow and scripted TTS

Voice assignment remains deterministic and persisted. The four roles with the most dialogue in the selected scene receive Realtime sessions. Additional roles use the configured scripted TTS adapter and the same exact-text/performance-direction contract. Production fallback does not silently map every role to the first browser-installed voice.

Browser speech synthesis may be used only when an explicit capability check proves that the persisted assignments map to suitable distinct local voices. Otherwise the configured TTS adapter is required.

## 4. Rehearsal command and persistence model

All durable UI commands and provider events enter one FIFO `RehearsalCommandQueue`. Only one command may be awaiting server acknowledgement at a time.

For each command:

1. Read the last server-acknowledged sequence and current reducer state.
2. Derive the proposed event without mutating authoritative local state.
3. POST that event with the exact next sequence.
4. After server acknowledgement, reduce it into local state and dispatch resulting audio/controller effects.
5. Begin the next queued command.

Pause, Stop, unmount, and interruption cancellation may apply an immediate local safety fence before acknowledgement so microphone or AI audio cannot leak during network latency. Those fences do not advance durable scene state, sequence, or cursor; the acknowledged event remains authoritative.

Identical retries remain idempotent. A sequence conflict, nonretryable response, or exhausted bounded retry stops the queue and enters recovery. Recovery rehydrates server events and Play Model version before accepting more commands. Local sequence never advances past the last acknowledged event.

Partial transcript preview and connection indicators may update optimistically because they are nondurable and cannot advance scene position.

## 5. Lifecycle and interruption semantics

### 5.1 Pause

Pause immediately installs a local fence, disables microphone transmission, cancels active role speech, and blocks controller advancement before the `paused` request waits for acknowledgement. The acknowledged event makes that state durable. Actor-final, AI-finished, and disconnect events received after the local pause boundary may update diagnostics but cannot return the rehearsal to `active` or move the cursor. If persistence fails, the rehearsal remains locally fenced and enters recovery rather than silently resuming.

Resume rehydrates if needed, obtains fresh credentials for expired sessions, acknowledges `resumed`, then reenables capture.

### 5.2 Interruption

Actor speech-start while an AI line is active immediately cancels that role response and enqueues `interrupted`. After acknowledgement, the controller remains on the interrupted element in `await_interruption_choice`. The UI presents exactly two progression actions: Continue and Restart Line. Neither choice is implicit.

### 5.3 Stop and unmount

Stop immediately sets a local terminal fence, disables and stops every microphone track, cancels speech, closes every peer/data channel, and prevents intentional `closed` events from starting reconnect. It then persists `stopped`; a persistence failure leaves the client terminally fenced and offers recovery/end-state reconciliation rather than reopening media.

Component cleanup applies the same local resource fence and closes all transports even when navigation occurs before a server event can be written. It does not silently mark the persisted rehearsal stopped; a later visit may explicitly recover the server session. No listener survives unmount.

### 5.4 Server-side transitions

The rehearsal repository validates legal state transitions while holding the session row lock. A stopped session accepts only an identical retry of its terminal event. It cannot be restarted, resumed, moved to fallback, or issued another provider grant. Illegal transitions return a nonleaking conflict response without changing sequence or state.

## 6. Recovery and fallback

Unintentional disconnect pauses capture and scene advancement before reconnect begins. Reconnect remains bounded at 250 ms, 1 second, and 3 seconds and uses fresh credentials. Each success rehydrates acknowledged history before resuming.

After the third failure, the actor may Retry, Continue with Scripted Voices, or End and Save. Scripted fallback is marked ready only when:

- AI speech can be produced by the configured TTS path; and
- actor progress can be detected by the actor-input transcription session or supported browser speech recognition.

If neither transcription path is available, fallback exposes an explicit manual “Line complete” control rather than pretending to listen. The controller remains authoritative and the manual action is persisted. Fallback starts at the current uncompleted element and never replays acknowledged lines.

## 7. Rehearsal-linked coaching

A complete take recorded during rehearsal stores a nullable, owner-scoped `rehearsalSessionId`. The referenced rehearsal must match the same owner, play, pinned Play Model version, scene, and actor role. Non-rehearsal takes remain unchanged.

The coaching evidence loader may derive cue-response measurements only from an acknowledged AI cue/speech completion followed by the corresponding acknowledged actor-line completion in the linked timeline. It records the measurement version, source event IDs, delay, and confidence. A numeric cue-responsiveness rating is allowed only when both timestamps exist, share a valid rehearsal clock, and meet medium-or-higher confidence. Otherwise the existing null/low-confidence result is retained.

The score mapping remains deterministic and versioned in the measurement layer; the synthesis model may explain the measurement but may not invent or override it.

## 8. Provider and security boundaries

- Permanent provider credentials remain server-side.
- Browser client secrets remain short-lived and owner/play/scene/role scoped.
- Input transcription, role voice, and output modality are configured server-side before a session begins.
- Direct-browser WebRTC still cannot guarantee provider-side termination of a session that was already established. Internal grants, persisted sessions, and further issuance remain fenced on account deletion; the runbook must continue to state this residual limitation accurately.
- Operational events continue through the allowlisted redaction sink. Production startup requires a non-default `OPERATIONAL_EVENT_SALT`; tests and local development use an explicit test value.
- No script text, transcript text, audio, prompt, credential, or provider body enters operational logs.

## 9. Component changes

The implementation should preserve current domain and security boundaries while adding these integrations:

- Extend the Realtime credential adapter with explicit actor-input and role-output session configurations.
- Split the current browser session wrapper into actor-input and role-output responsibilities over a shared WebRTC base.
- Replace the unused test-only voice pool path with `RoleVoiceSessionPool` in `RehearsalShell` composition.
- Add a managed remote-audio sink and lifecycle-safe transport manager.
- Add `RehearsalCommandQueue` and route every durable UI/provider command through it.
- Make reducer advancement status-aware and enforce the same legal transition model in the repository.
- Add Continue and Restart Line controls for interruption.
- Add a nullable rehearsal-session reference and timing evidence to the take/coaching chain through a forward-only migration.
- Replace silent scripted-fallback capability failures with explicit readiness and manual advancement.

## 10. Testing strategy

### 10.1 Provider-contract tests

An injectable fake `RTCPeerConnection` and media environment must prove that:

- remote `ontrack` media is attached and played;
- actor input transcription is enabled in the issued session configuration;
- microphone access occurs only after Start;
- role voice is fixed before first speech;
- four distinct roles use distinct stable sessions and a fifth role uses TTS;
- exact script text and bounded performance direction reach the correct role;
- interruption sends cancellation;
- Pause, Stop, and unmount stop or disable every expected track/channel.

### 10.2 Ordering and lifecycle tests

Tests intentionally delay and reorder event responses. They prove that N+1 is not sent before N is acknowledged, a failed event cannot advance local state, conflict triggers rehydration, Pause cannot be undone by late completion, intentional close cannot reconnect, and stopped sessions reject every nonidentical later event.

### 10.3 Coaching and fallback tests

Tests cover linked rehearsal timing with a qualifying cue-responsiveness score, missing/low-confidence timing with a null score, cross-owner and mismatched-scene rejection, TTS overflow, recognition unavailable with manual advancement, and no duplicate dialogue after fallback.

### 10.4 End-to-end and acceptance gates

The normal Playwright rehearsal flow must use the production-shaped browser composition with fake provider boundaries; it may not bypass the voice/session pool. It must observe remote audio attachment, final actor transcript, stable role labels, Pause/Resume, interruption choice, fallback, Stop, reload, and coaching linkage.

After implementation, rerun typecheck, full serial Vitest, full Playwright, full ESLint, production Next build, migration integration, authorization matrix, and deletion/security focused tests. Provider-backed latency/content thresholds and ten-actor usefulness ratings remain external private-beta release gates and must not be fabricated.

## 11. Delivery sequence

Implementation will be divided into recoverable, independently reviewed checkpoints:

1. Provider session configuration and production-shaped WebRTC audio/transcription contracts.
2. AI role-session pool, stable voices, overflow TTS, and interruption.
3. Serialized command queue and lifecycle-safe controller/UI composition.
4. Server transition enforcement, reconnect, and fallback readiness.
5. Rehearsal-linked coaching evidence and migration.
6. Whole-branch regression, security review, persistence, and integration.

Each checkpoint is committed locally only after its focused tests and typecheck pass, then uploaded to the existing Plan 3 GitHub branch before the next checkpoint begins.

## 12. Non-goals

- Replacing direct-browser WebRTC with a server-mediated media proxy.
- More than four concurrent Realtime AI role sessions.
- Custom voices, voice cloning, or cast voice enrollment.
- Camera or body-movement analysis.
- Mobile-native implementation.
- Provider acceptance claims without real nonproduction credentials and measurements.
- Actor usefulness claims without ten invited actor sessions.
