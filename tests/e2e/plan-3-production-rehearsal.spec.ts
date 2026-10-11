import { expect, installProductionProviderBrowserFixture, test } from "./fixtures";

const password = "correct horse battery staple";
const productionPlay = `THE FULL COMPANY

ALPHA: Opening cue.
MORGAN: Opening answer.
BETA: Boundary cue.
ALPHA: First live cue.
MORGAN: First live answer.
ALPHA: Second live cue.
MORGAN: Second live answer.
BETA: Third live cue.
MORGAN: Third live answer.
GAMMA: Fourth live cue.
MORGAN: Fourth live answer.
DELTA: Fifth live cue.
MORGAN: Fifth live answer.
ECHO: Overflow cue.
MORGAN: Overflow answer.
ALPHA: Fallback cue.
MORGAN: Fallback answer.`;

test.setTimeout(180_000);

test("uses production browser sessions, acknowledged persistence, recovery, fallback, and linked coaching", async ({ page }) => {
  // Break caught: E2E mode must not bypass the production ActorInputSession, RoleVoiceSessionPool,
  // RemoteAudioSink, command queue, reducer, API persistence, or recovery/fallback composition.
  const roleGrantRequests: string[] = [];
  const speechRequests: string[] = [];
  const persistedEventRequests: Array<{ sequence: number; type: string; text?: string }> = [];
  const persistedEventResponses: Array<{ type: string; status: number }> = [];
  let assignments: Array<{ characterId: string; voice: string; engine: "realtime" | "tts" }> = [];
  await installProductionProviderBrowserFixture(page);
  const fallbackRequestReached = Promise.withResolvers<void>();
  let releaseFallbackResponse: () => void = () => undefined;
  const fallbackResponseReleased = new Promise<void>((resolve) => { releaseFallbackResponse = resolve; });
  await page.route(/\/api\/rehearsals\/[^/]+\/events$/, async (route) => {
    const body = route.request().postDataJSON() as { event?: { type?: string } };
    if (body.event?.type !== "fallback_selected") return route.continue();
    const response = await route.fetch();
    fallbackRequestReached.resolve();
    await fallbackResponseReleased;
    await route.fulfill({ response });
  });
  page.on("request", (request) => {
    if (request.url().endsWith("/api/realtime/session") && request.method() === "POST") {
      const body = request.postDataJSON() as { type?: string; roleId?: string };
      if (body.type === "role_output" && body.roleId) roleGrantRequests.push(body.roleId);
    }
    if (/\/api\/rehearsals\/[^/]+\/speech$/.test(new URL(request.url()).pathname)
      && request.method() === "POST") speechRequests.push(request.postData() ?? "");
    if (/\/api\/rehearsals\/[^/]+\/events$/.test(new URL(request.url()).pathname)
      && request.method() === "POST") {
      const body = request.postDataJSON() as { event?: { sequence?: number; type?: string; text?: string } };
      persistedEventRequests.push({ sequence: body.event?.sequence ?? -1, type: body.event?.type ?? "unknown",
        text: body.event?.text });
    }
  });
  page.on("response", async (response) => {
    if (response.url().endsWith("/api/realtime/session") && response.request().method() === "POST") {
      const request = response.request().postDataJSON() as { type?: string };
      if (request.type === "start" && response.ok()) {
        assignments = (await response.json() as { assignments: typeof assignments }).assignments;
      }
    }
    if (/\/api\/rehearsals\/[^/]+\/events$/.test(new URL(response.url()).pathname)
      && response.request().method() === "POST") {
      const body = response.request().postDataJSON() as { event?: { type?: string } };
      persistedEventResponses.push({ type: body.event?.type ?? "unknown", status: response.status() });
    }
  });

  await page.goto("/invite/plan3-production-invite");
  await page.getByLabel("Choose a password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/$/);
  await page.goto("/plays/new");
  await page.getByRole("button", { name: "Paste text" }).click();
  await page.getByLabel("Script text").fill(productionPlay);
  await page.getByRole("button", { name: "Add play" }).click();
  await page.getByRole("link", { name: "Review parser issues" }).click();
  await page.getByRole("radio", { name: /Boundary cue/ }).check();
  await page.getByLabel("New scene title").fill("Boundary beat");
  await saveBoundary(page);
  await page.getByRole("radio", { name: /First live cue/ }).check();
  await page.getByLabel("New scene title").fill("Production beat");
  await saveBoundary(page);
  await page.getByLabel(/Correct passage/).fill("Opening cue.");
  await page.getByLabel(/Assign dialogue owner/).selectOption({ label: "Morgan" });
  await page.getByRole("button", { name: "Approve corrected play" }).click();
  await page.waitForURL(/\/overview$/);

  const playId = new URL(page.url()).pathname.split("/")[2]!;
  const sceneHref = await page.getByRole("link", { name: /A1 · S3/ }).getAttribute("href");
  expect(sceneHref).toBeTruthy();
  const actorRoleId = `${playId}:v4:character:2`;
  await page.goto(`${sceneHref}/rehearse?actorRoleId=${encodeURIComponent(actorRoleId)}&productionE2e=1`);
  await expect(page.getByRole("heading", { name: "Rehearse Production beat" })).toBeVisible();
  expect(await providerMetric(page, "microphoneRequests")).toBe(0);

  await page.getByLabel("Record for coaching").check();
  await page.getByRole("button", { name: "Start rehearsal" }).click();
  await expect(page.getByText(/Connection: connected/)).toBeVisible();
  await expect.poll(() => providerMetric(page, "remoteTrackAttachments")).toBeGreaterThan(0);
  await expect.poll(() => providerMetric(page, "audioPlayCalls")).toBeGreaterThan(0);
  expect(await providerMetric(page, "microphoneRequests")).toBe(2);
  expect(assignments.filter(({ engine }) => engine === "realtime")).toHaveLength(4);
  expect(assignments.filter(({ engine }) => engine === "tts")).toHaveLength(1);

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeEnabled();
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeEnabled();
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeEnabled();
  expect(await providerMetric(page, "enabledActorInputTracks")).toBe(0);
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeEnabled();
  expect(await providerMetric(page, "enabledActorInputTracks")).toBeGreaterThan(0);
  await completeActiveRole(page);
  await emitActorTranscript(page, "First live answer.", "actor-1");
  await expect.poll(() => persistedEventRequests.filter(({ type }) => type === "actor_line_final").length)
    .toBeGreaterThan(0);
  const renderedTranscript = page.getByRole("list", { name: "Rehearsal line order" }).getByRole("listitem")
    .filter({ hasText: "First live answer." });
  await expect(renderedTranscript).toHaveCount(1);
  expect(persistedEventRequests.find(({ type }) => type === "actor_line_final")?.text)
    .toBe("First live answer.");

  await expect.poll(() => providerMetric(page, "activeRoleResponses")).toBe(1);
  await emitActorSpeechStarted(page);
  await expect(page.getByRole("button", { name: "Restart line" })).toBeEnabled();
  await page.getByRole("button", { name: "Restart line" }).click();
  await expect.poll(() => providerMetric(page, "activeRoleResponses")).toBe(1);
  await completeActiveRole(page);
  await emitActorTranscript(page, "Second live answer.", "actor-2");

  for (const [cue, answer, itemId] of [
    ["Third live cue.", "Third live answer.", "actor-3"],
    ["Fourth live cue.", "Fourth live answer.", "actor-4"],
    ["Fifth live cue.", "Fifth live answer.", "actor-5"],
  ] as const) {
    await expect(page.getByText(cue, { exact: true })).toBeVisible();
    await expect.poll(() => providerMetric(page, "activeRoleResponses")).toBe(1);
    await completeActiveRole(page);
    await emitActorTranscript(page, answer, itemId);
  }

  await expect(page.getByText("Overflow cue.", { exact: true })).toBeVisible();
  await expect.poll(() => speechRequests.length).toBe(1);
  const providerRequests = await providerRoleRequests(page);
  expect(providerRequests).toHaveLength(8);
  // Pause/Resume replays the first cue twice; Restart line replays the interrupted second cue once.
  const pinnedProviderTexts = [
    "Speak this exact scripted text without paraphrasing: First live cue.",
    "Speak this exact scripted text without paraphrasing: First live cue.",
    "Speak this exact scripted text without paraphrasing: First live cue.",
    "Speak this exact scripted text without paraphrasing: Second live cue.",
    "Speak this exact scripted text without paraphrasing: Second live cue.",
    "Speak this exact scripted text without paraphrasing: Third live cue.",
    "Speak this exact scripted text without paraphrasing: Fourth live cue.",
    "Speak this exact scripted text without paraphrasing: Fifth live cue.",
  ] as const;
  expect(providerRequests.map(({ exactText }) => exactText)).toEqual(pinnedProviderTexts);
  for (const request of providerRequests) {
    expect(pinnedProviderTexts).toContain(request.exactText);
    expect(request.direction).toContain("Use only the exact supplied script text; never invent or paraphrase dialogue.");
    expect(request.direction.length).toBeGreaterThan(0);
    expect(request.direction.length).toBeLessThanOrEqual(300);
  }
  const currentScriptCard = page.getByRole("region", { name: "Rehearsal script position" })
    .locator('article[aria-current="step"]');
  await expect(currentScriptCard.getByText("Morgan", { exact: true })).toBeVisible();
  expect(persistedEventResponses.filter(({ type }) => type.startsWith("ai_speech_")).slice(-2)).toEqual([
    { type: "ai_speech_started", status: 201 },
    { type: "ai_speech_finished", status: 201 },
  ]);
  expect(roleGrantRequests).toHaveLength(4);
  expect(new Set(roleGrantRequests).size).toBe(4);

  const timeline = page.getByRole("list", { name: "Rehearsal line order" }).getByRole("listitem");
  const alphaLines = timeline.filter({ hasText: "Alpha —" });
  await expect(alphaLines).toHaveCount(5);
  const alphaVoice = await alphaLines.nth(0).getAttribute("data-voice");
  expect(await alphaLines.nth(1).getAttribute("data-voice")).toBe(alphaVoice);
  expect(await alphaLines.nth(2).getAttribute("data-voice")).toBe(alphaVoice);
  expect(await alphaLines.nth(3).getAttribute("data-voice")).toBe(alphaVoice);
  expect(await alphaLines.nth(4).getAttribute("data-voice")).toBe(alphaVoice);
  expect(roleGrantRequests.filter((roleId) => roleId === roleGrantRequests[0])).toHaveLength(1);

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(currentScriptCard.getByText("Morgan", { exact: true })).toBeVisible();
  expect(await failActorAndNextReconnects(page, 3)).toBe(3);
  await expect(page.getByRole("button", { name: "Continue with Scripted Voices" })).toBeVisible();
  const fallbackAcknowledgement = page.waitForResponse((response) => {
    if (!/\/api\/rehearsals\/[^/]+\/events$/.test(new URL(response.url()).pathname)) return false;
    const body = response.request().postDataJSON() as { event?: { type?: string } };
    return body.event?.type === "fallback_selected";
  });
  const sequenceBeforeFallback = await page.getByText(/Connection: disconnected.*Sequence/).textContent();
  expect(sequenceBeforeFallback).toMatch(/Sequence \d+/);
  await page.getByRole("button", { name: "Continue with Scripted Voices" }).click();
  await fallbackRequestReached.promise;
  await expect(currentScriptCard.locator("strong")).toHaveText("Morgan");
  await expect(page.getByText(/Connection: disconnected.*Sequence/)).toHaveText(sequenceBeforeFallback!);
  await expect(page.getByRole("button", { name: "Line complete" })).toHaveCount(0);
  releaseFallbackResponse();
  expect((await fallbackAcknowledgement).status()).toBe(201);
  expect(await currentScriptCard.locator("strong").textContent(), JSON.stringify(persistedEventRequests))
    .toBe("Morgan");
  await expect(page.getByRole("button", { name: "Line complete" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Line complete" }).click();
  await expect.poll(() => speechRequests.length).toBe(2);
  await page.getByRole("button", { name: "Line complete" }).click();
  await expect(page.getByText("Scene complete. Stop and save when you are ready.")).toBeVisible();

  await page.getByRole("button", { name: "Stop rehearsal" }).click();
  await expect(page.getByText(/Connection: stopped/)).toBeVisible();
  const coachingHref = await page.getByRole("link", { name: "Open queued coaching take" }).getAttribute("href");
  expect(coachingHref).toBeTruthy();
  const timelineCount = await timeline.count();
  await page.reload();
  await expect(page.getByRole("list", { name: "Rehearsal line order" }).getByRole("listitem"))
    .toHaveCount(timelineCount);
  await page.goto(coachingHref!);
  await expect(page.getByRole("heading", { name: "Coaching report" })).toBeVisible();
  const cueRating = page.locator("article", { hasText: "Cue responsiveness" });
  await expect(cueRating.getByText("N/A")).toHaveCount(0);
});

async function saveBoundary(page: import("@playwright/test").Page): Promise<void> {
  const responsePromise = page.waitForResponse((response) => (
    response.url().includes("/review") && response.request().method() === "PATCH"
  ));
  await page.getByRole("button", { name: "Save selected boundary" }).click();
  expect((await responsePromise).status()).toBe(200);
  await page.waitForLoadState("domcontentloaded");
}

async function providerMetric(page: import("@playwright/test").Page, key: string): Promise<number> {
  return page.evaluate((metric) => {
    const fixture = (window as unknown as { __dramaProductionProvider?: { metrics: Record<string, number> } })
      .__dramaProductionProvider;
    if (!fixture) throw new Error("Production provider browser fixture is not installed");
    return fixture.metrics[metric] ?? 0;
  }, key);
}

async function providerRoleRequests(page: import("@playwright/test").Page): Promise<Array<{
  exactText: string; direction: string;
}>> {
  return page.evaluate(() => {
    const fixture = (window as unknown as { __dramaProductionProvider?: {
      roleRequests: Array<{ exactText: string; direction: string }>;
    } }).__dramaProductionProvider;
    if (!fixture) throw new Error("Production provider browser fixture is not installed");
    return fixture.roleRequests;
  });
}

async function emitActorTranscript(page: import("@playwright/test").Page, text: string, itemId: string): Promise<void> {
  await page.evaluate(({ transcript, providerItemId }) => {
    const fixture = (window as unknown as { __dramaProductionProvider?: {
      emitActorTranscript(text: string, itemId: string): void;
    } }).__dramaProductionProvider;
    if (!fixture) throw new Error("Production provider browser fixture is not installed");
    fixture.emitActorTranscript(transcript, providerItemId);
  }, { transcript: text, providerItemId: itemId });
}

async function emitActorSpeechStarted(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const fixture = (window as unknown as { __dramaProductionProvider?: {
      emitActorSpeechStarted(): void;
    } }).__dramaProductionProvider;
    if (!fixture) throw new Error("Production provider browser fixture is not installed");
    fixture.emitActorSpeechStarted();
  });
}

async function completeActiveRole(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const fixture = (window as unknown as { __dramaProductionProvider?: { completeActiveRole(): void } })
      .__dramaProductionProvider;
    if (!fixture) throw new Error("Production provider browser fixture is not installed");
    fixture.completeActiveRole();
  });
}

async function failActorAndNextReconnects(page: import("@playwright/test").Page, attempts: number): Promise<number> {
  return await page.evaluate((failures) => {
    const fixture = (window as unknown as { __dramaProductionProvider?: {
      failActorAndNextReconnects(attempts: number): Promise<number>;
    } }).__dramaProductionProvider;
    if (!fixture) throw new Error("Production provider browser fixture is not installed");
    return fixture.failActorAndNextReconnects(failures);
  }, attempts);
}
