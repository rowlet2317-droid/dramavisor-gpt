# Drama Practice App Plan 2: Voice Coaching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add voice-only complete takes, evidence-linked hybrid coaching, repeated-take comparison, and optional turn-by-turn exercises to the working study application.

**Architecture:** Record audio in the browser, store it privately, and process it through restartable background jobs. Keep transcript alignment, deterministic audio measurements, audio-model observations, and final coaching synthesis as separate typed stages so scores remain explainable and failures can degrade gracefully.

**Tech Stack:** Plan 1 stack plus browser MediaRecorder/Web Audio APIs; FFmpeg 7+ available to the worker; `pitchfinder` 2.3+; OpenAI `gpt-transcribe`, `whisper-1` word timestamps when needed, `gpt-audio-1.5`, and configurable GPT-5.6-family reasoning model.

## Global Constraints

- Voice only; do not request or store camera video.
- Complete takes never receive unsolicited live interruption.
- Audio retention defaults to on, with an explicit per-take “do not retain after analysis” option.
- A low-confidence measurement produces `score: null`; it never silently becomes a failing score.
- Numeric ratings apply only to observable categories; artistic interpretation remains qualitative.
- Reports expose timestamped evidence, strengths, no more than three priority notes, and one targeted exercise.
- Scores compare an actor with their own comparable takes, not with other actors.
- Every recording, transcript, metric, and report query is scoped by `ownerUserId`.
- Normal tests use consented synthetic fixtures and fake model adapters.

---

## File structure added by this plan

```text
packages/domain/src/coaching.ts       Coaching contracts and score rules
packages/media/src/audio/             Decode, quality, VAD, pitch, metrics, alignment
packages/ai/src/transcription/        Transcript adapters
packages/ai/src/audio-review/         Audio observation adapters
packages/ai/src/coaching/             Final coaching synthesis
apps/web/app/plays/.../practice/      Recorder, take status, reports, exercises
apps/worker/src/jobs/                 Take-processing stages
fixtures/audio/                       Consented generated test recordings
```

### Task 1: Recording domain, microphone check, and private take upload

**Files:**
- Create: `packages/domain/src/practice.ts`
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0002_practice_sessions.sql`
- Create: `packages/db/src/repositories/practice.ts`
- Create: `apps/web/lib/audio/microphone-check.ts`
- Create: `apps/web/lib/audio/recorder.ts`
- Create: `apps/web/components/practice/recorder-controls.tsx`
- Create: `apps/web/app/plays/[playId]/scenes/[sceneId]/practice/page.tsx`
- Create: `apps/web/app/api/plays/[playId]/takes/route.ts`
- Test: `apps/web/lib/audio/microphone-check.test.ts`
- Test: `apps/web/app/api/plays/[playId]/takes/route.test.ts`

**Interfaces:**
- Consumes: `requireUser`, approved Play Model, `ObjectStorage`.
- Produces: `PracticeSession`, `Take`, `MicrophoneCheck`, and `POST /api/plays/:playId/takes`.

- [ ] **Step 1: Write failing microphone-quality tests**

```ts
export type MicrophoneCheck = {
  ok: boolean;
  rmsDb: number;
  peakDb: number;
  warnings: Array<"SIGNAL_TOO_LOW" | "CLIPPING" | "BACKGROUND_NOISE">;
};

