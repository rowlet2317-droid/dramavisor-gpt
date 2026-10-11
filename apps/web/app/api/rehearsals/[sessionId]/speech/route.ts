import { OpenAiTtsSynthesizer } from "@drama/ai/character-voice/openai-tts";
import { getDatabase } from "@drama/db/client";

import { requireUser } from "../../../../../lib/auth/session";
import { createRehearsalSpeechHandler } from "./handler";

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  if (process.env.E2E_TEST_MODE === "1") {
    return createRehearsalSpeechHandler({ authenticate: requireUser, db: getDatabase(),
      synthesize: async () => ({ bytes: new Uint8Array([1]), mediaType: "audio/mpeg" }) })(request, context);
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return Response.json({ error: "Configured speech provider is not available" }, { status: 503 });
  }
  const synthesizer = new OpenAiTtsSynthesizer({ apiKey,
    model: process.env.TTS_MODEL?.trim() || "gpt-4o-mini-tts" });
  return createRehearsalSpeechHandler({ authenticate: requireUser, db: getDatabase(),
    synthesize: (input) => synthesizer.synthesize(input) })(request, context);
}
