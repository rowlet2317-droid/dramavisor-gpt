import { describe, expect, it } from "vitest";

import { requirePageUser } from "./page-session";

describe("requirePageUser", () => {
  it("redirects an absent or expired page session to sign in", async () => {
    const redirect = (path: string): never => { throw new Error(`redirect:${path}`); };
    await expect(requirePageUser(async () => {
      throw Object.assign(new Error("Authentication required"), { name: "UnauthorizedError" });
    }, redirect)).rejects.toThrow("redirect:/sign-in");
  });

  it("does not convert database failures into authentication redirects", async () => {
    await expect(requirePageUser(async () => { throw new Error("database offline"); },
      () => { throw new Error("unexpected redirect"); })).rejects.toThrow("database offline");
  });
});
