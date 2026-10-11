import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createInvite, withDatabaseCleanup } from "./create-invite";

describe("createInvite", () => {
  it("stores a seven-day token hash and returns one invite URL", async () => {
    const saved: { email?: string; tokenHash?: string; expiresAt?: Date } = {};
    const store = {
      async findUserByEmail() { return null; },
      async createInvite(email: string, tokenHash: string, expiresAt: Date) {
        Object.assign(saved, { email, tokenHash, expiresAt });
      },
    };

    const url = await createInvite(
      "Actor@Example.com",
      store,
      new Date("2026-08-01T12:00:00Z"),
      "https://drama.example/",
    );

    const token = new URL(url).pathname.split("/").at(-1)!;
    expect(url.split("\n")).toHaveLength(1);
    expect(saved.email).toBe("actor@example.com");
    expect(saved.expiresAt).toEqual(new Date("2026-08-08T12:00:00Z"));
    expect(saved.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(saved.tokenHash).not.toBe(token);
  });

  it("rejects an existing account before issuing another one-use token", async () => {
    let createInviteCalled = false;
    const store = {
      async findUserByEmail() {
        return { id: "existing-user" };
      },
      async createInvite() {
        createInviteCalled = true;
      },
    };

    await expect(createInvite(
      "Actor@Example.com",
      store,
      new Date("2026-08-01T12:00:00Z"),
      "https://drama.example/",
    )).rejects.toThrow("An account already exists for actor@example.com");
    expect(createInviteCalled).toBe(false);
  });

  it("closes the database client when invitation creation fails", async () => {
    let closed = false;
    const failure = new Error("existing account");

    await expect(withDatabaseCleanup(
      { $client: { end: async () => { closed = true; } } },
      async () => { throw failure; },
    )).rejects.toBe(failure);
    expect(closed).toBe(true);
  });

  it("runs its CLI through tsx without a CommonJS top-level-await transform failure", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx",
      fileURLToPath(new URL("./create-invite.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: create-invite --email actor@example.com");
    expect(result.stderr).not.toContain("Top-level await is currently not supported");
  });
});
