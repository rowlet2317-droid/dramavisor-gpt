import { loadAiConfig } from "@drama/ai/config";
import { OpenAiTutor } from "@drama/ai/tutor/openai-tutor";
import { getDatabase } from "@drama/db/client";

import { requireUser } from "../../../../../lib/auth/session";
import { getRuntimeDependencies } from "../../../../../lib/runtime-composition";
import { createTutorRoute } from "./handler";

type RouteContext = { params: Promise<{ playId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return createTutorRoute({ authenticate: requireUser, db: getDatabase() }, () => {
    const injected = getRuntimeDependencies();
    if (injected) return injected.tutor;
    const config = loadAiConfig();
    return new OpenAiTutor({ model: config.analysisModel, apiKey: config.openAiApiKey });
  })(request, context);
}
