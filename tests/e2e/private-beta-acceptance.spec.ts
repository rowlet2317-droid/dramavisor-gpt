import { expect, test } from "./fixtures";

test.describe("private-beta provider acceptance", () => {
  test.skip(process.env.ACCEPTANCE_PROVIDER_EVIDENCE === undefined,
    "Run pnpm acceptance:provider with nonproduction provider evidence; do not synthesize beta measurements.");

  test("keeps the browser acceptance route private before provider evidence is evaluated", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
});
