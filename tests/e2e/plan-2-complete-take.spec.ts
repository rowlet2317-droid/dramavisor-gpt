import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "./fixtures";

const password = "correct horse battery staple";

test.setTimeout(120_000);

test("actor uploads two complete takes, replays evidence, and sees a comparable delta", async ({ page }) => {
  await page.goto("/invite/plan2-invite");
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
  await page.getByLabel("New scene title").fill("Middle beat");
  await saveBoundary(page);
  await page.getByRole("radio", { name: /Until the end/ }).check();
  await page.getByLabel("New scene title").fill("Final beat");
  await saveBoundary(page);
  await page.getByLabel(/Correct passage/).fill("We begin now.");
  await page.getByLabel(/Assign dialogue owner/).selectOption({ label: "Morgan" });
  await page.getByRole("button", { name: "Approve corrected play" }).click();
  await page.waitForURL(/\/overview$/);

  const playId = new URL(page.url()).pathname.split("/")[2]!;
  const sceneHref = await page.getByRole("link", { name: /A1 · S1/ }).getAttribute("href");
  expect(sceneHref).toBeTruthy();
  const sceneId = decodeURIComponent(sceneHref!.split("/").at(-1)!);
  const roleId = `${playId}:v4:character:1`;
  await page.goto(`${sceneHref}/practice`);
  await expect(page.getByRole("heading", { name: /Practice Scene One/ })).toBeVisible();

  const firstTakeId = await uploadTake(page, playId, sceneId, roleId, "The request is disguised as a joke.");
  await page.goto(`/plays/${playId}/takes/${firstTakeId}`);
  await expect(page.getByRole("heading", { name: "Coaching report" })).toBeVisible();
  await expect(page.getByText("The thought remains connected.")).toBeVisible();
  const priorities = page.getByRole("heading", { name: "Priorities" }).locator("..").getByRole("listitem");
  expect(await priorities.count()).toBeLessThanOrEqual(3);
  const replay = page.getByRole("button", { name: "Play evidence" }).first();
  await expect(replay).toBeVisible();
  await replay.click();

  const secondTakeId = await uploadTake(page, playId, sceneId, roleId, "The request is disguised as a joke.");
  await page.goto(`/plays/${playId}/takes/${secondTakeId}`);
  await expect(page.getByRole("heading", { name: "Compared with your previous take" })).toBeVisible();
  await expect(page.getByText("67 → 100")).toBeVisible();
  await expect(page.getByText("+33")).toBeVisible();
});

async function uploadTake(page: import("@playwright/test").Page, playId: string, sceneId: string,
  roleId: string, selectedInterpretation: string): Promise<string> {
  const response = await page.request.post(`/api/plays/${playId}/takes`, { multipart: {
    audio: { name: "complete-take.wav", mimeType: "audio/wav", buffer: Buffer.from(fixtureWav()) },
    playModelVersion: "4",
    sceneId,
    roleId,
    selectedInterpretation,
    retentionChoice: "retain",
  } });
  expect(response.status()).toBe(202);
  const body = await response.json() as { take: { id: string } };
  return body.take.id;
}

async function saveBoundary(page: import("@playwright/test").Page): Promise<void> {
  const responsePromise = page.waitForResponse((response) => (
    response.url().includes("/review") && response.request().method() === "PATCH"
  ));
  await page.getByRole("button", { name: "Save selected boundary" }).click();
  expect((await responsePromise).status()).toBe(200);
  await page.waitForLoadState("domcontentloaded");
}

function fixtureWav(): Uint8Array {
  const sampleRate = 16_000;
  const samples = Int16Array.from({ length: sampleRate }, (_, index) =>
    Math.round(8_192 * Math.sin(2 * Math.PI * 220 * index / sampleRate)));
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  bytes.set([82, 73, 70, 70], 0); view.setUint32(4, bytes.length - 8, true); bytes.set([87, 65, 86, 69], 8);
  bytes.set([102, 109, 116, 32], 12); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); bytes.set([100, 97, 116, 97], 36);
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return bytes;
}
