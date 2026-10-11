import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function readDocument(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("prototype documentation", () => {
  it("documents the complete local setup contract", async () => {
    const guide = await readDocument("docs/LOCAL_SETUP.md");

    for (const variable of [
      "DATABASE_URL",
      "APP_URL",
      "OPENAI_API_KEY",
      "ANALYSIS_MODEL",
      "S3_PRIVATE_BUCKET",
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_ENDPOINT_URL_S3",
      "WORKER_POLL_MS",
      "OCR_ENDPOINT",
      "OCR_API_KEY",
      "COACHING_MODEL",
      "REALTIME_MODEL",
      "REALTIME_CLIENT_SECRET_TTL_SECONDS",
      "TTS_MODEL",
      "OPERATIONAL_EVENT_SALT",
    ]) expect(guide).toContain(variable);

    for (const command of [
      "pnpm install --frozen-lockfile",
      "pnpm db:migrate",
      "pnpm dev",
      "pnpm --filter @drama/worker start",
      "pnpm create-invite -- --email actor@example.com",
      "pnpm smoke:provider fixtures/plays/two-scene-play.txt",
      "pnpm smoke:realtime",
    ]) expect(guide).toContain(command);

    expect(guide).not.toContain("drizzle-kit migrate");
    const rootManifest = JSON.parse(await readDocument("package.json")) as { scripts: Record<string, string> };
    const webManifest = JSON.parse(await readDocument("apps/web/package.json")) as { scripts: Record<string, string> };
    const databaseManifest = JSON.parse(await readDocument("packages/db/package.json")) as {
      scripts: Record<string, string>;
    };
    expect(webManifest.scripts.dev).toBe("node scripts/clean-dev-cache.mjs && next dev --webpack");
    expect(rootManifest.scripts["db:migrate"]).toBe("pnpm --filter @drama/db migrate");
    expect(databaseManifest.scripts.migrate).toBe("node --import tsx ../../scripts/migrate.ts");

    expect(guide).toContain("corepack prepare pnpm@11.18.0 --activate");
    expect(guide).toContain("Never commit `.env.local`");
    expect(guide).toContain("Open `http://localhost:3000` in your browser");
    expect(guide).toContain("Structured Outputs");
    expect(guide).toContain("language=eng");
    expect(guide).toContain("page=N");
    expect(guide).toContain('{ "text": "..." }');
  });

  it("documents every implemented actor workflow and the Plan 3 boundaries", async () => {
    const manual = await readDocument("docs/USER_MANUAL.md");
    for (const label of [
      "Add a play",
      "Review parser issues",
      "Save selected boundary",
      "Approve corrected play",
      "Overview",
      "Characters",
      "My Role",
      "Ask about this passage",
      "The script does not establish this",
      "Practice",
      "Open guided exercise",
      "Repeat a line",
      "Open interactive rehearsal",
      "Start rehearsal",
      "Pause",
      "Resume",
      "Cue",
      "Restart beat",
      "Stop rehearsal",
    ]) expect(manual).toContain(label);

    for (const futureFeature of [
      "camera analysis",
      "cast voice cloning",
      "external-provider measurements",
      "ten-actor usefulness study",
    ]) expect(manual.toLowerCase()).toContain(futureFeature);

    expect(manual).toContain("takes you to the home page");
    expect(manual).toContain("then select **Open your plays**");
  });

  it("links both guides and reports the implemented Plan 3 scope", async () => {
    const readme = await readDocument("README.md");
    expect(readme).toContain("[Local setup](docs/LOCAL_SETUP.md)");
    expect(readme).toContain("[User manual](docs/USER_MANUAL.md)");
    expect(readme).toContain("Plans 1–3 are implemented and merged");
    expect(readme).toContain("private recorded takes with evidence-linked coaching");
    expect(readme).toContain("browser-based real-time scene rehearsal");
    expect(readme).toContain("External-provider measurements and the ten-actor usefulness study are still pending");
  });
});
