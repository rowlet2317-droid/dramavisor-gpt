import { getDatabase } from "@drama/db/client";
import { S3ObjectStorage } from "@drama/storage/s3-storage";

import { requireUser } from "../../../../../../lib/auth/session";
import { getRuntimeDependencies } from "../../../../../../lib/runtime-composition";
import { createSourceHandler } from "./handler";

type RouteContext = { params: Promise<{ playId: string; sourceId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const injected = getRuntimeDependencies();
  return createSourceHandler({ authenticate: requireUser, db: getDatabase(), storage: injected?.storage
    ?? new S3ObjectStorage({ bucket: process.env.S3_PRIVATE_BUCKET ?? "" }) })(request, context);
}
