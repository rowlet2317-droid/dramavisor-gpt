# Drama Practice App Plan 3: Realtime Rehearsal and Beta Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add low-latency multi-character AI scene rehearsal, cue and restart controls, graceful fallback, and the security/performance gates required for the invite-only private beta.

**Architecture:** Keep scene position in a deterministic rehearsal controller while realtime sessions handle listening and expressive speech. Use one voice-fixed session per active AI role, cap concurrent sessions, and route minor roles through scripted TTS fallback. Browser connections use short-lived credentials; every session event is persisted through an owner-scoped backend channel.

**Tech Stack:** Plans 1–2 stack plus `@openai/agents` 0.14+; WebRTC; `gpt-realtime-2.1`; `gpt-4o-mini-tts` fallback; Playwright browser audio fixtures; Vitest fake realtime transport.

## Global Constraints

- The rehearsal controller, not a generative model, is authoritative for current scene position and exact scripted text.
- Each AI role keeps a stable voice within a rehearsal session.
- Maximum four concurrent realtime role sessions per actor; overflow roles use scripted TTS fallback.
- Actor microphone audio is never sent before explicit Start Rehearsal action.
- Permanent provider credentials remain server-side; browser credentials expire within ten minutes and are scoped to the current user.
- A failed realtime connection must preserve session history and offer scripted playback fallback.
- Cue, restart, pause, resume, and stop are always available.
- Complete-take recording and post-take coaching from Plan 2 remain available inside rehearsal.
- No custom voice enrollment or cloning in this plan.

---

## File structure added by this plan

```text
packages/domain/src/rehearsal/        Scene state machine and events
packages/ai/src/realtime/             Credential, transport, and fake ports
packages/ai/src/character-voice/      Voice assignment and fallback speech
apps/web/lib/realtime/                Browser session and audio scheduling
apps/web/components/rehearsal/        Rehearsal UI and controls
apps/web/app/api/realtime/             Short-lived credentials and events
tests/e2e/                              Rehearsal, reconnect, and beta gates
```

### Task 1: Realtime credential boundary and transport contract

**Files:**
- Create: `packages/ai/src/realtime/port.ts`
- Create: `packages/ai/src/realtime/openai-credentials.ts`
- Create: `packages/ai/src/realtime/fake-transport.ts`
- Create: `apps/web/app/api/realtime/session/route.ts`
- Create: `apps/web/lib/realtime/session.ts`
- Create: `apps/web/lib/realtime/session.test.ts`
- Create: `apps/web/app/api/realtime/session/route.test.ts`
- Create: `scripts/smoke-realtime.ts`

**Interfaces:**
- Consumes: authenticated user, play/scene/role authorization, configured realtime model.
- Produces: `RealtimeSessionGrant`, `RealtimeTransport`, and browser `ActorRealtimeSession`.

- [ ] **Step 1: Write failing credential-scope tests**

```ts
export type RealtimeSessionGrant = {
  clientSecret: string;
  expiresAt: string;
  model: string;
  rehearsalSessionId: string;
};

export type RealtimeEvent =
  | { type: "actor_transcript_partial"; text: string }
  | { type: "actor_transcript_final"; text: string; endedAtMs: number }
  | { type: "speech_started"; characterId: string; elementId: string; startedAtMs: number }
  | { type: "speech_finished"; characterId: string; elementId: string; endedAtMs: number }
  | { type: "interrupted"; atMs: number }
  | { type: "disconnected"; reason: string };

it("refuses a grant for another actor's play", async () => {
  const response = await requestGrant({ as: "user_b", playId: ownedByUserA.id, sceneId, roleId });
  expect(response.status).toBe(404);
});
```

- [ ] **Step 2: Run grant tests and confirm failure**

Run: `pnpm vitest apps/web/app/api/realtime/session/route.test.ts --run`  
Expected: FAIL because the endpoint and credential adapter are missing.

- [ ] **Step 3: Define transport and browser session interfaces**

```ts
export interface RealtimeTransport {
  connect(grant: RealtimeSessionGrant): Promise<void>;
  sendAudio(chunk: ArrayBuffer): void;
  requestSpeech(input: { exactText: string; performanceDirection: string }): Promise<void>;
  onEvent(listener: (event: RealtimeEvent) => void): () => void;
  close(): Promise<void>;
}
```

The fake transport records requested exact text and emits scripted transcript, speech-started, speech-finished, interruption, and disconnected events.

- [ ] **Step 4: Implement short-lived credential issuance**

