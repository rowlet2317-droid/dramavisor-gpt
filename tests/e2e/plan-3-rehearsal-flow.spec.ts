import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "./fixtures";

const password = "correct horse battery staple";

test.setTimeout(120_000);

test("actor completes a deterministic realtime rehearsal with stable voices and controls", async ({ page }) => {
  await page.goto("/invite/plan3-rehearsal-invite");
  await page.getByLabel("Choose a password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/$/);
  await page.goto("/plays/new");
  await page.getByRole("button", { name: "Paste text" }).click();
  await page.getByLabel("Script text").fill(await readFile(
    resolve(process.cwd(), "fixtures/plays/two-scene-play.txt"), "utf8",
  ));
  await page.getByRole("button", { name: "Add play" }).click();
  await page.getByRole("link", { name: "Review parser issues" }).click();
  await page.getByRole("radio", { name: /We continue/ }).check();
  await page.getByLabel("New scene title").fill("Middle beat"); await saveBoundary(page);
  await page.getByRole("radio", { name: /Until the end/ }).check();
  await page.getByLabel("New scene title").fill("Final beat"); await saveBoundary(page);
  await page.getByLabel(/Correct passage/).fill("We begin now.");
  await page.getByLabel(/Assign dialogue owner/).selectOption({ label: "Morgan" });
  await page.getByRole("button", { name: "Approve corrected play" }).click();
  await page.waitForURL(/\/overview$/);

  const playId = new URL(page.url()).pathname.split("/")[2]!;
  const sceneHref = await page.getByRole("link", { name: /A1 · S1/ }).getAttribute("href");
  expect(sceneHref).toBeTruthy();
  const actorRoleId = `${playId}:v4:character:2`;
  await page.goto(`${sceneHref}/rehearse?actorRoleId=${encodeURIComponent(actorRoleId)}`);
  await expect(page.getByRole("heading", { name: "Rehearse Scene One" })).toBeVisible();
  await expect(page.getByText("We begin now.")).toBeVisible();

  await page.getByLabel("Record for coaching").check();
  await page.getByRole("button", { name: "Start rehearsal" }).click();
  await expect(page.getByRole("button", { name: "Speak actor line" })).toBeVisible();
  await expect(page.getByText("Your line is hidden. Ask for a cue when you need it.")).toBeVisible();
  await page.getByRole("button", { name: "Cue" }).click();
  await expect(page.getByText("At the beginning.")).toBeVisible();

  await page.getByRole("button", { name: "Restart beat" }).click();
  await expect(page.getByRole("list", { name: "Rehearsal line order" }).getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Speak actor line" })).toBeVisible();
  await page.getByRole("button", { name: "Speak actor line" }).click();
  await expect(page.getByText("Scene complete. Stop and save when you are ready.")).toBeVisible();

  const timeline = page.getByRole("list", { name: "Rehearsal line order" }).getByRole("listitem");
  await expect(timeline).toHaveCount(3);
  expect(await timeline.nth(0).getAttribute("data-element-id")).toBe(await timeline.nth(1).getAttribute("data-element-id"));
  expect(await timeline.nth(0).getAttribute("data-voice")).toBe(await timeline.nth(1).getAttribute("data-voice"));
  await expect(timeline.nth(2)).toContainText("Morgan — You: At the beginning.");
  await page.getByRole("button", { name: "Stop rehearsal" }).click();
  await expect(page.getByText(/Connection: stopped/)).toBeVisible();
  await page.getByRole("link", { name: "Open queued coaching take" }).click();
  await expect(page.getByRole("heading", { name: "Coaching report" })).toBeVisible();
});

async function saveBoundary(page: import("@playwright/test").Page): Promise<void> {
  const responsePromise = page.waitForResponse((response) => (
    response.url().includes("/review") && response.request().method() === "PATCH"
  ));
  await page.getByRole("button", { name: "Save selected boundary" }).click();
  expect((await responsePromise).status()).toBe(200);
  await page.waitForLoadState("domcontentloaded");
}
