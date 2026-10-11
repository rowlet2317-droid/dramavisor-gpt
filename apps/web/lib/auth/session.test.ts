import { afterEach, describe, expect, it, vi } from "vitest";

import { sessionCookie } from "./session";

const now = new Date("2026-09-24T12:00:00Z");
const expiresAt = new Date("2026-10-24T12:00:00Z");

describe("sessionCookie", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("omits Secure when explicitly configured for local HTTP", () => {
    vi.stubEnv("SESSION_COOKIE_SECURE", "false");

    expect(sessionCookie("session-token", expiresAt, now)).not.toContain("Secure");
  });

  it("keeps Secure in production even when a local override is present", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_COOKIE_SECURE", "false");

    expect(sessionCookie("session-token", expiresAt, now)).toContain("Secure");
  });

  it("keeps Secure when explicitly configured for HTTPS", () => {
    vi.stubEnv("SESSION_COOKIE_SECURE", "true");

    expect(sessionCookie("session-token", expiresAt, now)).toContain("Secure");
  });
});
