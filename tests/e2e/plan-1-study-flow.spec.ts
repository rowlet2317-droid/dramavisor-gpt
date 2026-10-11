import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "./fixtures";

const password = "correct horse battery staple";

test("actor completes the Plan 1 journey in the running web app", async ({ page, context }) => {
  await page.goto("/invite/flow-invite");
  await page.getByLabel("Choose a password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/$/);

  await context.clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("flow@example.com");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/plays$/);

  await page.goto("/plays/new");
  await page.getByRole("button", { name: "Paste text" }).click();
  const script = await readFile(resolve(process.cwd(), "fixtures/plays/two-scene-play.txt"), "utf8");
  await page.getByLabel("Script text").fill(script);
  await page.getByRole("button", { name: "Add play" }).click();
  await page.getByRole("link", { name: "Review parser issues" }).click();

  await expect(page.getByRole("heading", { name: /Review THE FIRST STEP/ })).toBeVisible();
  const boundaryCandidates = page.getByRole("radio", { name: /Split before/ });
  await expect(boundaryCandidates).toHaveCount(2);
  const firstCandidate = page.getByRole("radio", { name: /We continue/ });
  expect(await firstCandidate.inputValue()).toContain(":v1:element:3");
  await firstCandidate.check();
  await page.getByLabel("New scene title").fill("Middle beat");
  const firstBoundary = await saveBoundary(page);
  expect(firstBoundary.status()).toBe(200);
  await expect(page.getByText("Version 2.")).toBeVisible();

  const movedCandidate = page.getByRole("radio", { name: /Until the end/ });
  await expect(movedCandidate).toBeVisible();
  expect(await movedCandidate.inputValue()).toContain(":v2:element:4");
  await expect(page.getByRole("radio", { name: /Split before/ })).toHaveCount(1);
  await movedCandidate.check();
  await page.getByLabel("New scene title").fill("Final beat");
  const secondBoundary = await saveBoundary(page);
  expect(secondBoundary.status()).toBe(200);
  await expect(page.getByText("Version 3.")).toBeVisible();

  await page.getByLabel(/Correct passage/).fill("We begin.");
  await page.getByLabel(/Assign dialogue owner/).selectOption({ label: "Morgan" });
  const [approval] = await Promise.all([
    page.waitForResponse((response) => response.url().includes("/review") && response.request().method() === "PATCH"),
    page.getByRole("button", { name: "Approve corrected play" }).click(),
  ]);
  expect(approval.status()).toBe(200);
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole("heading", { name: "Understand the whole play" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Relationships" })).toBeVisible();

  await page.getByRole("link", { name: "Explore overview" }).click();
  await expect(page.getByRole("heading", { name: "Overview", exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Play analysis" }).click();

  await page.getByRole("link", { name: "Characters", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Characters" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Explore what the script establishes" })).toBeVisible();

  await page.getByRole("link", { name: "My Role", exact: true }).click();
  await page.getByRole("link", { name: "Alex" }).click();
  await page.getByRole("button", { name: "Build or refresh workbook" }).click();
  await expect(page.getByRole("heading", { name: "Alex" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Given circumstances" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Rehearse with AI" })).toBeVisible();
  const rehearsalLinks = page.locator(".rehearsal-links .button-link");
  await expect(rehearsalLinks).toHaveCount(2);
  const [firstRehearsal, secondRehearsal] = await Promise.all([
    rehearsalLinks.nth(0).boundingBox(), rehearsalLinks.nth(1).boundingBox(),
  ]);
  expect(firstRehearsal).not.toBeNull();
  expect(secondRehearsal).not.toBeNull();
  expect(secondRehearsal!.y).toBeGreaterThanOrEqual(firstRehearsal!.y + firstRehearsal!.height + 10);

  await page.getByRole("link", { name: "Explore given circumstances" }).click();
  await expect(page.getByRole("heading", { name: "Given circumstances", exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Alex's workbook" }).click();

  await page.getByRole("link", { name: "A1 · S1 Scene One", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scene One" })).toBeVisible();
  await page.getByRole("link", { name: "Ask about this passage" }).first().click();
  await expect(page).toHaveURL(/elementId=/);
  const tutor = page.getByRole("complementary", { name: "Contextual script tutor" });
  await tutor.getByLabel("Your question").fill("What is Alex doing in this passage?");
  const [tutorResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith(`/api/plays/${playIdFromUrl(page.url())}/tutor`)),
    tutor.getByRole("button", { name: "Ask" }).click(),
  ]);
  expect(tutorResponse.status()).toBe(200);
  await expect(tutor.getByText("Alex initiates the exchange.")).toBeVisible();
  await expect(tutor.getByText("Script evidence")).toBeVisible();
  await expect(page.locator(":target")).toContainText("We begin.");
});

async function saveBoundary(page: import("@playwright/test").Page) {
  const responsePromise = page.waitForResponse((response) => (
    response.url().includes("/review") && response.request().method() === "PATCH"
  ));
  await page.getByRole("button", { name: "Save selected boundary" }).click();
  const response = await responsePromise;
  await page.waitForLoadState("domcontentloaded");
  return response;
}

function playIdFromUrl(url: string): string {
  const playId = new URL(url).pathname.match(/\/plays\/([^/]+)/)?.[1];
  if (!playId) throw new Error(`Play id is missing from ${url}`);
  return playId;
}
