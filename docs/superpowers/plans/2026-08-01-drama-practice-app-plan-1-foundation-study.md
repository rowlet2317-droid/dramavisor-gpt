# Drama Practice App Plan 1: Foundation and Study Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an invite-only laptop web app that imports English stage plays, creates a reviewable Play Model, and provides grounded whole-play, scene, and role study.

**Architecture:** Use a pnpm TypeScript monorepo with a Next.js web app, a restartable worker, focused domain packages, PostgreSQL, and private S3-compatible storage. All model calls sit behind typed adapters with deterministic fakes so normal tests never require network access.

**Tech Stack:** Node.js 24.x LTS; pnpm 11.18+; TypeScript 7.0+; Next.js 16.2+; React 19.2+; PostgreSQL 17+; Drizzle ORM 0.45+; Zod 4.4+; OpenAI SDK 7.3+; Vitest 4.1+; Testing Library 16.3+; Playwright 1.62+; PDF.js 6.2+; Mammoth 1.12+.

## Global Constraints

- Initial platform is a laptop web browser; layouts must remain usable from 1024 px upward.
- Accounts are invite-only; there is no public signup, billing, or subscription code.
- Only English stage plays are accepted.
- Inputs are PDF, DOCX, and pasted text.
- Every major generated claim exposes a stable script reference or is labeled as interpretation.
- All user-owned queries require `ownerUserId`; no unscoped repository method may return private content.
- Model names come from environment-backed configuration and never appear in domain code.
- Repository fixtures use public-domain or purpose-written scripts only.
- Defer mobile-native UI, video analysis, multilingual support, public sharing, and voice cloning.

---

## File structure established by this plan

```text
apps/
  web/                    Next.js routes, components, and server actions
  worker/                 PostgreSQL-backed job runner
packages/
  domain/                 Play Model and job contracts
  db/                     Drizzle schema, migrations, scoped repositories
  ai/                     Typed analysis/tutor ports and OpenAI/fake adapters
  media/                  PDF, DOCX, and pasted-text extraction
  storage/                Private object storage port and adapters
fixtures/
  plays/                  Public-domain and purpose-written test scripts
tests/e2e/                Cross-feature Playwright flows
```

### Task 1: Monorepo foundation and Play Model contracts

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `apps/web/package.json`
- Create: `apps/web/app/layout.tsx`
- Create: `apps/web/app/page.tsx`
- Create: `apps/worker/package.json`
- Create: `packages/domain/package.json`
- Create: `packages/domain/src/play-model.ts`
- Create: `packages/domain/src/jobs.ts`
- Test: `packages/domain/src/play-model.test.ts`

**Interfaces:**
- Consumes: none; this is the workspace foundation.
- Produces: `PlayModel`, `ScriptElement`, `ScriptReference`, `JobEnvelope<T>`, and workspace commands used by every later task.

- [ ] **Step 1: Write the failing Play Model validation test**

```ts
import { describe, expect, it } from "vitest";
import { PlayModelSchema } from "./play-model";

describe("PlayModelSchema", () => {
  it("accepts ordered, stably identified stage-play elements", () => {
    const play = PlayModelSchema.parse({
      id: "play_1",
      title: "The Test Play",
      language: "en",
      acts: [{
        id: "act_1", ordinal: 1, title: "Act I", scenes: [{
          id: "scene_1", ordinal: 1, title: "Scene 1",
          characterIds: ["char_alex"],
          elements: [{
            id: "line_0001", ordinal: 1, kind: "dialogue",
            characterId: "char_alex", text: "We begin.", sourcePage: 1,
          }],
        }],
      }],
      characters: [{ id: "char_alex", name: "ALEX", aliases: [] }],
    });
    expect(play.acts[0].scenes[0].elements[0].id).toBe("line_0001");
  });
});
```

- [ ] **Step 2: Run the test and confirm the missing schema failure**

Run: `pnpm vitest packages/domain/src/play-model.test.ts --run`  
Expected: FAIL because `PlayModelSchema` does not exist.

