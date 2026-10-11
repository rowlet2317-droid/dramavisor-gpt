import { resolve } from "node:path";

import { expect, test } from "./fixtures";

const password = "correct horse battery staple";

test("uploads the PDF fixture through the browser", async ({ page }) => {
  await page.goto("/invite/pdf-upload-invite");
  await page.getByLabel("Choose a password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/plays/new");
  await page.getByLabel("PDF or DOCX").setInputFiles(
    resolve(process.cwd(), "fixtures/plays/two-scene-play.pdf"),
  );
  await page.getByRole("button", { name: "Add play" }).click();

  await expect(page.getByRole("status")).toHaveText("two-scene-play is processing.");
  await page.getByRole("link", { name: "Review parser issues" }).click();

  const firstBoundary = page.getByRole("radio", { name: /We continue/ });
  await expect(firstBoundary).toBeVisible();
  await firstBoundary.check();
  await page.getByLabel("New scene title").fill("Scene Two");
  await page.getByRole("button", { name: "Save selected boundary" }).click();
  await expect(page.getByText("Version 2.")).toBeVisible();
});
