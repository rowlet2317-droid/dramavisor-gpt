import { getDatabase } from "@drama/db/client";

import { requireUser } from "../../../../../lib/auth/session";
import { getRuntimeDependencies } from "../../../../../lib/runtime-composition";
import { createReviewHandler } from "./handler";

type RouteContext = { params: Promise<{ playId: string }> };

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const db = getDatabase();
  const injected = getRuntimeDependencies();
  let user: { id: string } | undefined;
  const response = await createReviewHandler({ authenticate: async () => (user = await requireUser()),
    db })(request, context);
  if (response.ok && user && injected) await injected.processQueuedJobs(user.id);
  return response;
}