- [ ] **Step 3: Create workspace configuration and the minimal domain schemas**

Use exact dependency floors from the header. Define discriminated script elements:

```ts
import { z } from "zod";

export const ScriptElementSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), ordinal: z.number().int().positive(), kind: z.literal("dialogue"), characterId: z.string(), text: z.string().min(1), sourcePage: z.number().int().positive().nullable() }),
  z.object({ id: z.string(), ordinal: z.number().int().positive(), kind: z.literal("stage_direction"), text: z.string().min(1), sourcePage: z.number().int().positive().nullable() }),
  z.object({ id: z.string(), ordinal: z.number().int().positive(), kind: z.literal("heading"), text: z.string().min(1), sourcePage: z.number().int().positive().nullable() }),
]);

export const CharacterSchema = z.object({ id: z.string(), name: z.string().min(1), aliases: z.array(z.string()) });
export const SceneSchema = z.object({ id: z.string(), ordinal: z.number().int().positive(), title: z.string(), characterIds: z.array(z.string()), elements: z.array(ScriptElementSchema) });
export const ActSchema = z.object({ id: z.string(), ordinal: z.number().int().positive(), title: z.string(), scenes: z.array(SceneSchema) });
export const PlayModelSchema = z.object({ id: z.string(), title: z.string().min(1), language: z.literal("en"), acts: z.array(ActSchema), characters: z.array(CharacterSchema) });

export type PlayModel = z.infer<typeof PlayModelSchema>;
export type ScriptElement = z.infer<typeof ScriptElementSchema>;
export type ScriptReference = { playId: string; elementIds: string[] };
```

Add root scripts: `typecheck`, `test`, `test:e2e`, `lint`, and `dev`.

- [ ] **Step 4: Run foundation verification**

Run: `pnpm install && pnpm typecheck && pnpm test`  
Expected: installation succeeds and the Play Model test passes.

- [ ] **Step 5: Commit the foundation**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.workspace.ts apps packages/domain
git commit -m "chore: establish drama app workspace and play model"
```

### Task 2: PostgreSQL persistence and invite-only authentication

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/drizzle.config.ts`
- Create: `packages/db/src/schema.ts`
- Create: `packages/db/src/client.ts`
- Create: `packages/db/src/repositories/plays.ts`
- Create: `packages/db/src/repositories/auth.ts`
- Create: `packages/db/migrations/0001_foundation.sql`
- Create: `apps/web/lib/auth/password.ts`
- Create: `apps/web/lib/auth/session.ts`
- Create: `apps/web/app/invite/[token]/page.tsx`
- Create: `apps/web/app/api/auth/accept-invite/route.ts`
- Create: `apps/web/app/api/auth/sign-in/route.ts`
- Create: `scripts/create-invite.ts`
- Test: `packages/db/src/repositories/plays.integration.test.ts`
- Test: `apps/web/lib/auth/password.test.ts`

**Interfaces:**
- Consumes: `PlayModel` from `@drama/domain/play-model`.
- Produces: `requireUser(): Promise<{ id: string }>`; `PlayRepository.list(ownerUserId)`; `PlayRepository.get(ownerUserId, playId)`; `PlayRepository.create(ownerUserId, input)`.

- [ ] **Step 1: Write failing password and owner-scope tests**

```ts
it("verifies only the original password", async () => {
  const encoded = await hashPassword("correct horse battery staple");
  expect(await verifyPassword("correct horse battery staple", encoded)).toBe(true);
  expect(await verifyPassword("wrong", encoded)).toBe(false);
});

it("does not return another actor's play", async () => {
  const play = await repo.create("user_a", { title: "Private Play" });
  await expect(repo.get("user_b", play.id)).resolves.toBeNull();
});
```

- [ ] **Step 2: Run targeted tests and confirm failures**

Run: `pnpm vitest apps/web/lib/auth/password.test.ts packages/db/src/repositories/plays.integration.test.ts --run`  
Expected: FAIL because auth functions, schema, and repository are missing.

