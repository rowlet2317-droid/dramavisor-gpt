import { getDatabase } from "@drama/db/client";

import { requireUser } from "../../../../../lib/auth/session";
import { createExerciseHandler } from "./handler";

type RouteContext = { params: Promise<{ playId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return createExerciseHandler({ authenticate: requireUser, db: getDatabase() })(request, context);
}
