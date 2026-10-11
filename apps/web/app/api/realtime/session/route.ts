import { OpenAiRealtimeCredentials } from "@drama/ai/realtime/openai-credentials";
import { getDatabase } from "@drama/db/client";

import { requireUser } from "../../../../lib/auth/session";
import { createRealtimeSessionHandler } from "./handler";

export async function POST(request: Request): Promise<Response> {
  if (process.env.E2E_TEST_MODE === "1") {
    const now = new Date();
    return createRealtimeSessionHandler({ authenticate: requireUser, db: getDatabase(), now: () => now,
      credentials: { issue: async () => ({ clientSecret: "ek_e2e",
        expiresAt: new Date(now.getTime() + 540_000).toISOString(), model: "gpt-realtime-2.1" }) },
      ttsConfigured: true })(request);
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return Response.json({ error: "Realtime provider is not configured" }, { status: 503 });
  const credentials = new OpenAiRealtimeCredentials({ apiKey,
    model: process.env.REALTIME_MODEL?.trim() || "gpt-realtime-2.1",
    clientSecretTtlSeconds: process.env.REALTIME_CLIENT_SECRET_TTL_SECONDS === undefined
      ? undefined : Number(process.env.REALTIME_CLIENT_SECRET_TTL_SECONDS) });
  return createRealtimeSessionHandler({ authenticate: requireUser, db: getDatabase(), credentials,
    ttsConfigured: true })(request);
}