- [ ] **Step 3: Implement schema, password hashing, and scoped repositories**

Use Node `crypto.scrypt` with a random 16-byte salt and `timingSafeEqual`. Store `salt:derivedKey` as base64. Define tables for `users`, `invite_tokens`, `sessions`, `plays`, `source_files`, `play_models`, `analysis_artifacts`, and `jobs`. Every private table includes `owner_user_id` or joins through a parent that does.

Repository queries must include ownership in SQL:

```ts
async get(ownerUserId: string, playId: string) {
  const rows = await db.select().from(plays).where(and(eq(plays.id, playId), eq(plays.ownerUserId, ownerUserId))).limit(1);
  return rows[0] ?? null;
}
```

Sessions use a 32-byte random bearer token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; store only its SHA-256 hash. Invite tokens are single-use and expire after seven days. `scripts/create-invite.ts --email actor@example.com` prints one invite URL and never logs stored password material.

- [ ] **Step 4: Add invite acceptance and sign-in route tests**

Test expired invite → `410`, used invite → `409`, valid invite → user plus session cookie, wrong password → `401`, and successful sign-in → rotated session.

- [ ] **Step 5: Run database and auth verification**

Run: `pnpm db:migrate:test && pnpm vitest packages/db apps/web/lib/auth apps/web/app/api/auth --run`  
Expected: all auth and cross-user repository tests pass.

- [ ] **Step 6: Commit authentication and persistence**

```bash
git add packages/db apps/web/lib/auth apps/web/app/invite apps/web/app/api/auth scripts/create-invite.ts
git commit -m "feat: add invite-only authentication and scoped persistence"
```

### Task 3: Private storage and script extraction

**Files:**
- Create: `packages/storage/package.json`
- Create: `packages/storage/src/port.ts`
- Create: `packages/storage/src/s3-storage.ts`
- Create: `packages/storage/src/memory-storage.ts`
- Create: `packages/media/package.json`
- Create: `packages/media/src/scripts/extract.ts`
- Create: `packages/media/src/scripts/pdf.ts`
- Create: `packages/media/src/scripts/docx.ts`
- Create: `packages/media/src/scripts/ocr.ts`
- Create: `apps/web/app/api/plays/route.ts`
- Create: `apps/web/app/plays/new/page.tsx`
- Test: `packages/media/src/scripts/extract.test.ts`
- Test: `apps/web/app/api/plays/route.test.ts`
- Fixture: `fixtures/plays/two-scene-play.txt`
- Fixture: `fixtures/plays/two-scene-play.docx`
- Fixture: `fixtures/plays/two-scene-play.pdf`

**Interfaces:**
- Consumes: `requireUser`, `PlayRepository.create`, `JobEnvelope`.
- Produces: `ScriptExtractor.extract(input): Promise<ExtractedScript>` and `ObjectStorage.putPrivate(key, bytes, contentType)`.

- [ ] **Step 1: Write extraction contract tests**

```ts
export type ExtractedPage = { page: number | null; text: string; extraction: "native" | "ocr" };
export type ExtractedScript = { titleHint: string | null; pages: ExtractedPage[]; warnings: string[] };

it.each(["txt", "docx", "pdf"])("extracts the same dialogue from %s", async (format) => {
  const result = await extractor.extract(fixture(format));
  expect(result.pages.map((p) => p.text).join("\n")).toContain("ALEX: We begin.");
});
```

- [ ] **Step 2: Run tests and confirm missing adapter failures**

Run: `pnpm vitest packages/media/src/scripts/extract.test.ts --run`  
Expected: FAIL because extractor adapters do not exist.

- [ ] **Step 3: Implement private storage and extraction adapters**

Use Mammoth raw-text extraction for DOCX and PDF.js text items grouped by page for digital PDFs. If a PDF page yields fewer than 20 non-whitespace characters, render that page and pass it to the English OCR adapter. Return warning code `OCR_USED` for any OCR page and `LOW_TEXT_CONFIDENCE` when OCR returns fewer than 40 characters.

