import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "./fixtures";

const password = "correct horse battery staple";

test.setTimeout(120_000);

test("bounds reconnect after line 2, then completes with scripted voices without duplicate dialogue", async ({ page }) => {
  await page.goto("/invite/plan3-reconnect-invite");
  await page.getByLabel("Choose a password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/$/);
  await page.goto("/plays/new");
  await page.getByRole("button", { name: "Paste text" }).click();
  await page.getByLabel("Script text").fill(await readFile(
    resolve(process.cwd(), "fixtures/plays/reconnect-fallback-play.txt"), "utf8",
  ));
  await page.getByRole("button", { name: "Add play" }).click();
  await page.getByRole("link", { name: "Review parser issues" }).click();
  await page.getByRole("radio", { name: /Bridge to recovery/ }).check();
  await page.getByLabel("New scene title").fill("Middle beat"); await saveBoundary(page);
  await page.getByRole("radio", { name: /The fallback begins/ }).check();
  await page.getByLabel("New scene title").fill("Recovery beat"); await saveBoundary(page);
  await page.getByLabel(/Correct passage/).fill("We begin now.");
  await page.getByLabel(/Assign dialogue owner/).selectOption({ label: "Morgan" });
  await page.getByRole("button", { name: "Approve corrected play" }).click();
  await page.waitForURL(/\/overview$/);

  const playId = new URL(page.url()).pathname.split("/")[2]!;
  const sceneHref = await page.getByRole("link", { name: /A1 · S3/ }).getAttribute("href");
  expect(sceneHref).toBeTruthy();
  const actorRoleId = `${playId}:v4:character:2`;
  const resumeGrants: string[] = [];
  page.on("response", async (response) => {
    if (response.url().includes("/resume") && response.request().method() === "POST") {
      const body = await response.json() as { grant: { clientSecret: string } };
      resumeGrants.push(body.grant.clientSecret);
    }
  });
  await page.goto(`${sceneHref}/rehearse?actorRoleId=${encodeURIComponent(actorRoleId)}&reconnectTest=1`);
  await page.getByRole("button", { name: "Start rehearsal" }).click();
  await expect(page.getByRole("button", { name: "Speak actor line" })).toBeVisible();

  await page.getByRole("button", { name: "Speak actor line" }).click();
  await expect(page.getByRole("button", { name: "Continue with Scripted Voices" })).toBeVisible();
  expect(resumeGrants).toHaveLength(3);
  expect([...new Set(resumeGrants)]).toHaveLength(3);
  await page.getByRole("button", { name: "Continue with Scripted Voices" }).click();
  await expect(page.getByText("Scene complete. Stop and save when you are ready.")).toBeVisible();

  const timeline = page.getByRole("list", { name: "Rehearsal line order" }).getByRole("listitem");
  await expect(timeline).toHaveCount(3);
  expect(await timeline.nth(0).getAttribute("data-element-id")).not.toBe(await timeline.nth(1)
    .getAttribute("data-element-id"));
  expect(await timeline.nth(1).getAttribute("data-element-id")).not.toBe(await timeline.nth(2)
    .getAttribute("data-element-id"));
  await page.getByRole("button", { name: "Stop rehearsal" }).click();
  await page.reload();
  await expect(page.getByRole("list", { name: "Rehearsal line order" }).getByRole("listitem")).toHaveCount(3);
});

async function saveBoundary(page: import("@playwright/test").Page): Promise<void> {
  const responsePromise = page.waitForResponse((response) => (
    response.url().includes("/review") && response.request().method() === "PATCH"
  ));
  await page.getByRole("button", { name: "Save selected boundary" }).click();
  expect((await responsePromise).status()).toBe(200);
  await page.waitForLoadState("domcontentloaded");
}
