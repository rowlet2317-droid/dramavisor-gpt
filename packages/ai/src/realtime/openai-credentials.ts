import { createHash } from "node:crypto";

import type { IssuedRealtimeCredentials, RealtimeCredentialIssuer, RealtimeSessionPurpose } from "./port";

type Options = {
  apiKey: string;
  model: string;
  clientSecretTtlSeconds?: number;
  fetch?: typeof fetch;
  now?: () => Date;
};

type ProviderResponse = {
  value?: unknown;
  expires_at?: unknown;
  session?: { model?: unknown };
};

const MAX_CLIENT_SECRET_TTL_SECONDS = 600;
const DEFAULT_CLIENT_SECRET_TTL_SECONDS = 60;

export class OpenAiRealtimeCredentials implements RealtimeCredentialIssuer {
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;
  private readonly clientSecretTtlSeconds: number;

  constructor(private readonly options: Options) {
    if (!options.apiKey.trim()) throw new Error("OPENAI_API_KEY is required");
    if (!options.model.trim()) throw new Error("REALTIME_MODEL is required");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.clientSecretTtlSeconds = options.clientSecretTtlSeconds ?? DEFAULT_CLIENT_SECRET_TTL_SECONDS;
    if (!Number.isInteger(this.clientSecretTtlSeconds) || this.clientSecretTtlSeconds < 10
      || this.clientSecretTtlSeconds > MAX_CLIENT_SECRET_TTL_SECONDS) {
      throw new Error("REALTIME_CLIENT_SECRET_TTL_SECONDS must be an integer from 10 to 600");
    }
  }

  async issue(input: { userId: string; purpose: RealtimeSessionPurpose }): Promise<IssuedRealtimeCredentials> {
    const response = await this.fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
        "openai-safety-identifier": createHash("sha256").update(input.userId).digest("hex"),
      },
      body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: this.clientSecretTtlSeconds },
        session: this.sessionConfiguration(input.purpose) }),
    });
    if (!response.ok) throw new Error(`Realtime credential request failed (${response.status})`);
    const body = await response.json() as ProviderResponse;
    if (typeof body.value !== "string" || typeof body.expires_at !== "number"
      || typeof body.session?.model !== "string") {
      throw new Error("Realtime credential response is invalid");
    }
    if (body.session.model !== this.options.model) {
      throw new Error("Realtime credential model does not match the configured model");
    }
    const expiresAt = new Date(body.expires_at * 1_000);
    const remainingMs = expiresAt.getTime() - this.now().getTime();
    if (remainingMs > this.clientSecretTtlSeconds * 1_000) throw new Error("Realtime credential expiry exceeds requested TTL");
    if (remainingMs <= 0) throw new Error("Realtime credential is already expired");
    return { clientSecret: body.value, expiresAt: expiresAt.toISOString(), model: body.session.model };
  }

  private sessionConfiguration(purpose: RealtimeSessionPurpose) {
    if (purpose.type === "actor_input") {
      return { type: "realtime" as const, model: this.options.model, output_modalities: ["text"],
        audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" },
          turn_detection: { type: "server_vad" as const } } } };
    }
    return { type: "realtime" as const, model: this.options.model, output_modalities: ["audio"],
      audio: { output: { voice: purpose.voice } } };
  }
}