Storage keys use opaque IDs: `users/{userId}/plays/{playId}/source/{fileId}`. The API never returns storage keys or provider URLs.

- [ ] **Step 4: Implement the create-play endpoint and upload page**

Accept exactly one of multipart `file` or JSON `pastedText`. Reject non-PDF/DOCX types, files over 25 MiB, empty pasted text, and detected non-English input with `422`. Create a play in `processing` state and enqueue `extract_script` in the same database transaction.

- [ ] **Step 5: Run extraction and endpoint tests**

Run: `pnpm vitest packages/media packages/storage apps/web/app/api/plays --run`  
Expected: all fixture, size-limit, ownership, and unsupported-format tests pass.

- [ ] **Step 6: Commit ingestion**

```bash
git add packages/media packages/storage apps/web/app/api/plays apps/web/app/plays/new fixtures/plays
git commit -m "feat: ingest pdf docx and pasted stage plays"
```

### Task 4: Structural parser, review workflow, and restartable jobs

**Files:**
- Create: `packages/ai/package.json`
- Create: `packages/ai/src/config.ts`
- Create: `packages/ai/src/play-parser/port.ts`
- Create: `packages/ai/src/play-parser/openai-parser.ts`
- Create: `packages/ai/src/play-parser/fake-parser.ts`
- Create: `packages/domain/src/parse-review.ts`
- Create: `apps/worker/src/jobs/claim.ts`
- Create: `apps/worker/src/jobs/extract-script.ts`
- Create: `apps/worker/src/jobs/parse-play.ts`
- Create: `apps/worker/src/index.ts`
- Create: `apps/web/app/plays/[playId]/review/page.tsx`
- Create: `apps/web/app/api/plays/[playId]/review/route.ts`
- Test: `apps/worker/src/jobs/parse-play.test.ts`
- Test: `apps/web/app/api/plays/[playId]/review/route.test.ts`

**Interfaces:**
- Consumes: `ExtractedScript`, `PlayModelSchema`, owner-scoped play repository.
- Produces: `PlayParser.parse(extracted): Promise<ParseProposal>`; `ParseIssue`; approved `PlayModel` version.

- [ ] **Step 1: Write failing parser and idempotency tests**

```ts
export type ParseIssue = { id: string; kind: "character_name" | "dialogue_owner" | "scene_boundary" | "unreadable_text"; elementIds: string[]; message: string };
export type ParseProposal = { playModel: PlayModel; issues: ParseIssue[] };

export const ParseProposalSchema = z.object({
  playModel: PlayModelSchema,
  issues: z.array(z.object({
    id: z.string(),
    kind: z.enum(["character_name", "dialogue_owner", "scene_boundary", "unreadable_text"]),
    elementIds: z.array(z.string()),
    message: z.string().min(1),
  })),
});

it("reuses the completed result when the same job is retried", async () => {
  const first = await runParseJob(job);
  const second = await runParseJob(job);
  expect(second.playModelVersionId).toBe(first.playModelVersionId);
  expect(fakeParser.calls).toBe(1);
});
```

- [ ] **Step 2: Run parser tests and confirm failures**

Run: `pnpm vitest apps/worker/src/jobs/parse-play.test.ts --run`  
Expected: FAIL because `runParseJob` and parser ports are missing.

- [ ] **Step 3: Implement the structured parser adapter**

Send page-numbered extracted text to the configured analysis model and require JSON matching `ParseProposalSchema`. Generate stable IDs from play version plus ordered element ordinal; do not accept provider-generated IDs. Reject references to unknown characters, duplicate ordinals, or dialogue without an owner. On schema failure, retry once with validation errors; a second failure sets job state `action_required` with code `MODEL_SCHEMA_FAILURE`.

- [ ] **Step 4: Implement transaction-safe job claiming**