it("flags clipping without rejecting a usable signal", () => {
  const result = inspectMicrophone(samplesWithClippedPeaks, 48_000);
  expect(result.ok).toBe(true);
  expect(result.warnings).toContain("CLIPPING");
});
```

- [ ] **Step 2: Run microphone tests and confirm failure**

Run: `pnpm vitest apps/web/lib/audio/microphone-check.test.ts --run`  
Expected: FAIL because `inspectMicrophone` does not exist.

- [ ] **Step 3: Implement microphone inspection and recording**

Sample three seconds through an `AudioWorklet`. Compute RMS and peak dBFS. Report `SIGNAL_TOO_LOW` below -45 dBFS RMS, `CLIPPING` when more than 0.1% of samples exceed -0.5 dBFS, and `BACKGROUND_NOISE` when the first-second noise floor exceeds -35 dBFS. Warnings are advisory; only missing microphone permission blocks recording.

`TakeRecorder` exposes:

```ts
export interface TakeRecorder {
  start(): Promise<void>;
  stop(): Promise<{ blob: Blob; durationMs: number; mimeType: string }>;
  cancel(): void;
}
```

- [ ] **Step 4: Add practice persistence and upload endpoint**

Create `practice_sessions`, `takes`, and `take_events`. A take records Play Model version, scene, role, selected interpretation, retention choice, duration, object key, and states `uploading | queued | processing | completed | action_required | completed_with_limitations`.

The endpoint accepts WebM or WAV up to 100 MiB and 20 minutes. It validates play ownership, scene membership, role membership, and nonzero duration; stores audio privately; and enqueues `process_take` transactionally.

- [ ] **Step 5: Verify recording contracts and authorization**

Run: `pnpm vitest apps/web/lib/audio apps/web/app/api/plays packages/db/src/repositories/practice.integration.test.ts --run`  
Expected: microphone thresholds, allowed formats, size/duration limits, and cross-user `404` tests pass.

- [ ] **Step 6: Commit recording and upload**

```bash
git add packages/domain/src/practice.ts packages/db apps/web/lib/audio apps/web/components/practice apps/web/app/plays apps/web/app/api/plays
git commit -m "feat: record and privately upload scene takes"
```

### Task 2: Transcription and script alignment

**Files:**
- Create: `packages/domain/src/transcript.ts`
- Create: `packages/ai/src/transcription/port.ts`
- Create: `packages/ai/src/transcription/openai-transcriber.ts`
- Create: `packages/ai/src/transcription/fake-transcriber.ts`
- Create: `packages/media/src/audio/normalize.ts`
- Create: `packages/media/src/audio/align-script.ts`
- Create: `apps/worker/src/jobs/transcribe-take.ts`
- Test: `packages/media/src/audio/align-script.test.ts`
- Test: `apps/worker/src/jobs/transcribe-take.test.ts`
- Fixture: `fixtures/audio/alex-scene-clean.wav`
- Fixture: `fixtures/audio/alex-scene-omission.wav`

**Interfaces:**
- Consumes: private take audio, selected role’s ordered dialogue elements.
- Produces: `Transcript`, `TranscriptWord`, `LineAlignment[]`, and uncertainty regions.

- [ ] **Step 1: Write failing alignment tests**

```ts
export type TranscriptWord = { text: string; startMs: number; endMs: number; confidence: number | null };
export type LineAlignment = {
  elementId: string;
  transcriptStartMs: number | null;
  transcriptEndMs: number | null;
  similarity: number;
  status: "matched" | "paraphrased" | "omitted" | "uncertain";
};

it("identifies an omitted line without shifting every later line", () => {
  const result = alignScript(roleLines, omissionTranscript.words);
  expect(result.find((x) => x.elementId === "line_0003")?.status).toBe("omitted");
  expect(result.find((x) => x.elementId === "line_0004")?.status).toBe("matched");
});
```

- [ ] **Step 2: Run alignment tests and confirm failure**

Run: `pnpm vitest packages/media/src/audio/align-script.test.ts --run`  
Expected: FAIL because transcript and alignment modules are missing.

- [ ] **Step 3: Implement audio normalization and transcription adapters**

Normalize uploads to mono 16 kHz PCM WAV with FFmpeg while retaining the original. `Transcriber.transcribe` returns text, language, optional word timestamps, and provider metadata. Use `gpt-transcribe` for primary English text; request `whisper-1` word timestamps when the primary result lacks word timing. If the timing request fails, keep the text and mark evidence timing `uncertain` rather than failing the take.

- [ ] **Step 4: Implement monotonic script alignment**

Normalize punctuation and case but preserve contractions. Use dynamic programming over script lines and transcript word windows with token-level Levenshtein similarity. Thresholds: `matched >= 0.90`, `paraphrased 0.65–0.89`, `omitted < 0.35` when neighboring lines align, otherwise `uncertain`. Never align one transcript word to two script lines.

- [ ] **Step 5: Implement restartable transcription job**

Persist transcript, words, alignments, model name, and timing source. Deduplicate on `takeId + audioSha256 + transcriberVersion`. On language other than English, set `action_required` with `UNSUPPORTED_LANGUAGE`. On missing timestamps, continue with `completed_with_limitations`.

- [ ] **Step 6: Run transcription and alignment verification**

Run: `pnpm vitest packages/media/src/audio apps/worker/src/jobs/transcribe-take.test.ts --run`  
Expected: clean, omission, paraphrase, retry, non-English, and missing-timestamp cases pass.

- [ ] **Step 7: Commit transcription and alignment**

```bash
git add packages/domain/src/transcript.ts packages/ai/src/transcription packages/media/src/audio apps/worker/src/jobs/transcribe-take.ts fixtures/audio
git commit -m "feat: transcribe and align actor takes to script lines"
```

### Task 3: Deterministic audio measurements and score confidence

**Files:**
- Create: `packages/domain/src/audio-metrics.ts`
- Create: `packages/media/src/audio/decode-wav.ts`
- Create: `packages/media/src/audio/vad.ts`
- Create: `packages/media/src/audio/pitch.ts`
- Create: `packages/media/src/audio/metrics.ts`
- Create: `apps/worker/src/jobs/measure-take.ts`
- Test: `packages/media/src/audio/metrics.test.ts`

**Interfaces:**
- Consumes: normalized WAV and line alignments.
- Produces: `TakeMetrics`, per-line metrics, `MeasurementConfidence`, and technical quality warnings.

- [ ] **Step 1: Write failing metric tests using generated waveforms**

```ts
it("measures an inserted two-second pause", () => {
  const metrics = measureTake(waveformWithPause, { sampleRate: 16_000, alignments });
  expect(metrics.pauses.some((pause) => pause.durationMs >= 1_950 && pause.durationMs <= 2_050)).toBe(true);
});

