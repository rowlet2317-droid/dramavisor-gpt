import { afterEach, describe, expect, it } from "vitest";

import { POST } from "./route";

describe("configured rehearsal speech route composition", () => {
  const originalApiKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  });

  it("reports configured speech unavailable without loading a provider when server credentials are absent", async () => {
    delete process.env.OPENAI_API_KEY;

    const response = await POST(new Request("http://local/api/rehearsals/session_1/speech", { method: "POST" }),
      { params: Promise.resolve({ sessionId: "session_1" }) });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Configured speech provider is not available" });
  });
});
