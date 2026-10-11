import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import SignInPage from "./page";

it("renders the private-beta sign-in form", () => {
  const markup = renderToStaticMarkup(<SignInPage />);

  expect(markup).toContain("Sign in to rehearse");
  expect(markup).toContain('autoComplete="email"');
  expect(markup).toContain('autoComplete="current-password"');
  expect(markup).toContain('action="/api/auth/sign-in"');
  expect(markup).toContain('method="post"');
});
