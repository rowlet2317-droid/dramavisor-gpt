# Drama Practice App Implementation Roadmap

This roadmap decomposes the approved design into three independently testable implementation plans. Execute them in order; each plan ends with usable software and a reviewer gate.

## Plan sequence

| Plan | Deliverable | Depends on |
| --- | --- | --- |
| [Plan 1: Foundation and Study](./2026-08-01-drama-practice-app-plan-1-foundation-study.md) | Invite-only web app that imports English stage plays, creates a reviewable Play Model, and provides grounded whole-play and role study | Approved design |
| [Plan 2: Voice Coaching](./2026-08-01-drama-practice-app-plan-2-voice-coaching.md) | Complete takes, transcript alignment, deterministic audio measurements, hybrid coaching reports, repeated-take comparison, and guided exercises | Plan 1 |
| [Plan 3: Realtime Rehearsal and Beta Hardening](./2026-08-01-drama-practice-app-plan-3-realtime-rehearsal.md) | Multi-character AI scene partners, cue/restart controls, fallback behavior, authorization hardening, and private-beta acceptance tests | Plans 1–2 |

## Cross-plan architecture

- `apps/web`: Next.js user interface and HTTP endpoints.
- `apps/worker`: restartable background job runner.
- `packages/domain`: Play Model, rehearsal, coaching, and job contracts.
- `packages/db`: PostgreSQL schema, migrations, repositories, and authorization-scoped queries.
- `packages/ai`: OpenAI adapters, prompts, structured-output schemas, and fake implementations for tests.
- `packages/media`: script extraction, recording inspection, transcript alignment, and audio measurements.
- `packages/storage`: private S3-compatible object storage with an in-memory test adapter.

## Execution gates

1. Do not begin Plan 2 until Plan 1’s Playwright happy path and cross-user authorization test pass.
2. Do not begin Plan 3 until Plan 2 can create an evidence-linked report from a fixed audio fixture without live model calls.
3. Keep all model names configurable. Run contract tests against fakes on every commit and opt-in provider smoke tests only when credentials are available.
4. Use public-domain or purpose-written scripts and consented test recordings in the repository.
5. Defer mobile, camera analysis, billing, multilingual support, public signup, and voice cloning.

## Approved-spec coverage

| Approved design area | Implementation coverage |
| --- | --- |
| Product vision, scope, invite-only users | Plan 1 Tasks 1–2; Plan 3 Task 6 |
| PDF, DOCX, and pasted-text ingestion | Plan 1 Task 3 |
| OCR warnings and actor review | Plan 1 Tasks 3–4 |
| Stable Play Model and source references | Plan 1 Tasks 1, 4, and 5 |
| Whole-play, scene, and My Role study | Plan 1 Tasks 5–6 |
| Structured guide plus contextual tutor | Plan 1 Task 6 |
| Complete takes and microphone checks | Plan 2 Task 1 |
| Transcription, alignment, and observable metrics | Plan 2 Tasks 2–3 |
| Hybrid evidence-linked coaching | Plan 2 Tasks 4–5 |
| Guided live exercise mode | Plan 2 Task 6 |
| Multi-character rehearsal and stable voices | Plan 3 Tasks 1–4 |
| Cue, restart, reconnect, and fallback | Plan 3 Tasks 2, 4, and 5 |
| Privacy, deletion, and actor isolation | Plan 1 Task 2; Plan 2 Task 6; Plan 3 Task 6 |
| Test strategy and beta acceptance thresholds | Every plan’s final task; Plan 3 Task 6 is the release gate |
| Collaborative cast and consented voice cloning | Intentionally excluded from the private-beta plans and retained in the design roadmap |

## Private-beta release gate

The beta can open only after all three plans pass their local unit/integration suites, PostgreSQL integration tests, Playwright flows, cross-user access tests, and documented provider smoke tests. The final acceptance run records script-parse accuracy, source-reference coverage, realtime latency, five-minute report latency, and coaching usefulness feedback using the thresholds in the approved design.
