import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("migration command", () => {
  it("runs through tsx without a CommonJS top-level-await transform failure", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx",
      fileURLToPath(new URL("./migrate.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is required");
    expect(result.stderr).not.toContain("Top-level await is currently not supported");
  });
});