`POST /api/realtime/session` accepts `{ playId, sceneId, actorRoleId }`, calls `requireUser`, verifies ownership and membership, creates a `rehearsal_sessions` record, and requests a provider client secret for `gpt-realtime-2.1`. Return only the short-lived secret, model, expiry, and internal rehearsal session ID. Reject expiry over ten minutes.

- [ ] **Step 5: Implement browser WebRTC session wrapper**

Use `RealtimeSession` from `@openai/agents/realtime`. The wrapper requests microphone permission only from `connectAfterUserGesture()`, registers cleanup for tracks and peer connection, and prevents reconnect from reusing an expired grant.

- [ ] **Step 6: Run credential and transport verification**

Run: `pnpm vitest packages/ai/src/realtime apps/web/lib/realtime apps/web/app/api/realtime --run`  
Expected: expiration, ownership, explicit gesture, event subscription, and cleanup tests pass.

- [ ] **Step 7: Commit the realtime boundary**

```bash
git add packages/ai/src/realtime apps/web/app/api/realtime apps/web/lib/realtime scripts/smoke-realtime.ts
git commit -m "feat: establish secure realtime rehearsal sessions"
```

### Task 2: Deterministic scene-position controller

**Files:**
- Create: `packages/domain/src/rehearsal/types.ts`
- Create: `packages/domain/src/rehearsal/controller.ts`
- Create: `packages/domain/src/rehearsal/reducer.ts`
- Create: `packages/domain/src/rehearsal/controller.test.ts`
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0003_rehearsal.sql`
- Create: `packages/db/src/repositories/rehearsal.ts`

**Interfaces:**
- Consumes: approved Play Model, actor role, final/partial transcripts, user controls.
- Produces: `RehearsalState`, `RehearsalEvent`, and `RehearsalAction`.

- [ ] **Step 1: Write failing state-machine tests**

```ts
it("advances to the next AI line after the actor completes a matched line", () => {
  const next = reduceRehearsal(initialState, { type: "actor_line_final", text: "We begin.", endedAtMs: 1200 });
  expect(next.pendingAction).toEqual({ type: "speak", elementId: "line_0002", characterId: "char_bea" });
});

it("returns a cue without advancing scene position", () => {
  const next = reduceRehearsal(initialState, { type: "cue_requested" });
  expect(next.pendingAction).toEqual({ type: "show_cue", elementId: "line_0001" });
  expect(next.cursorElementId).toBe("line_0001");
});
```

- [ ] **Step 2: Run controller tests and confirm failure**

Run: `pnpm vitest packages/domain/src/rehearsal/controller.test.ts --run`  
Expected: FAIL because controller contracts are absent.

- [ ] **Step 3: Implement rehearsal events and reducer**

Support events: `started`, `actor_partial`, `actor_line_final`, `ai_speech_started`, `ai_speech_finished`, `cue_requested`, `restart_requested`, `paused`, `resumed`, `interrupted`, `connection_lost`, `fallback_selected`, and `stopped`. Reducer output is pure and serializable. Persist event sequence number and reject out-of-order duplicate events.

- [ ] **Step 4: Reuse monotonic alignment for scene recovery**

Match the actor’s final transcript against the current line plus the next three actor lines. Advance on similarity at least 0.65. If a later line scores at least 0.85 and all intervening actor lines score below 0.35, mark them omitted and recover to that later line. Otherwise pause at `needs_position_confirmation` and show the three candidate lines; never guess silently.

- [ ] **Step 5: Implement scoped rehearsal event repository**

Create `rehearsal_sessions`, `rehearsal_events`, and `character_voice_assignments`. All writes require user ownership and expected next sequence. Rehydration loads Play Model version plus ordered events and applies the pure reducer.

- [ ] **Step 6: Run controller and repository tests**

Run: `pnpm vitest packages/domain/src/rehearsal packages/db/src/repositories/rehearsal.integration.test.ts --run`  
Expected: normal advance, omission recovery, ambiguity, cue, restart, duplicate event, and cross-user tests pass.

- [ ] **Step 7: Commit scene control**

```bash
git add packages/domain/src/rehearsal packages/db
git commit -m "feat: add deterministic stage scene rehearsal controller"
```

### Task 3: Stable character voices and multi-role routing

**Files:**
- Create: `packages/domain/src/rehearsal/voice-assignment.ts`
- Create: `packages/ai/src/character-voice/port.ts`
- Create: `packages/ai/src/character-voice/realtime-role.ts`
- Create: `packages/ai/src/character-voice/tts-fallback.ts`
- Create: `packages/ai/src/character-voice/fake-voice.ts`
- Create: `apps/web/lib/realtime/voice-pool.ts`
- Test: `packages/domain/src/rehearsal/voice-assignment.test.ts`
- Test: `apps/web/lib/realtime/voice-pool.test.ts`

**Interfaces:**
- Consumes: characters active in a scene, voice preferences, scene analysis, and `RehearsalAction.type === "speak"`.
- Produces: stable `VoiceAssignment[]` and `CharacterVoice.speak`.

- [ ] **Step 1: Write failing stable-assignment tests**

```ts
it("keeps a character's voice stable after reconnect", () => {
  const first = assignVoices(sceneCharacters, [], supportedVoices);
  const second = assignVoices(sceneCharacters, first, supportedVoices);
  expect(second).toEqual(first);
});

