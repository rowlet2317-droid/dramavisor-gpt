# Task 6 Review Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining cross-user authorization, production dependency, and Next route-contract review findings without weakening type checks.

**Architecture:** Extend the live HTTP acceptance matrix for the two missing mutation APIs. Keep the normal database client PostgreSQL-only and install an in-memory PGlite override from a separately exported E2E module during Next instrumentation. Move handler factories into adjacent `handler.ts` modules so every Next `route.ts` exports only supported route names.

**Tech Stack:** TypeScript, Next.js 16, Drizzle ORM, PGlite, Vitest, Playwright.

## Global Constraints

- Use real HTTP requests for cross-user acceptance and return indistinguishable 404 responses.
- PGlite remains a development-only dependency and must not load through `@drama/db/client`.
- Remove the broad `typescript.ignoreBuildErrors` setting; both strict typecheck and Next route validation must pass.
- Commit this review round separately and append RED/GREEN evidence to the Task 6 report.

---

### Task 1: Complete the cross-user mutation matrix

**Files:**
- Modify: `tests/e2e/cross-user-access.spec.ts`

**Interfaces:**
- Consumes: Approved owner play URLs and the intruder session cookie.
- Produces: Real intruder `POST /api/plays/:id/my-role` and `PATCH /api/plays/:id/review` assertions returning 404.

- [ ] Add both intruder mutation requests with schema-valid bodies.
- [ ] Run the focused Playwright test and record the expected RED caused by missing assertions in the current matrix.
- [ ] Keep tutor/provider assertions unchanged and rerun the focused test GREEN.

### Task 2: Isolate PGlite from the production database module

**Files:**
- Create: `packages/db/src/client.test.ts`
- Create: `packages/db/src/e2e-client.ts`
- Modify: `packages/db/src/client.ts`
- Modify: `packages/db/package.json`
- Modify: `apps/web/instrumentation.ts`
- Modify: `apps/web/next.config.ts`

**Interfaces:**
- Consumes: `getDatabase()` and the E2E instrumentation startup hook.
- Produces: `installE2eDatabase(path)` returning `{ db, client }`, with the production client importing only PostgreSQL dependencies.

- [ ] Add a test that makes evaluation of `@electric-sql/pglite` throw, dynamically imports `client.ts`, and proves PostgreSQL client creation remains available.
- [ ] Run that test RED against the current static import.
- [ ] Move PGlite construction to `e2e-client.ts`, install its database as the explicit runtime override, and export the E2E entrypoint from the package.
- [ ] Update instrumentation to import the E2E entrypoint and migrate its returned raw client.
- [ ] Run the focused test and existing database tests GREEN.

### Task 3: Restore Next route-contract validation

**Files:**
- Create: adjacent `handler.ts` files for the eight API route factories.
- Modify: the eight corresponding `route.ts` files and their tests.
- Modify: `apps/web/next.config.ts`

**Interfaces:**
- Consumes: Existing handler factory signatures.
- Produces: Next route entry modules that export only `GET`, `POST`, or `PATCH`.

- [ ] Run the E2E Next build without `ignoreBuildErrors` and capture the generated route-export failures as RED.
- [ ] Move each factory and its private helper types/functions into adjacent `handler.ts`; update tests and route composition imports.
- [ ] Remove `typescript.ignoreBuildErrors` and obsolete PGlite externalization.
- [ ] Run strict typecheck and the Next production build GREEN.

### Task 4: Verify, document, and commit

**Files:**
- Modify: `.superpowers/sdd/2026-08-01-drama-practice-app-plan-1-foundation-study/task-6-report.md`

**Interfaces:**
- Produces: Exact round-2 evidence and a separate review-fix commit.

- [ ] Run `pnpm typecheck && pnpm test && pnpm test:e2e`.
- [ ] Run `pnpm lint` and `git diff --check`.
- [ ] Run the provider smoke command and record the no-key skip.
- [ ] Append RED/GREEN evidence, review the diff, and commit with a round-2 fix message.
