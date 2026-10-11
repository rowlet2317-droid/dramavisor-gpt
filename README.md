# Drama Practice App

An invite-only web app for actors studying and rehearsing English stage plays.

## Current status

Plans 1–3 are implemented and merged. The private beta supports invite-only access, English-script ingestion, reviewable Play Models, grounded study, role workbooks, contextual tutoring, private recorded takes with evidence-linked coaching, guided voice exercises, and browser-based real-time scene rehearsal.

External-provider measurements and the ten-actor usefulness study are still pending. The coaching and rehearsal features should therefore be treated as a private-beta workflow, not as independently validated performance assessment.

## What the app includes

- Paste a script or upload a private PDF, DOCX, or UTF-8 TXT file, review the parsed Play Model, then study the play, characters, relationships, scenes, and source evidence.
- Build a grounded role workbook and ask the script tutor about selected passages.
- Record a complete take privately, choose whether to retain it for comparison, and receive transcript-, vocal-measurement-, and script-evidence-linked coaching.
- Run a guided voice exercise for one line, tactic, pause, or alternate interpretation.
- Rehearse a selected role against stable AI scene partners with Start, Pause, Resume, Cue, Restart beat, and Stop controls; extra AI roles use the scripted-voice fallback when needed.

## Documentation

- [Local setup](docs/LOCAL_SETUP.md)
- [User manual](docs/USER_MANUAL.md)

## Development checks

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm lint
pnpm --filter @drama/web exec next build
pnpm smoke:provider fixtures/plays/two-scene-play.txt
pnpm smoke:realtime
```

## Current boundaries

The beta is English-only and voice-only. It does not provide camera analysis, cast voice cloning, a mobile-native app, or a validated global performance score. Realtime and provider smoke commands skip safely when their required OpenAI configuration is absent; a successful configured-provider measurement remains pending.
