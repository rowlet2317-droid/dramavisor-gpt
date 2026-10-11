import { OpenAiRealtimeCredentials } from "@drama/ai/realtime/openai-credentials";
import { getDatabase } from "@drama/db/client";

import { requireUser } from "../../../../../lib/auth/session";
import { createResumeRehearsalHandler } from "./handler";

let e2eResumeGrantSequence = 0;

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  if (process.env.E2E_TEST_MODE === "1") {
    const now = new Date();
    return createResumeRehearsalHandler({ authenticate: requireUser, db: getDatabase(),
      credentials: { issue: async () => ({ clientSecret: `ek_e2e_reconnect_${++e2eResumeGrantSequence}`,
        expiresAt: new Date(now.getTime() + 540_000).toISOString(), model: "gpt-realtime-2.1" }) } })(
      request, context);
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return Response.json({ error: "Realtime provider is not configured" }, { status: 503 });
  const credentials = new OpenAiRealtimeCredentials({ apiKey,
    model: process.env.REALTIME_MODEL?.trim() || "gpt-realtime-2.1",
    clientSecretTtlSeconds: process.env.REALTIME_CLIENT_SECRET_TTL_SECONDS === undefined
      ? undefined : Number(process.env.REALTIME_CLIENT_SECRET_TTL_SECONDS) });
  return createResumeRehearsalHandler({ authenticate: requireUser, db: getDatabase(), credentials })(
    request, context);
}
