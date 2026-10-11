import { getDatabase } from "@drama/db/client";
import { S3ObjectStorage } from "@drama/storage/s3-storage";

import { requireUser } from "../../../../../lib/auth/session";
import { getRuntimeDependencies } from "../../../../../lib/runtime-composition";
import { createTakeUploadHandler } from "./handler";

type RouteContext = { params: Promise<{ playId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const injected = getRuntimeDependencies();
  const storage = injected?.storage ?? new S3ObjectStorage({ bucket: process.env.S3_PRIVATE_BUCKET ?? "" });
  let user: { id: string } | undefined;
  const response = await createTakeUploadHandler({ authenticate: async () => (user = await requireUser()),
    db: getDatabase(), storage })(request, context);
  if (response.ok && user && injected) await injected.processQueuedJobs(user.id);
  return response;
}