it("returns no pitch score for mostly unvoiced audio", () => {
  const metrics = measureTake(unvoicedFixture, { sampleRate: 16_000, alignments });
  expect(metrics.pitch.confidence).toBe("insufficient_data");
});
```

- [ ] **Step 2: Run metric tests and confirm failure**

Run: `pnpm vitest packages/media/src/audio/metrics.test.ts --run`  
Expected: FAIL because metric functions do not exist.

- [ ] **Step 3: Implement deterministic measurements**

Use 20 ms frames with 10 ms hop. VAD marks speech when frame RMS exceeds the measured noise floor by 12 dB for at least 120 ms. Compute speech duration, silence duration, pause boundaries, words per minute, RMS/loudness range, clipping ratio, and voiced pitch median/range via YIN. Attach line-level windows only where transcript timing is known.

- [ ] **Step 4: Define confidence rules**

Return `high`, `medium`, `low`, or `insufficient_data` per metric. Set `insufficient_data` when less than 60% of the take has usable alignment, pitch has fewer than 50 voiced frames, or clipping affects more than 5% of samples. Downstream scoring must map `low` and `insufficient_data` to `score: null`.

- [ ] **Step 5: Run measurement verification**

Run: `pnpm vitest packages/media/src/audio/metrics.test.ts apps/worker/src/jobs/measure-take.test.ts --run`  
Expected: pause, pace, loudness, pitch, clipping, and confidence fixtures pass within documented tolerances.

- [ ] **Step 6: Commit audio measurements**

```bash
git add packages/domain/src/audio-metrics.ts packages/media/src/audio apps/worker/src/jobs/measure-take.ts
git commit -m "feat: measure explainable vocal performance features"
```

### Task 4: Audio interpretation and hybrid coaching synthesis

**Files:**
- Create: `packages/domain/src/coaching.ts`
- Create: `packages/ai/src/audio-review/port.ts`
- Create: `packages/ai/src/audio-review/openai-audio-review.ts`
- Create: `packages/ai/src/audio-review/fake-audio-review.ts`
- Create: `packages/ai/src/coaching/port.ts`
- Create: `packages/ai/src/coaching/openai-coach.ts`
- Create: `packages/ai/src/coaching/fake-coach.ts`
- Create: `apps/worker/src/jobs/review-audio.ts`
- Create: `apps/worker/src/jobs/synthesize-coaching.ts`
- Test: `packages/domain/src/coaching.test.ts`
- Test: `apps/worker/src/jobs/synthesize-coaching.test.ts`

**Interfaces:**
- Consumes: scene study, selected interpretation, transcript alignments, `TakeMetrics`, and original audio.
- Produces: validated `CoachingReport` with evidence and optional category scores.

- [ ] **Step 1: Write failing report-invariant tests**

```ts
export type Rating = { category: "line_accuracy" | "clarity" | "pacing" | "cue_responsiveness" | "vocal_variation"; score: number | null; confidence: "high" | "medium" | "low"; evidenceIds: string[] };
export type CoachingReport = { ratings: Rating[]; strengths: CoachingNote[]; priorities: CoachingNote[]; exercise: CoachingExercise; interpretationNotes: CoachingNote[] };

