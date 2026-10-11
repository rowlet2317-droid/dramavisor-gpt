import { afterEach, describe, expect, it } from "vitest";

import { getRuntimeDependencies, installRuntimeDependencies } from "./runtime-composition";

describe("runtime dependency injection", () => {
  const originalMode = process.env.E2E_TEST_MODE;
  afterEach(() => {
    if (originalMode === undefined) delete process.env.E2E_TEST_MODE;
    else process.env.E2E_TEST_MODE = originalMode;
    installRuntimeDependencies(null);
  });

  it("does not activate test adapters from an environment flag alone", () => {
    installRuntimeDependencies(null);
    process.env.E2E_TEST_MODE = "1";
    expect(getRuntimeDependencies()).toBeNull();
  });
});
