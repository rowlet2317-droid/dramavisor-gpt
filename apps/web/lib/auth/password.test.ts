import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("verifies only the original password", async () => {
    const encoded = await hashPassword("correct horse battery staple");

    expect(await verifyPassword("correct horse battery staple", encoded)).toBe(true);
    expect(await verifyPassword("wrong", encoded)).toBe(false);
  });
});
