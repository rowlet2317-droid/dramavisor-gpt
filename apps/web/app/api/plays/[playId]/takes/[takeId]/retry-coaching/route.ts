import { getDatabase } from "@drama/db/client";

import { requireUser } from "../../../../../../../lib/auth/session";
import { createRetryCoachingHandler } from "./handler";

type RouteContext = { params: Promise<{ playId: string; takeId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return createRetryCoachingHandler({ authenticate: requireUser, db: getDatabase() })(request, context);
}
