import { describe, expect, it, vi } from "vitest";

vi.mock("@electric-sql/pglite", () => {
  throw new Error("production database client imported PGlite");
});
vi.mock("drizzle-orm/pglite", () => {
  throw new Error("production database client imported the PGlite Drizzle adapter");
});

describe("production database client module", () => {
  it("loads without evaluating the development-only PGlite package", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const clientModule = await import("./client");

    expect(clientModule.createDatabase).toBeTypeOf("function");
    expect(clientModule.getDatabase).toBeTypeOf("function");
    vi.unstubAllEnvs();
  });
});
