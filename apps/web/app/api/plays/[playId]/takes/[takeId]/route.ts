import { getDatabase } from "@drama/db/client";

import { requireUser } from "../../../../../../lib/auth/session";
import { createTakeReportHandler } from "./handler";

type RouteContext = { params: Promise<{ playId: string; takeId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return createTakeReportHandler({ authenticate: requireUser, db: getDatabase() })(request, context);
}
