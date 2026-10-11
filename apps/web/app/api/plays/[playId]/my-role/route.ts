import { loadAiConfig } from "@drama/ai/config";
import { OpenAiStudyGenerator } from "@drama/ai/study/openai-study";
import { getDatabase } from "@drama/db/client";

import { requireUser } from "../../../../../lib/auth/session";
import { getRuntimeDependencies } from "../../../../../lib/runtime-composition";
import { createMyRoleRoute } from "./handler";

type RouteContext = { params: Promise<{ playId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return createMyRoleRoute({ authenticate: requireUser, db: getDatabase() }, () => {
    const injected = getRuntimeDependencies();
    if (injected) return { generator: injected.studyGenerator, promptVersion: "role-v1",
      modelName: injected.modelName };
    const config = loadAiConfig();
    return { generator: new OpenAiStudyGenerator({ model: config.analysisModel, apiKey: config.openAiApiKey }),
      promptVersion: "role-v1", modelName: config.analysisModel };
  })(request, context);
}
