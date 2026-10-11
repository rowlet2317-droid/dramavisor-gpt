import { getDatabase } from "@drama/db/client";
import { AuthRepository } from "@drama/db/repositories/auth";

import { createSignInHandler } from "./handler";

export async function POST(request: Request): Promise<Response> {
  return createSignInHandler(new AuthRepository(getDatabase()))(request);
}
