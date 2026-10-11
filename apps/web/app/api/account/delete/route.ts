import { getDatabase } from "@drama/db/client";
import { AuthRepository } from "@drama/db/repositories/auth";

import { requireUser } from "../../../../lib/auth/session";
import { getRuntimeDependencies } from "../../../../lib/runtime-composition";
import { createDeleteAccountHandler } from "./handler";

export async function DELETE(request: Request): Promise<Response> {
  let user: { id: string } | undefined;
  const response = await createDeleteAccountHandler({ authenticate: async () => (user = await requireUser()),
    auth: new AuthRepository(getDatabase()) })(request);
  if (response.status === 202 && user) await getRuntimeDependencies()?.processQueuedJobs(user.id);
  return response;
}