it("rejects more than three priorities", () => {
  expect(() => CoachingReportSchema.parse(reportWithFourPriorities)).toThrow();
});

it("rejects a score whose source confidence is low", () => {
  expect(() => validateReport(reportWithLowConfidenceScore, evidence)).toThrow("LOW_CONFIDENCE_SCORE");
});
```

- [ ] **Step 2: Run report tests and confirm failure**

Run: `pnpm vitest packages/domain/src/coaching.test.ts --run`  
Expected: FAIL because report schemas and validators do not exist.

- [ ] **Step 3: Implement audio observation adapter**

Send the bounded audio take plus scene objective, selected interpretation, and exact line text to `gpt-audio-1.5`. Require observations with start/end milliseconds, observable description, confidence, and related element IDs. Reject claims outside audio duration or referencing unknown elements. Do not request or accept a global acting-quality score.

- [ ] **Step 4: Implement score calculation and final synthesis**

Calculate line accuracy deterministically from aligned token edit distance. Set cue responsiveness to `null` for solo complete takes. Feed remaining metrics, validated audio observations, script evidence, and previous comparable take summary to the configured GPT-5.6-family coach. Require strengths, up to three priorities, one exercise, and interpretation notes. The coach may propose pacing, clarity, and vocal-variation scores only when the corresponding evidence confidence is at least medium; final validator enforces this.

- [ ] **Step 5: Implement pipeline orchestration and degradation**

`process_take` advances through transcription, measurement, audio review, and synthesis. If audio review fails after two attempts, produce a metrics-and-transcript report with state `completed_with_limitations`. If synthesis fails schema validation twice, set `action_required` and preserve all completed intermediate evidence for retry.

- [ ] **Step 6: Run coaching verification**

Run: `pnpm vitest packages/domain/src/coaching.test.ts packages/ai/src/audio-review packages/ai/src/coaching apps/worker/src/jobs --run`  
Expected: priority limit, evidence bounds, low-confidence null scores, solo cue N/A, fallback report, and idempotency tests pass.

- [ ] **Step 7: Commit coaching pipeline**

```bash
git add packages/domain/src/coaching.ts packages/ai/src/audio-review packages/ai/src/coaching apps/worker/src/jobs
git commit -m "feat: generate evidence-linked hybrid coaching reports"
```

### Task 5: Coaching report UI, replay, and repeated-take comparison

**Files:**
- Create: `apps/web/app/plays/[playId]/takes/[takeId]/page.tsx`
- Create: `apps/web/app/api/plays/[playId]/takes/[takeId]/route.ts`
- Create: `apps/web/app/api/plays/[playId]/takes/[takeId]/audio/route.ts`
- Create: `apps/web/components/coaching/rating-card.tsx`
- Create: `apps/web/components/coaching/evidence-player.tsx`
- Create: `apps/web/components/coaching/priority-notes.tsx`
- Create: `apps/web/components/coaching/take-comparison.tsx`
- Create: `packages/domain/src/take-comparison.ts`
- Test: `apps/web/components/coaching/evidence-player.test.tsx`
- Test: `packages/domain/src/take-comparison.test.ts`
- Test: `tests/e2e/plan-2-complete-take.spec.ts`

**Interfaces:**
- Consumes: `CoachingReport`, private range-readable audio, comparable prior takes.
- Produces: evidence replay UI and `compareTakes(current, previous)`.

- [ ] **Step 1: Write failing comparison and replay tests**

```ts
it("reports improvement only for comparable non-null scores", () => {
  const result = compareTakes(current, previous);
  expect(result.line_accuracy).toEqual({ previous: 82, current: 94, delta: 12 });
  expect(result.cue_responsiveness).toBeNull();
});
```

The audio route test must prove a valid owner receives `206` for a byte range and another user receives `404`.

- [ ] **Step 2: Run UI tests and confirm failure**

Run: `pnpm vitest apps/web/components/coaching packages/domain/src/take-comparison.test.ts --run`  
Expected: FAIL because report UI and comparison logic are missing.

- [ ] **Step 3: Implement report and evidence playback**

Show state while processing, then ratings with confidence, strengths, no more than three priorities, interpretation notes, and exercise. Clicking evidence seeks the private audio element to `startMs / 1000`, plays through `endMs`, and highlights the linked script passage.

- [ ] **Step 4: Implement comparable-take selection**

Compare only takes with the same play version, scene, role, and practice mode. Prefer the most recent completed take before the current take. Display deltas only when both scores are non-null and confidence is medium or high; otherwise show the two evidence summaries without a numeric delta.

- [ ] **Step 5: Implement Plan 2 end-to-end flow**

The Playwright test uses a deterministic prerecorded fixture through a test-only upload seam: open a studied scene, choose an interpretation, upload the take, wait for the fake worker, replay evidence, verify three-or-fewer priorities, perform a second take, and see a line-accuracy delta.

- [ ] **Step 6: Run report acceptance tests**

Run: `pnpm typecheck && pnpm test && pnpm playwright test tests/e2e/plan-2-complete-take.spec.ts`  
Expected: all tests pass without live provider calls.

- [ ] **Step 7: Commit report experience**

```bash
git add apps/web/app/plays apps/web/app/api/plays apps/web/components/coaching packages/domain/src/take-comparison.ts tests/e2e/plan-2-complete-take.spec.ts
git commit -m "feat: review evidence and compare repeated takes"
```

### Task 6: Guided exercise mode, retention, and Plan 2 release gate

**Files:**
- Create: `packages/domain/src/exercises.ts`
- Create: `apps/web/app/plays/[playId]/scenes/[sceneId]/exercise/page.tsx`
- Create: `apps/web/app/api/plays/[playId]/exercises/route.ts`
- Create: `apps/web/app/api/plays/[playId]/takes/[takeId]/delete/route.ts`
- Create: `apps/worker/src/jobs/purge-take-audio.ts`
- Test: `packages/domain/src/exercises.test.ts`
- Test: `apps/web/app/api/plays/[playId]/takes/[takeId]/delete/route.test.ts`
- Test: `tests/e2e/plan-2-guided-exercise.spec.ts`

**Interfaces:**
- Consumes: role workbook, prior report priorities, short recorded attempts.
- Produces: `ExerciseSession`, `ExerciseTurn`, explicit pause/retry loop, and deletion/retention behavior.

- [ ] **Step 1: Write failing exercise-state tests**

```ts
it("never interrupts a complete take", () => {
  expect(nextExerciseAction({ mode: "complete_take", event: "speech_detected" })).toEqual({ type: "continue" });
});

