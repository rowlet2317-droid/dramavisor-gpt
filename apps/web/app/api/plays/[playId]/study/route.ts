import { getDatabase } from "@drama/db/client";

import { requireUser } from "../../../../../lib/auth/session";
import { createStudyHandler } from "./handler";

type RouteContext = { params: Promise<{ playId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return createStudyHandler({ authenticate: requireUser, db: getDatabase() })(request, context);
}
