import { getDatabase } from "@drama/db/client";

import { requireUser } from "../../../../../lib/auth/session";
import { createRehearsalEventHandler } from "./handler";

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  return createRehearsalEventHandler({ authenticate: requireUser, db: getDatabase() })(request, context);
}