Claim one pending job with `FOR UPDATE SKIP LOCKED`, set a 10-minute lease, increment `attempt_count`, and use `dedupe_key` uniqueness. A worker may reclaim expired leases. After three failed attempts, set `action_required`; never create a second Play Model version for the same completed dedupe key.

- [ ] **Step 5: Implement script review and correction**

The review page displays every issue beside its source passage. `PATCH /api/plays/:playId/review` accepts `{ corrections, approve }`, validates ownership, writes corrected elements as a new Play Model version, marks superseded analysis stale, and enqueues `generate_study` only when `approve` is true and no blocking issues remain.

- [ ] **Step 6: Run parser, worker, and review tests**

Run: `pnpm vitest packages/ai apps/worker apps/web/app/api/plays --run`  
Expected: parser validation, retries, leases, corrections, and cross-user denial all pass.

- [ ] **Step 7: Commit the reviewable Play Model pipeline**

```bash
git add packages/ai packages/domain/src/parse-review.ts apps/worker apps/web/app/plays apps/web/app/api/plays
git commit -m "feat: create reviewable play models with restartable jobs"
```

### Task 5: Grounded study generation and My Role workbook

**Files:**
- Create: `packages/domain/src/study.ts`
- Create: `packages/ai/src/study/port.ts`
- Create: `packages/ai/src/study/openai-study.ts`
- Create: `packages/ai/src/study/fake-study.ts`
- Create: `apps/worker/src/jobs/generate-study.ts`
- Create: `packages/db/src/repositories/study.ts`
- Create: `apps/web/app/api/plays/[playId]/my-role/route.ts`
- Test: `packages/domain/src/study.test.ts`
- Test: `apps/worker/src/jobs/generate-study.test.ts`

**Interfaces:**
- Consumes: approved `PlayModel` and stable element IDs.
- Produces: `StudyArtifact`, `GroundedClaim`, `RoleWorkbook`, and `StudyRepository` scoped methods.

- [ ] **Step 1: Write failing grounding tests**

```ts
export type GroundedClaim = {
  id: string;
  text: string;
  epistemicStatus: "explicit" | "interpretation";
  reference: ScriptReference | null;
};

it("requires explicit claims to cite existing elements", () => {
  expect(() => validateStudyArtifact(artifactWithMissingElement, play)).toThrow("UNKNOWN_SCRIPT_REFERENCE");
});

it("allows uncited interpretation only when labeled", () => {
  expect(validateStudyArtifact({ claims: [{ id: "c1", text: "A playable choice", epistemicStatus: "interpretation", reference: null }] }, play)).toBeDefined();
});
```

- [ ] **Step 2: Run grounding tests and confirm failure**

Run: `pnpm vitest packages/domain/src/study.test.ts --run`  
Expected: FAIL because study contracts and validation are absent.

- [ ] **Step 3: Implement whole-play and scene study generation**

Generate separate artifacts for overview, themes, dramatic structure, characters, relationships, and each scene. Require every `explicit` claim to cite existing element IDs. Persist prompt version, model name, Play Model version, and generation timestamp. If validation fails twice, expose `completed_with_limitations` and omit the invalid section rather than inventing references.

- [ ] **Step 4: Implement My Role generation**

`POST /api/plays/:playId/my-role` accepts `{ characterId, directorConcept?: string }`. Validate that the character exists. Generate circumstances, relationships, super-objective options, scene objectives, obstacles, stakes, tactics, entrance/exit states, beats, subtext options, and referenced stage directions. Preserve actor notes separately so regeneration never overwrites them.

- [ ] **Step 5: Verify grounded generation with fakes**

Run: `pnpm vitest packages/domain packages/ai apps/worker/src/jobs/generate-study.test.ts apps/web/app/api/plays --run`  
Expected: all grounding, invalid-reference, regeneration, and note-preservation tests pass.

- [ ] **Step 6: Commit study generation**

```bash
git add packages/domain/src/study.ts packages/ai/src/study apps/worker/src/jobs/generate-study.ts packages/db/src/repositories/study.ts apps/web/app/api/plays
git commit -m "feat: generate grounded play and role study artifacts"
```

