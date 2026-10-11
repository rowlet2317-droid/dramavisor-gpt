import { OpenAiPlayParser } from "@drama/ai/play-parser/openai-parser";
import type { PlayParser } from "@drama/ai/play-parser/port";
import { loadAiConfig } from "@drama/ai/config";
import { OpenAiStudyGenerator } from "@drama/ai/study/openai-study";
import type { StudyGenerator } from "@drama/ai/study/port";
import { OpenAiTranscriber } from "@drama/ai/transcription/openai-transcriber";
import type { Transcriber } from "@drama/ai/transcription/port";
import { OpenAiAudioReviewer } from "@drama/ai/audio-review/openai-audio-review";
import type { AudioReviewer } from "@drama/ai/audio-review/port";
import { OpenAiCoach } from "@drama/ai/coaching/openai-coach";
import type { Coach } from "@drama/ai/coaching/port";
import type * as schema from "@drama/db/schema";
import type { ScriptExtractor } from "@drama/media/scripts/extract";
import type { ObjectStorage } from "@drama/storage/port";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { emitWorkerJobFailureEvent } from "./observability/sink";
import { claimNextJob, failJob } from "./jobs/claim";
import { runExtractScriptJob } from "./jobs/extract-script";
import { runGenerateStudyJob } from "./jobs/generate-study";
import { runParseJob } from "./jobs/parse-play";
import { failMeasureTakeJob, runLimitedMeasureTakeJob, runMeasureTakeJob } from "./jobs/measure-take";
import { runPurgePlayAudioJob, runPurgeTakeAudioJob } from "./jobs/purge-take-audio";
import { runDeleteAccountJob } from "./jobs/delete-account";
import { failReviewAudioJob, runReviewAudioJob } from "./jobs/review-audio";
import { failSynthesizeCoachingJob, runSynthesizeCoachingJob } from "./jobs/synthesize-coaching";
import { failTranscribeTakeJob, runTranscribeTakeJob } from "./jobs/transcribe-take";

type WorkerOptions<TQueryResult extends PgQueryResultHKT> = {
  db: PgDatabase<TQueryResult, typeof schema>;
  ownerUserId: string;
  extractor: ScriptExtractor;
  parser: PlayParser;
  studyGenerator?: StudyGenerator;
  studyPromptVersion?: string;
  analysisModelName?: string;
  loadPrivateObject?: (objectKey: string) => Promise<Uint8Array>;
  transcriber?: Transcriber;
  normalizeAudio?: (audio: Uint8Array) => Promise<Uint8Array>;
  normalizedAudioStorage?: ObjectStorage;
  audioReviewer?: AudioReviewer;
  coach?: Coach;
  now?: Date;
};