it("offers one note after a guided attempt", () => {
  expect(nextExerciseAction(guidedAttemptCompleted)).toMatchObject({ type: "coach", maxNotes: 1 });
});
```

- [ ] **Step 2: Run exercise tests and confirm failure**

Run: `pnpm vitest packages/domain/src/exercises.test.ts --run`  
Expected: FAIL because the exercise state machine is absent.

- [ ] **Step 3: Implement turn-by-turn guided exercises**

Support `repeat_line`, `change_tactic`, `pause_and_intend`, and `alternative_interpretation`. Each turn records a bounded utterance, runs the existing take pipeline on that utterance, and returns one evidence-linked note. The actor explicitly chooses Continue, Retry, or Finish; the system does not activate microphone recording automatically after feedback.

- [ ] **Step 4: Implement retention and deletion**

If `retainAudio=false`, purge the original and normalized audio after the report commits, while retaining transcript, metrics, report, and an `audio_deleted_at` marker. Explicit delete removes audio immediately and marks evidence playback unavailable; deleting a play cascades all objects through a queued purge job. Object deletion is idempotent.

- [ ] **Step 5: Run the complete Plan 2 gate**

Run: `pnpm typecheck && pnpm test && pnpm test:e2e`  
Expected: all Plan 1 and Plan 2 tests pass, including cross-user audio denial, no-retention purge, complete-take noninterruption, and guided exercise flow.

- [ ] **Step 6: Commit guided coaching and retention**

```bash
git add packages/domain/src/exercises.ts apps/web/app/plays apps/web/app/api/plays apps/worker/src/jobs/purge-take-audio.ts tests/e2e
git commit -m "feat: add guided vocal exercises and recording retention controls"
```

- [ ] **Step 7: Run opt-in provider and latency smoke tests**

With provider credentials, run: `pnpm smoke:coaching fixtures/audio/alex-scene-clean.wav`  
Expected: validated report, at most three priorities, all evidence within audio duration, and no score from low-confidence evidence. Record end-to-end processing duration and model IDs in gitignored `artifacts/provider-smoke/plan-2.json`.
