import { getDatabase } from "@drama/db/client";

import { requireUser } from "../../../../lib/auth/session";
import { createDeletePlayHandler } from "./handler";

type RouteContext = { params: Promise<{ playId: string }> };

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return createDeletePlayHandler({ authenticate: requireUser, db: getDatabase() })(request, context);
}