### Task 6: Study workspace, contextual tutor, and Plan 1 acceptance flow

**Files:**
- Create: `apps/web/app/plays/page.tsx`
- Create: `apps/web/app/plays/[playId]/layout.tsx`
- Create: `apps/web/app/plays/[playId]/overview/page.tsx`
- Create: `apps/web/app/plays/[playId]/characters/page.tsx`
- Create: `apps/web/app/plays/[playId]/scenes/[sceneId]/page.tsx`
- Create: `apps/web/app/plays/[playId]/my-role/page.tsx`
- Create: `apps/web/components/study/study-nav.tsx`
- Create: `apps/web/components/study/grounded-claim.tsx`
- Create: `apps/web/components/study/tutor-panel.tsx`
- Create: `apps/web/app/api/plays/[playId]/tutor/route.ts`
- Create: `packages/ai/src/tutor/port.ts`
- Create: `packages/ai/src/tutor/openai-tutor.ts`
- Test: `apps/web/components/study/grounded-claim.test.tsx`
- Test: `apps/web/app/api/plays/[playId]/tutor/route.test.ts`
- Test: `tests/e2e/plan-1-study-flow.spec.ts`
- Test: `tests/e2e/cross-user-access.spec.ts`

**Interfaces:**
- Consumes: owner-scoped play/study repositories and `GroundedClaim`.
- Produces: complete study UI and `POST /api/plays/:playId/tutor` returning `{ answer, claims }`.

- [ ] **Step 1: Write failing component and tutor tests**

```tsx
it("shows interpretation separately from script evidence", () => {
  render(<GroundedClaim claim={{ id: "c1", text: "He may be concealing fear.", epistemicStatus: "interpretation", reference: null }} />);
  expect(screen.getByText("Interpretation")).toBeVisible();
});
```

Tutor tests require selected passage IDs to belong to the requested play and reject another owner’s play with `404`.

- [ ] **Step 2: Run UI and tutor tests and confirm failures**

Run: `pnpm vitest apps/web/components/study apps/web/app/api/plays --run`  
Expected: FAIL because study components and tutor endpoint do not exist.

- [ ] **Step 3: Implement the three-area study workspace**

At desktop widths, render left navigation, main content, and tutor panel. At 1024–1199 px, collapse the tutor into a drawer while retaining left navigation. Reference chips open the original passage and display act, scene, stable line ID, and source page when available.

- [ ] **Step 4: Implement contextual tutor retrieval**

Accept `{ question, context: { sceneId?: string, characterId?: string, elementIds?: string[] } }`. Load only the owner’s approved Play Model plus the selected context and relevant study artifacts. Require returned claims to use the same grounding validator as generated study. Return “The script does not establish this” when evidence is insufficient.

- [ ] **Step 5: Write the end-to-end acceptance flows**

The main Playwright test must: accept an invite, sign in, paste the purpose-written play, review one parser issue, approve it, open overview, select My Role, ask a passage question, and navigate to a scene. The cross-user test creates two users and proves every play, source, study, and tutor URL belonging to user A returns `404` for user B.

- [ ] **Step 6: Run the complete Plan 1 gate**

Run: `pnpm typecheck && pnpm test && pnpm test:e2e`  
Expected: all unit, integration, component, worker, and Playwright tests pass; no provider credential is required.

- [ ] **Step 7: Commit the study vertical slice**

```bash
git add apps/web packages/ai/src/tutor tests/e2e
git commit -m "feat: deliver grounded stage play study workspace"
```

- [ ] **Step 8: Run an opt-in provider smoke test**

With `OPENAI_API_KEY` set, run: `pnpm smoke:provider fixtures/plays/two-scene-play.txt`  
Expected: parser and study artifacts validate against their Zod schemas; every explicit claim references an existing element. Record model IDs and latency in `artifacts/provider-smoke/plan-1.json`, which remains gitignored.
