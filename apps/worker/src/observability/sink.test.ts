import { describe, expect, it } from "vitest";

import { emitWorkerFatalEvent } from "./sink";

describe("worker operational sink", () => {
  it("serializes only a safe fatal code when an error contains private content", () => {
    const secret = "TRANSCRIPT script prompt audio credential provider-body stack message";
    const error = Object.assign(new Error(secret), { code: "PROVIDER_TIMEOUT", providerBody: secret });
    const lines: string[] = [];

    emitWorkerFatalEvent(error, (line) => lines.push(line));

    expect(lines).toEqual([JSON.stringify({ type: "worker.fatal", fields: {
      state: "failed", eventCode: "PROVIDER_TIMEOUT" } })]);
    expect(lines.join(" ")).not.toContain(secret);
  });
});
