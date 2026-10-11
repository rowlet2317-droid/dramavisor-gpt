import { describe, expect, it, vi } from "vitest";

import { OpenAiRealtimeCredentials } from "./openai-credentials";

describe("OpenAiRealtimeCredentials", () => {
  it("mints a sixty-second client secret without exposing the permanent API key", async () => {
    const request = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({
      value: "ek_test",
      expires_at: 1_787_445_660,
      session: { model: "gpt-realtime-2.1" },
    }));
    const issuer = new OpenAiRealtimeCredentials({ apiKey: "server-secret", model: "gpt-realtime-2.1",
      now: () => new Date("2026-08-23T00:40:00.000Z"), fetch: request });

    const result = await issuer.issue({ userId: "user-123", purpose: { type: "actor_input" } });

    expect(result).toEqual({ clientSecret: "ek_test", expiresAt: "2026-08-23T00:41:00.000Z",
      model: "gpt-realtime-2.1" });
    expect(request).toHaveBeenCalledWith("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        authorization: "Bearer server-secret",
        "content-type": "application/json",
        "openai-safety-identifier": "fcdec6df4d44dbc637c7c5b58efface52a7f8a88535423430255be0bb89bedd8",
      },
      body: expect.any(String),
    });
    const providerBody = JSON.parse((request.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(providerBody).toMatchObject({ expires_after: { anchor: "created_at", seconds: 60 },
      session: { type: "realtime", model: "gpt-realtime-2.1", output_modalities: ["text"],
        audio: { input: { transcription: { model: expect.any(String) },
          turn_detection: { type: "server_vad" } } } } });
  });

  it("mints a role-output secret with the persisted server-owned voice", async () => {
    const request = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ value: "ek_role", expires_at: 1_787_445_660,
      session: { model: "gpt-realtime-2.1" } }));
    const issuer = new OpenAiRealtimeCredentials({ apiKey: "server-secret", model: "gpt-realtime-2.1",
      now: () => new Date("2026-08-23T00:40:00.000Z"), fetch: request });

    await issuer.issue({ userId: "user-123", purpose: { type: "role_output", roleId: "role-1", voice: "cedar" } });

    const providerBody = JSON.parse((request.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(providerBody.session).toMatchObject({ type: "realtime", model: "gpt-realtime-2.1",
      output_modalities: ["audio"], audio: { output: { voice: "cedar" } } });
  });

  it("rejects provider responses whose secret expiry exceeds requested TTL", async () => {
    const issuer = new OpenAiRealtimeCredentials({ apiKey: "server-secret", model: "gpt-realtime-2.1",
      now: () => new Date("2026-08-23T00:40:00.000Z"),
      fetch: async () => Response.json({ value: "ek_too_long", expires_at: 1_787_446_201,
        session: { model: "gpt-realtime-2.1" } }) });

    await expect(issuer.issue({ userId: "user-123", purpose: { type: "actor_input" } }))
      .rejects.toThrow("expiry exceeds requested TTL");
  });

  it("rejects a client secret scoped to a different realtime model", async () => {
    const issuer = new OpenAiRealtimeCredentials({ apiKey: "server-secret", model: "gpt-realtime-2.1",
      now: () => new Date("2026-08-23T00:40:00.000Z"),
      fetch: async () => Response.json({ value: "ek_wrong_model", expires_at: 1_787_446_200,
        session: { model: "different-model" } }) });

    await expect(issuer.issue({ userId: "user-123", purpose: { type: "actor_input" } })).rejects.toThrow("model does not match");
  });
});
