import { getDatabase } from "@drama/db/client";
import { users } from "@drama/db/schema";
import { createScriptExtractor } from "@drama/media/scripts/extract";
import { S3ObjectStorage } from "@drama/storage/s3-storage";

import { createAudioReviewerFromEnvironment, createCoachFromEnvironment, createParserFromEnvironment,
  createStudyGeneratorFromEnvironment, createTranscriberFromEnvironment, runWorkerCycle, runWorkerOnce }
  from "./index";
import { emitWorkerFatalEvent } from "./observability/sink";

async function main(): Promise<void> {
  const bucket = process.env.S3_PRIVATE_BUCKET?.trim();
  if (!bucket) throw new Error("S3_PRIVATE_BUCKET is required");
  const database = getDatabase();
  const extractor = createScriptExtractor();
  const parser = createParserFromEnvironment();
  const studyGenerator = createStudyGeneratorFromEnvironment();
  const transcriber = createTranscriberFromEnvironment();
  const audioReviewer = createAudioReviewerFromEnvironment();
  const coach = createCoachFromEnvironment();
  const analysisModelName = process.env.ANALYSIS_MODEL!.trim();
  const normalizedAudioStorage = new S3ObjectStorage({ bucket });
  const pollMilliseconds = positiveInteger(process.env.WORKER_POLL_MS, 1_000);
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });

  while (!stopping) {
    const processed = await runWorkerCycle({
      listOwnerPartitions: async () => (await database.select({ id: users.id }).from(users)).map((user) => user.id),
      runOwnerPartition: async (ownerUserId) => runWorkerOnce({
        db: database,
        ownerUserId,
        extractor,
        parser,
        studyGenerator,
        transcriber,
        audioReviewer,
        coach,
        analysisModelName,
        loadPrivateObject: (objectKey) => normalizedAudioStorage.getPrivate(objectKey),
        normalizedAudioStorage,
      }),
    });
    if (processed === 0) await wait(pollMilliseconds);
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

main().catch((error: unknown) => {
  emitWorkerFatalEvent(error);
  process.exitCode = 1;
});
