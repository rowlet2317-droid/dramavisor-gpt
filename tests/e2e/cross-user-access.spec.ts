import type { APIRequestContext, Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "./fixtures";

const password = "correct horse battery staple";

test.setTimeout(90_000);

test("user B receives real 404 responses for every user A URL family", async ({ page: owner }) => {
  await signInPage(owner, "owner-invite", "owner@example.com");
  const privateUrls = await createApprovedPlay(owner);
  const ownerRequest = owner.context().request;
  const ownerCookie = await cookieHeader(owner);
  await test.step("owner can load every private URL family", async () => {
    const ownerPlay = await ownerRequest.get(privateUrls.play, { headers: { cookie: ownerCookie },
      maxRedirects: 0, timeout: 15_000 });
    expect([200, 307, 308]).toContain(ownerPlay.status());
    for (const path of privateUrls.pages) await expectGet(ownerRequest, path, ownerCookie, 200);
    await expectGet(ownerRequest, privateUrls.source, ownerCookie, 200);
    await expectGet(ownerRequest, privateUrls.study, ownerCookie, 200);
    const tutor = await ownerRequest.post(privateUrls.tutor, { headers: { cookie: ownerCookie }, timeout: 15_000,
      data: { question: "What happens?", context: {
        sceneId: decodeURIComponent(privateUrls.sceneId), elementIds: [privateUrls.elementId],
      } } });
    expect(tutor.status(), privateUrls.tutor).toBe(200);
  });

  await signInPage(owner, "intruder-invite", "intruder@example.com");
  const intruderRequest = owner.context().request;
  const intruderCookie = await cookieHeader(owner);
  await test.step("intruder receives 404 from every private URL family", async () => {
    const pageUrls = [privateUrls.play, ...privateUrls.pages];
    for (const path of pageUrls) await expectGet(intruderRequest, path, intruderCookie, 404, true);
    await expectGet(intruderRequest, privateUrls.source, intruderCookie, 404);
    await expectGet(intruderRequest, privateUrls.study, intruderCookie, 404);
    const myRole = await intruderRequest.post(privateUrls.myRoleApi, {
      headers: { cookie: intruderCookie }, timeout: 15_000,
      data: { characterId: privateUrls.characterId, directorConcept: "Keep the exchange urgent" },
    });
    expect(myRole.status(), privateUrls.myRoleApi).toBe(404);
    const review = await intruderRequest.patch(privateUrls.reviewApi, {
      headers: { cookie: intruderCookie }, timeout: 15_000,
      data: { expectedModelId: "not-owned", expectedModelVersion: 1, corrections: [], approve: false },
    });
    expect(review.status(), privateUrls.reviewApi).toBe(404);
    const tutor = await intruderRequest.post(privateUrls.tutor, { headers: { cookie: intruderCookie },
      timeout: 15_000, data: {
      question: "What happens?", context: { elementIds: [privateUrls.elementId] },
    } });
    expect(tutor.status(), privateUrls.tutor).toBe(404);
  });
});

async function signInPage(page: Page, invite: string, email: string): Promise<void> {
  const context = page.context();
  await context.clearCookies();
  await page.goto(`/invite/${invite}`);
  await page.getByLabel("Choose a password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/$/);
  await context.clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/plays$/);
  await cookieHeader(page);
}

async function expectGet(request: APIRequestContext, path: string, cookie: string,
  status: number, noRedirect = false) {
  const response = await request.get(path, { headers: { cookie }, timeout: 15_000,
    ...(noRedirect ? { maxRedirects: 0 } : {}) });
  expect(response.status(), path).toBe(status);
}

async function cookieHeader(page: Page): Promise<string> {
  const cookies = await page.context().cookies("http://localhost:3100");
  expect(cookies.length).toBeGreaterThan(0);
  return cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}

async function createApprovedPlay(page: Page) {
  await page.goto("/plays/new");
  await page.getByRole("button", { name: "Paste text" }).click();
  await page.getByLabel("Script text").fill(await readFile(
    resolve(process.cwd(), "fixtures/plays/two-scene-play.txt"), "utf8",
  ));
  await page.getByRole("button", { name: "Add play" }).click();
  const reviewLink = page.getByRole("link", { name: "Review parser issues" });
  const review = await reviewLink.getAttribute("href");
  expect(review).toBeTruthy();
  await reviewLink.click();
  const source = await page.getByRole("link", { name: "Open private source" }).getAttribute("href");
  expect(source).toBeTruthy();
  await page.getByRole("radio", { name: /We continue/ }).check();
  await page.getByLabel("New scene title").fill("Middle beat");
  await saveBoundary(page);
  await page.getByRole("radio", { name: /Until the end/ }).check();
  await page.getByLabel("New scene title").fill("Final beat");
  await saveBoundary(page);
  await page.getByLabel(/Correct passage/).fill("We begin.");
  await page.getByLabel(/Assign dialogue owner/).selectOption({ label: "Morgan" });
  await page.getByRole("button", { name: "Approve corrected play" }).click();
  await page.waitForURL(/\/overview$/);
  const playId = new URL(page.url()).pathname.split("/")[2]!;
  const scene = await page.getByRole("link", { name: /A1 · S1/ }).getAttribute("href");
  expect(scene).toBeTruthy();
  await page.goto(scene!);
  const passage = await page.getByRole("link", { name: "Ask about this passage" }).first().getAttribute("href");
  expect(passage).toBeTruthy();
  const passageUrl = new URL(passage!, page.url());
  return {
    play: `/plays/${playId}`,
    pages: [
      `/plays/${playId}/overview`, `/plays/${playId}/characters`, scene!,
      `/plays/${playId}/my-role`, review!,
    ],
    source: source!, study: `/api/plays/${playId}/study`, tutor: `/api/plays/${playId}/tutor`,
    myRoleApi: `/api/plays/${playId}/my-role`, reviewApi: `/api/plays/${playId}/review`,
    characterId: `${playId}:v4:character:1`,
    sceneId: scene!.split("/").at(-1)!, elementId: passageUrl.searchParams.get("elementId")!,
  };
}

async function saveBoundary(page: Page): Promise<void> {
  const responsePromise = page.waitForResponse((response) => (
    response.url().includes("/review") && response.request().method() === "PATCH"
  ));
  await page.getByRole("button", { name: "Save selected boundary" }).click();
  expect((await responsePromise).status()).toBe(200);
  await page.waitForLoadState("domcontentloaded");
}
