import { getDatabase } from "@drama/db/client";
import { S3ObjectStorage } from "@drama/storage/s3-storage";

import { requireUser } from "../../../../../../../lib/auth/session";
import { getRuntimeDependencies } from "../../../../../../../lib/runtime-composition";
import { createDeleteTakeAudioHandler } from "./handler";

type RouteContext = { params: Promise<{ playId: string; takeId: string }> };

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const injected = getRuntimeDependencies();
  const storage = injected?.storage ?? new S3ObjectStorage({ bucket: process.env.S3_PRIVATE_BUCKET ?? "" });
  return createDeleteTakeAudioHandler({ authenticate: requireUser, db: getDatabase(), storage })(request, context);
}
