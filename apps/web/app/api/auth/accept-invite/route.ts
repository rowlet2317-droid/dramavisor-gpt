import { getDatabase } from "@drama/db/client";
import { AuthRepository } from "@drama/db/repositories/auth";

import { createAcceptInviteHandler } from "./handler";

export async function POST(request: Request): Promise<Response> {
  return createAcceptInviteHandler(new AuthRepository(getDatabase()))(request);
}