it("routes the fifth simultaneous role to fallback", () => {
  const result = assignVoices(fiveCharacters, [], supportedVoices, { realtimeLimit: 4 });
  expect(result.filter((x) => x.engine === "tts")).toHaveLength(1);
});
```

- [ ] **Step 2: Run voice-assignment tests and confirm failure**

Run: `pnpm vitest packages/domain/src/rehearsal/voice-assignment.test.ts --run`  
Expected: FAIL because assignment logic is missing.

- [ ] **Step 3: Implement deterministic voice assignment**

Choose from supported built-in voices using a hash of `playId + characterId`, while maximizing distinct voices among characters sharing a scene. Persist assignments when rehearsal starts. Assign realtime to the four characters with the most dialogue in the selected scene and TTS fallback to remaining roles. User voice overrides are allowed only from the same supported list and apply at the next new rehearsal session.

- [ ] **Step 4: Implement character performance directions**

Create at most 300 characters of direction from the stored scene analysis: relationship, immediate objective, tactic, and specified interpretation. Never instruct the voice model to invent or paraphrase dialogue. `CharacterVoice.speak` receives exact script text and this direction:

```ts
export interface CharacterVoice {
  speak(input: { characterId: string; elementId: string; exactText: string; direction: string }): Promise<{ startedAtMs: number }>;
  stop(): Promise<void>;
}
```

- [ ] **Step 5: Implement voice pool lifecycle**

Open sessions lazily on the first upcoming line, keep at most four connected, and close all tracks on Stop. Queue speech by script ordinal. If the actor interrupts AI speech, stop playback, emit `interrupted`, and keep the cursor on the interrupted element until the actor selects Continue or Restart Line.

- [ ] **Step 6: Run voice routing tests**

Run: `pnpm vitest packages/domain/src/rehearsal/voice-assignment.test.ts packages/ai/src/character-voice apps/web/lib/realtime/voice-pool.test.ts --run`  
Expected: stable voice, four-session cap, fallback, exact text, interruption, and cleanup tests pass.

- [ ] **Step 7: Commit character voice routing**

```bash
git add packages/domain/src/rehearsal packages/ai/src/character-voice apps/web/lib/realtime/voice-pool.ts
git commit -m "feat: route stage roles through stable ai voices"
```

### Task 4: Rehearsal workspace and audio scheduling

**Files:**
- Create: `apps/web/app/plays/[playId]/scenes/[sceneId]/rehearse/page.tsx`
- Create: `apps/web/components/rehearsal/rehearsal-shell.tsx`
- Create: `apps/web/components/rehearsal/script-cursor.tsx`
- Create: `apps/web/components/rehearsal/rehearsal-controls.tsx`
- Create: `apps/web/components/rehearsal/position-confirmation.tsx`
- Create: `apps/web/lib/realtime/audio-scheduler.ts`
- Create: `apps/web/app/api/rehearsals/[sessionId]/events/route.ts`
- Test: `apps/web/components/rehearsal/rehearsal-shell.test.tsx`
- Test: `apps/web/lib/realtime/audio-scheduler.test.ts`
- Test: `tests/e2e/plan-3-rehearsal-flow.spec.ts`

**Interfaces:**
- Consumes: `RehearsalState`, voice pool, actor realtime transcript, persisted event endpoint.
- Produces: full rehearsal UI with Start, Pause, Cue, Restart Beat, Resume, and Stop.

- [ ] **Step 1: Write failing control and scheduling tests**

```tsx
it("does not request microphone permission before Start", async () => {
  render(<RehearsalShell scene={scene} transport={fakeTransport} />);
  expect(fakeTransport.connectCalls).toBe(0);
  await user.click(screen.getByRole("button", { name: "Start rehearsal" }));
  expect(fakeTransport.connectCalls).toBe(1);
});
```

Audio scheduling tests ensure lines play in ordinal order and no second voice starts before the preceding `speech_finished` event.

- [ ] **Step 2: Run workspace tests and confirm failure**

Run: `pnpm vitest apps/web/components/rehearsal apps/web/lib/realtime/audio-scheduler.test.ts --run`  
Expected: FAIL because the rehearsal UI and scheduler do not exist.

- [ ] **Step 3: Implement rehearsal interface**

Show current speaker and line, nearby context, elapsed time, connection state, and compact controls. Hide the actor’s full upcoming line by default in memorization mode; Cue reveals only the next line and logs `cue_requested`. Restart Beat selects from stored beat boundaries or the current scene start when no beat analysis exists.

- [ ] **Step 4: Wire transcript and voice events to the controller**

Partial transcripts update a nonpersistent preview. Final transcripts become persisted events and reducer inputs. Persist AI speech start/finish, user controls, connection changes, and fallback selection with monotonically increasing client sequence; retry event writes idempotently on network failure.

- [ ] **Step 5: Integrate complete-take coaching**

When “Record for coaching” is enabled before Start, capture the mixed rehearsal timeline plus the actor microphone track. Store the actor track as the coaching source and AI timing as cue events; cue responsiveness is scored only when both actor and AI event timestamps are present with medium-or-higher confidence.

- [ ] **Step 6: Write the deterministic rehearsal E2E flow**

Using fake realtime transport, start a scene, hear AI line 1, speak actor line, hear AI line 2, request a cue, restart the beat, finish, and open the queued coaching take. Assert exact line order and stable voice labels.

- [ ] **Step 7: Run workspace verification**

Run: `pnpm typecheck && pnpm vitest apps/web/components/rehearsal apps/web/lib/realtime && pnpm playwright test tests/e2e/plan-3-rehearsal-flow.spec.ts`  
Expected: all controls, scheduling, event, and E2E tests pass.

- [ ] **Step 8: Commit the rehearsal workspace**

```bash
git add apps/web/app/plays apps/web/app/api/rehearsals apps/web/components/rehearsal apps/web/lib/realtime tests/e2e/plan-3-rehearsal-flow.spec.ts
git commit -m "feat: deliver interactive multi-role scene rehearsal"
```

### Task 5: Connection recovery and scripted playback fallback

**Files:**
- Create: `packages/domain/src/rehearsal/recovery.ts`
- Create: `apps/web/lib/realtime/reconnect.ts`
- Create: `apps/web/lib/realtime/fallback-player.ts`
- Create: `apps/web/components/rehearsal/connection-recovery.tsx`
- Create: `apps/web/app/api/rehearsals/[sessionId]/resume/route.ts`
- Test: `packages/domain/src/rehearsal/recovery.test.ts`
- Test: `apps/web/lib/realtime/reconnect.test.ts`
- Test: `tests/e2e/plan-3-reconnect-fallback.spec.ts`

**Interfaces:**
- Consumes: persisted rehearsal events, last acknowledged sequence, current Play Model version.
- Produces: `RecoveryDecision` and fallback continuation without lost scene position.

- [ ] **Step 1: Write failing recovery tests**

```ts
it("resumes from the last acknowledged scene element", () => {
  const decision = recoverSession(eventsThroughLine4, { clientLastSequence: 8, serverLastSequence: 10 });
  expect(decision.cursorElementId).toBe("line_0004");
  expect(decision.replayEventSequences).toEqual([9, 10]);
});
```

- [ ] **Step 2: Run recovery tests and confirm failure**

Run: `pnpm vitest packages/domain/src/rehearsal/recovery.test.ts --run`  
Expected: FAIL because recovery logic is missing.

- [ ] **Step 3: Implement bounded reconnect**

On disconnect, pause microphone upload and local scene advancement. Attempt reconnect after 250 ms, 1 s, and 3 s with a fresh grant each time. Rehydrate from server events after each connection. After the third failure, stop reconnect attempts and offer Retry, Continue with Scripted Voices, or End and Save.

- [ ] **Step 4: Implement fallback playback**

Use the existing `CharacterVoice` TTS adapter for all AI roles while browser speech recognition/transcription continues actor-line detection. Preserve voice assignments where supported. Fallback begins at the current uncompleted element and emits `fallback_selected`; it does not replay acknowledged lines.

- [ ] **Step 5: Test reconnect and fallback end to end**

The Playwright test disconnects fake realtime after line 2, verifies three bounded attempts, chooses fallback, completes the scene without duplicated dialogue, ends and saves, reloads the page, and sees the same event timeline.

- [ ] **Step 6: Run recovery verification**

Run: `pnpm vitest packages/domain/src/rehearsal/recovery.test.ts apps/web/lib/realtime/reconnect.test.ts && pnpm playwright test tests/e2e/plan-3-reconnect-fallback.spec.ts`  
Expected: bounded retry, no duplicate line, event replay, and fallback completion tests pass.

- [ ] **Step 7: Commit resilience behavior**

```bash
git add packages/domain/src/rehearsal apps/web/lib/realtime apps/web/components/rehearsal apps/web/app/api/rehearsals tests/e2e/plan-3-reconnect-fallback.spec.ts
git commit -m "feat: recover or gracefully degrade realtime rehearsals"
```

### Task 6: Private-beta security, observability, and acceptance gate

**Files:**
- Create: `packages/domain/src/operational-events.ts`
- Create: `apps/web/lib/observability/redact.ts`
- Create: `apps/web/app/api/account/delete/route.ts`
- Create: `apps/worker/src/jobs/delete-account.ts`
- Create: `tests/security/private-resource-matrix.test.ts`
- Create: `tests/performance/realtime-latency.ts`
- Create: `tests/performance/coaching-latency.ts`
- Create: `tests/e2e/private-beta-acceptance.spec.ts`
- Create: `docs/runbooks/provider-failure.md`
- Create: `docs/runbooks/private-data-deletion.md`

**Interfaces:**
- Consumes: all private resources and operational states from Plans 1–3.
- Produces: release-gate evidence, redacted operational events, and full account deletion.

- [ ] **Step 1: Write the private-resource authorization matrix**

Enumerate play, source file, Play Model, study artifact, note, take, audio range, transcript, metrics, report, rehearsal session, rehearsal event, and realtime grant endpoints. For every endpoint, create resource as user A and assert user B receives `404`; list endpoints additionally assert no user-A identifiers appear.

- [ ] **Step 2: Run the security matrix before final hardening**

Run: `pnpm vitest tests/security/private-resource-matrix.test.ts --run`  
Expected: test reveals any unscoped endpoint; fix each endpoint by routing through its owner-scoped repository before continuing.

- [ ] **Step 3: Implement redacted operational events**

Allowed event fields are IDs, state codes, durations, byte counts, model IDs, retry counts, and hashed user/session identifiers. The redactor drops transcript text, script text, actor notes, model prompts, audio bytes, credentials, and provider request bodies. Unit tests submit every forbidden field name and assert absence from serialized output.

- [ ] **Step 4: Implement account deletion**

Require password reauthentication, mark the account `deleting`, revoke sessions and realtime grants immediately, enqueue object deletion, cascade database content after objects are confirmed absent, and retain only a nonidentifying deletion audit record. Repeated deletion calls are idempotent.

- [ ] **Step 5: Implement measurable acceptance harnesses**

`realtime-latency.ts` records actor-line-end to partner-first-audio for at least 30 turns and reports median and p95. `coaching-latency.ts` uploads ten five-minute consented fixtures and reports the fraction completed within 90 seconds. Both write timestamped JSON under gitignored `artifacts/acceptance/`.

- [ ] **Step 6: Run the full local release gate**

Run: `pnpm typecheck && pnpm test && pnpm test:e2e`  
Expected: all three plans’ tests pass; private resource matrix has zero leaks; delete-account flow removes all objects and sessions; no live credentials are required.

- [ ] **Step 7: Run provider-backed beta acceptance**

With provider, database, and private storage credentials configured in a nonproduction beta environment, run: `pnpm acceptance:provider`. Expected thresholds: parse dialogue ownership at least 95% on the fixed script set; every explicit major claim has a reference; realtime median at most 1.5 seconds and p95 at most 2.5 seconds; at least 90% of five-minute takes finish within 90 seconds; no low-confidence evidence produces a numeric score.

- [ ] **Step 8: Perform actor usefulness review**

Run at least ten coaching sessions across invited beta actors. Collect separate 1–5 ratings for specificity and actionability. Release requires at least 80% of sessions rated 4 or 5 on both. Store only aggregate results in `artifacts/acceptance/coaching-usefulness.json`.

- [ ] **Step 9: Commit beta hardening**

```bash
git add packages/domain/src/operational-events.ts apps/web/lib/observability apps/web/app/api/account apps/worker/src/jobs/delete-account.ts tests docs/runbooks
git commit -m "feat: satisfy private beta security and acceptance gates"
```