export async function runWorkerOnce<TQueryResult extends PgQueryResultHKT>(
  options: WorkerOptions<TQueryResult>,
): Promise<boolean> {
  const job = await claimNextJob({ db: options.db, ownerUserId: options.ownerUserId, now: options.now });
  if (!job) return false;
  if (!job.leaseToken) throw new Error("Claimed job has no lease token");

  try {
    if (job.kind === "extract_script") {
      await runExtractScriptJob({
        db: options.db,
        ownerUserId: options.ownerUserId,
        jobId: job.id,
        extractor: options.extractor,
        leaseToken: job.leaseToken,
        attemptCount: job.attemptCount,
        loadPrivateObject: options.loadPrivateObject,
      });
    } else if (job.kind === "parse_play") {
      await runParseJob({
        db: options.db,
        ownerUserId: options.ownerUserId,
        jobId: job.id,
        parser: options.parser,
        leaseToken: job.leaseToken,
        attemptCount: job.attemptCount,
      });
    } else if (job.kind === "generate_study") {
      if (!options.studyGenerator || !options.analysisModelName) throw new Error("Study generator is not configured");
      await runGenerateStudyJob({ db: options.db, ownerUserId: options.ownerUserId, jobId: job.id,
        generator: options.studyGenerator, leaseToken: job.leaseToken, attemptCount: job.attemptCount,
        promptVersion: options.studyPromptVersion ?? "study-v1", modelName: options.analysisModelName,
        generatedAt: options.now });
    } else if (job.kind === "process_take") {
      if (!options.transcriber || !options.loadPrivateObject) throw new Error("Transcription is not configured");
      await runTranscribeTakeJob({
        db: options.db,
        ownerUserId: options.ownerUserId,
        jobId: job.id,
        transcriber: options.transcriber,
        leaseToken: job.leaseToken,
        attemptCount: job.attemptCount,
        loadPrivateObject: options.loadPrivateObject,
        normalize: options.normalizeAudio,
        normalizedAudioStorage: options.normalizedAudioStorage,
        now: options.now,
      });
    } else if (job.kind === "measure_take") {
      if (!options.normalizedAudioStorage) throw new Error("Normalized audio storage is not configured");
      await runMeasureTakeJob({
        db: options.db,
        ownerUserId: options.ownerUserId,
        jobId: job.id,
        leaseToken: job.leaseToken,
        attemptCount: job.attemptCount,
        normalizedAudioStorage: options.normalizedAudioStorage,
        now: options.now,
      });
    } else if (job.kind === "review_audio") {
      if (!options.normalizedAudioStorage || !options.audioReviewer) {
        throw new Error("Audio review is not configured");
      }
      await runReviewAudioJob({ db: options.db, ownerUserId: options.ownerUserId, jobId: job.id,
        leaseToken: job.leaseToken, attemptCount: job.attemptCount, reviewer: options.audioReviewer,
        normalizedAudioStorage: options.normalizedAudioStorage, now: options.now });
    } else if (job.kind === "synthesize_coaching") {
      if (!options.coach) throw new Error("Coaching synthesis is not configured");
      await runSynthesizeCoachingJob({ db: options.db, ownerUserId: options.ownerUserId, jobId: job.id,
        leaseToken: job.leaseToken, attemptCount: job.attemptCount, coach: options.coach, now: options.now });
    } else if (job.kind === "purge_take_audio") {
      if (!options.normalizedAudioStorage) throw new Error("Private audio storage is not configured");
      await runPurgeTakeAudioJob({ db: options.db, ownerUserId: options.ownerUserId, jobId: job.id,
        leaseToken: job.leaseToken, attemptCount: job.attemptCount,
        storage: options.normalizedAudioStorage, now: options.now });
    } else if (job.kind === "purge_play_audio") {
      if (!options.normalizedAudioStorage) throw new Error("Private audio storage is not configured");
      await runPurgePlayAudioJob({ db: options.db, ownerUserId: options.ownerUserId, jobId: job.id,
        leaseToken: job.leaseToken, attemptCount: job.attemptCount,
        storage: options.normalizedAudioStorage, now: options.now });
    } else if (job.kind === "delete_account") {
      if (!options.normalizedAudioStorage) throw new Error("Private account storage is not configured");
      await runDeleteAccountJob({ db: options.db, ownerUserId: options.ownerUserId, jobId: job.id,
        leaseToken: job.leaseToken, attemptCount: job.attemptCount, storage: options.normalizedAudioStorage,
        now: options.now });
    } else {
      await failJob({
        db: options.db,
        ownerUserId: options.ownerUserId,
        jobId: job.id,
        leaseToken: job.leaseToken,
        attemptCount: job.attemptCount,
        code: "UNSUPPORTED_JOB_KIND",
        now: options.now,
      });
    }
  } catch (error) {
    const code = resolveJobFailureCode(error, job.kind);
    if (job.kind === "measure_take" && code === "JOB_FAILURE" && options.normalizedAudioStorage) {
      try {
        await runLimitedMeasureTakeJob({ db: options.db, ownerUserId: options.ownerUserId, jobId: job.id,
          leaseToken: job.leaseToken, attemptCount: job.attemptCount,
          normalizedAudioStorage: options.normalizedAudioStorage, now: options.now });
        return true;
      } catch {
        // Preserve the original failure below when even conservative publication cannot complete.
      }
    }
    emitWorkerJobFailureEvent({ jobId: job.id, jobKind: job.kind, error: { code } });
    if (code !== "MODEL_SCHEMA_FAILURE" && code !== "STALE_JOB_LEASE" && code !== "JOB_TERMINAL") {
      try {
        const failure = { db: options.db, ownerUserId: options.ownerUserId, jobId: job.id,
          leaseToken: job.leaseToken, attemptCount: job.attemptCount, code, now: options.now };
        if (job.kind === "process_take") await failTranscribeTakeJob(failure);
        else if (job.kind === "measure_take") await failMeasureTakeJob(failure);
        else if (job.kind === "review_audio") await failReviewAudioJob(failure);
        else if (job.kind === "synthesize_coaching") {
          await failSynthesizeCoachingJob(failure);
        } else await failJob(failure);
      } catch (failureError) {
        const failureCode = failureError instanceof Error
          && "code" in failureError
          && typeof failureError.code === "string"
          ? failureError.code
          : undefined;
        if (failureCode !== "STALE_JOB_LEASE") throw failureError;
      }
    }
  }
  return true;
}

export function resolveJobFailureCode(error: unknown, jobKind: string): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  const message = error instanceof Error ? error.message : "";
  if (/^[A-Z][A-Z0-9_]{0,63}$/u.test(message)) return message;
  if (jobKind === "synthesize_coaching") return "COACHING_SYNTHESIS_RUNTIME_FAILURE";
  return "JOB_FAILURE";
}

export function createStudyGeneratorFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): OpenAiStudyGenerator {
  const config = loadAiConfig(environment);
  return new OpenAiStudyGenerator({ model: config.analysisModel, apiKey: config.openAiApiKey });
}

export async function runWorkerCycle(options: {
  listOwnerPartitions: () => Promise<string[]>;
  runOwnerPartition: (ownerUserId: string) => Promise<boolean>;
}): Promise<number> {
  let processed = 0;
  for (const ownerUserId of await options.listOwnerPartitions()) {
    if (await options.runOwnerPartition(ownerUserId)) processed += 1;
  }
  return processed;
}

export function createParserFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): OpenAiPlayParser {
  const config = loadAiConfig(environment);
  return new OpenAiPlayParser({
    model: config.analysisModel,
    apiKey: config.openAiApiKey,
  });
}

export function createTranscriberFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): OpenAiTranscriber {
  const config = loadAiConfig(environment);
  return new OpenAiTranscriber({ apiKey: config.openAiApiKey });
}

export function createAudioReviewerFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): OpenAiAudioReviewer {
  const config = loadAiConfig(environment);
  return new OpenAiAudioReviewer({ apiKey: config.openAiApiKey, model: loadAudioReviewModel(environment) });
}

export function loadAudioReviewModel(environment: Record<string, string | undefined>): string {
  return environment.AUDIO_REVIEW_MODEL?.trim() || "gpt-audio-1.5";
}

export function createCoachFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): OpenAiCoach {
  const config = loadAiConfig(environment);
  const model = loadCoachingModel(environment);
  return new OpenAiCoach({ model, apiKey: config.openAiApiKey });
}

export function loadCoachingModel(environment: Record<string, string | undefined>): string {
  const model = environment.COACHING_MODEL?.trim() || "gpt-5.6";
  if (!/^gpt-5\.6(?:$|-)/u.test(model)) throw new Error("COACHING_MODEL must be a GPT-5.6-family model");
  return model;
}
