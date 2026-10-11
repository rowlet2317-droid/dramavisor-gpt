import { expect, test } from "./fixtures";

const password = "correct horse battery staple";

test("auth forms complete on the first submission before JavaScript hydrates", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://localhost:3100", javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto("/invite/progressive-auth-invite");
    await page.getByLabel("Choose a password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/$/);

    await context.clearCookies();
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill("progressive-auth@example.com");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/plays$/);
    await expect(page.getByRole("heading", { name: "Your plays" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("replays the first JavaScript-only button click after delayed hydration", async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ baseURL: "http://localhost:3100" });
  try {
    const accepted = await context.request.post("/api/auth/accept-invite", { data: {
      token: "hydration-replay-invite", password,
    } });
    expect(accepted.status()).toBe(201);

    let releaseScripts = () => {};
    const scriptsReleased = new Promise<void>((resolve) => { releaseScripts = resolve; });
    await context.route(/\/_next\/static\/chunks\/.*\.js(?:\?.*)?$/u, async (route) => {
      await scriptsReleased;
      await route.continue();
    });

    const page = await context.newPage();
    const navigation = page.goto("/plays/new");
    const pasteText = page.getByRole("button", { name: "Paste text" });
    await expect(pasteText).toBeVisible();
    await pasteText.click({ force: true, noWaitAfter: true });
    releaseScripts();
    await navigation;

    await expect(page.getByLabel("Script text")).toBeVisible();
    await expect(pasteText).toHaveAttribute("aria-pressed", "true");
  } finally {
    await context.close();
  }
});
