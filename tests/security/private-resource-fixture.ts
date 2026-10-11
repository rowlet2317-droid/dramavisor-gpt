import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";

import type { RealtimeCredentialIssuer } from "@drama/ai/realtime/port";
import type { StudyGenerator } from "@drama/ai/study/port";
import { PlayRepository } from "@drama/db/repositories/plays";
import * as schema from "@drama/db/schema";
import {
  actorNotes,
  analysisArtifacts,
  coachingReports,
  cueResponseEvidence,
  playModels,
  plays,
  practiceSessions,
  rehearsalEvents,
  rehearsalSessions,
  sourceFiles,
  takeMetrics,
  takeTranscripts,
  takes,
  users,
} from "@drama/db/schema";
import type { CoachingEvidence, CoachingReport } from "@drama/domain/coaching";
import type { PlayModel } from "@drama/domain/play-model";
import type { StudyArtifact } from "@drama/domain/study";
import type { ObjectStorage } from "@drama/storage/port";

import { createDeletePlayHandler } from "../../apps/web/app/api/plays/[playId]/handler";
import { createMyRoleHandler } from "../../apps/web/app/api/plays/[playId]/my-role/handler";
import { createSourceHandler } from "../../apps/web/app/api/plays/[playId]/source/[sourceId]/handler";
import { createStudyHandler } from "../../apps/web/app/api/plays/[playId]/study/handler";
import { createTakeAudioHandler } from "../../apps/web/app/api/plays/[playId]/takes/[takeId]/audio/handler";
import { createTakeReportHandler } from "../../apps/web/app/api/plays/[playId]/takes/[takeId]/handler";
import { createRealtimeSessionHandler } from "../../apps/web/app/api/realtime/session/handler";
import { createRehearsalEventHandler } from "../../apps/web/app/api/rehearsals/[sessionId]/events/handler";
import { createResumeRehearsalHandler } from "../../apps/web/app/api/rehearsals/[sessionId]/resume/handler";

const migrations = [
  "0001_foundation.sql",
  "0002_play_processing_status.sql",
  "0002_practice_sessions.sql",
  "0003_reviewable_parse_jobs.sql",
  "0004_job_lease_fencing.sql",
  "0005_grounded_study.sql",
  "0006_current_artifact_uniqueness.sql",
  "0007_take_transcripts.sql",
  "0008_ordered_transcript_evidence.sql",
  "0009_take_metrics.sql",
  "0010_normalized_audio_artifacts.sql",
  "0011_stale_attempt_cleanup.sql",
  "0012_cleanup_attempt_history.sql",
  "0013_immutable_normalized_audio_keys.sql",
  "0014_coaching_reports.sql",
  "0015_take_audio_retention.sql",
  "0016_global_job_lease_history.sql",
  "0017_rehearsal_sessions.sql",
  "0018_rehearsal_events.sql",
  "0019_account_deletion.sql",
  "0020_rehearsal_linked_coaching.sql",
] as const;

const ids = {
  ownerUser: "11111111-1111-4111-8111-111111111111",
  intruderUser: "22222222-2222-4222-8222-222222222222",
  play: "33333333-3333-4333-8333-333333333333",
  source: "44444444-4444-4444-8444-444444444444",
  playModel: "55555555-5555-4555-8555-555555555555",
  studyArtifact: "66666666-6666-4666-8666-666666666666",
  actorNote: "77777777-7777-4777-8777-777777777777",
  practiceSession: "88888888-8888-4888-8888-888888888888",
  take: "99999999-9999-4999-8999-999999999999",
  transcript: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  metrics: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  coachingReport: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  rehearsalSession: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  rehearsalEvent: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  rehearsalActorEvent: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  cueResponseEvidence: "12121212-1212-4212-8212-121212121212",
} as const;

const sceneId = `${ids.play}:scene:private`;
const characterId = `${ids.play}:character:private`;
const lineId = `${ids.play}:line:private`;
const sourceObjectKey = `users/${ids.ownerUser}/plays/${ids.play}/source/${ids.source}`;
const audioObjectKey = `users/${ids.ownerUser}/plays/${ids.play}/takes/${ids.take}.wav`;

export type AuthorizationProof =
  | "play"
  | "source"
  | "study"
  | "actor-note"
  | "take-report"
  | "audio"
  | "resume"
  | "event"
  | "realtime-grant";

export type PrivateResourceMatrixFixture = {
  privateIdentifiers: readonly string[];
  externalAccesses: readonly string[];
  executeAsIntruder(proof: AuthorizationProof): Promise<Response>;
  listIntruderPlays(): Promise<unknown>;
  close(): Promise<void>;
};

export async function createPrivateResourceMatrixFixture(): Promise<PrivateResourceMatrixFixture> {
  const client = new PGlite();
  for (const migration of migrations) {
    await client.exec(await readFile(new URL(`../../packages/db/migrations/${migration}`, import.meta.url), "utf8"));
  }
  const db = drizzle(client, { schema });
  await seedPrivateResourceGraph(db);

  const externalAccesses: string[] = [];
  const storage = new TrackingStorage(externalAccesses, new Map([
    [sourceObjectKey, Uint8Array.from([0x25, 0x50, 0x44, 0x46])],
    [audioObjectKey, Uint8Array.from([0, 1, 2, 3])],
  ]));
  const credentials = inaccessibleCredentials(externalAccesses);
  const generator = inaccessibleStudyGenerator(externalAccesses);
  const authenticate = async () => ({ id: ids.intruderUser });

  return {
    privateIdentifiers: [
      ...Object.entries(ids).filter(([name]) => name !== "intruderUser").map(([, id]) => id),
      sceneId,
      characterId,
      lineId,
      sourceObjectKey,
      audioObjectKey,
    ],
    externalAccesses,
    executeAsIntruder: async (proof) => {
      switch (proof) {
        case "play":
          return createDeletePlayHandler({ authenticate, db })(
            new Request(`http://local/api/plays/${ids.play}`, { method: "DELETE" }),
            { params: Promise.resolve({ playId: ids.play }) },
          );
        case "source":
          return createSourceHandler({ authenticate, db, storage })(
            new Request(`http://local/api/plays/${ids.play}/source/${ids.source}`),
            { params: Promise.resolve({ playId: ids.play, sourceId: ids.source }) },
          );
        case "study":
          return createStudyHandler({ authenticate, db })(
            new Request(`http://local/api/plays/${ids.play}/study`),
            { params: Promise.resolve({ playId: ids.play }) },
          );
        case "actor-note":
          return createMyRoleHandler({ authenticate, db, generator, promptVersion: "matrix-v1",
            modelName: "matrix-model" })(jsonRequest(
              `http://local/api/plays/${ids.play}/my-role`, { characterId }),
            { params: Promise.resolve({ playId: ids.play }) });
        case "take-report":
          return createTakeReportHandler({ authenticate, db })(
            new Request(`http://local/api/plays/${ids.play}/takes/${ids.take}`),
            { params: Promise.resolve({ playId: ids.play, takeId: ids.take }) },
          );
        case "audio":
          return createTakeAudioHandler({ authenticate, db, storage })(
            new Request(`http://local/api/plays/${ids.play}/takes/${ids.take}/audio`, {
              headers: { range: "bytes=0-1" },
            }),
            { params: Promise.resolve({ playId: ids.play, takeId: ids.take }) },
          );
        case "resume":
          return createResumeRehearsalHandler({ authenticate, credentials, db })(jsonRequest(
            `http://local/api/rehearsals/${ids.rehearsalSession}/resume`,
            { clientLastSequence: 1, playModelVersion: 1 },
          ), { params: Promise.resolve({ sessionId: ids.rehearsalSession }) });
        case "event":
          return createRehearsalEventHandler({ authenticate, db })(jsonRequest(
            `http://local/api/rehearsals/${ids.rehearsalSession}/events`,
            { event: { type: "paused", sequence: 2 } },
          ), { params: Promise.resolve({ sessionId: ids.rehearsalSession }) });
        case "realtime-grant":
          return createRealtimeSessionHandler({ authenticate, credentials, db })(jsonRequest(
            "http://local/api/realtime/session", { type: "start", playId: ids.play, sceneId, actorRoleId: characterId },
          ));
      }
    },
    listIntruderPlays: async () => new PlayRepository(db).list(ids.intruderUser),
    close: async () => client.close(),
  };
}

type MatrixDatabase = ReturnType<typeof drizzle<typeof schema>>;

async function seedPrivateResourceGraph(db: MatrixDatabase): Promise<void> {
  await db.insert(users).values([
    { id: ids.ownerUser, email: "matrix-owner@example.com", passwordHash: "owner-hash" },
    { id: ids.intruderUser, email: "matrix-intruder@example.com", passwordHash: "intruder-hash" },
  ]);
  await db.insert(plays).values({ id: ids.play, ownerUserId: ids.ownerUser,
    title: "User A private play", status: "study_ready" });
  await db.insert(sourceFiles).values({ id: ids.source, ownerUserId: ids.ownerUser, playId: ids.play,
    filename: "user-a-private.pdf", objectKey: sourceObjectKey });
  await db.insert(playModels).values({ id: ids.playModel, ownerUserId: ids.ownerUser, playId: ids.play,
    version: 1, status: "approved", model: privatePlayModel(), issues: [] });
  await db.insert(analysisArtifacts).values({ id: ids.studyArtifact, ownerUserId: ids.ownerUser,
    playId: ids.play, kind: "overview", content: privateStudyArtifact(),
    status: "current", playModelVersion: 1 });
  await db.insert(actorNotes).values({ id: ids.actorNote, ownerUserId: ids.ownerUser, playId: ids.play,
    characterId, notes: { privateNoteId: ids.actorNote } });
  await db.insert(practiceSessions).values({ id: ids.practiceSession, ownerUserId: ids.ownerUser,
    playId: ids.play, playModelId: ids.playModel, playModelVersion: 1, sceneId, roleId: characterId,
    retentionChoice: "retain" });
  await db.insert(rehearsalSessions).values({ id: ids.rehearsalSession, ownerUserId: ids.ownerUser,
    playId: ids.play, playModelId: ids.playModel, playModelVersion: 1, sceneId, actorRoleId: characterId,
    model: "gpt-realtime-matrix", grantExpiresAt: new Date("2030-01-01T00:00:00.000Z"), state: "completed" });
  await db.insert(takes).values({ id: ids.take, ownerUserId: ids.ownerUser,
    practiceSessionId: ids.practiceSession, playId: ids.play, playModelId: ids.playModel,
    playModelVersion: 1, sceneId, roleId: characterId, retentionChoice: "retain", durationMs: 1_000,
    mediaType: "audio/wav", objectKey: audioObjectKey, state: "completed",
    rehearsalSessionId: ids.rehearsalSession });
  await db.insert(takeTranscripts).values({ id: ids.transcript, ownerUserId: ids.ownerUser,
    takeId: ids.take, audioSha256: "a".repeat(64), transcriberVersion: "matrix-v1", provider: "matrix",
    modelName: "matrix-transcriber", language: "en", text: "User A private transcript",
    timingSource: "whisper_word_timestamps" });
  await db.insert(takeMetrics).values({ id: ids.metrics, ownerUserId: ids.ownerUser, takeId: ids.take,
    transcriptId: ids.transcript, measurementVersion: "matrix-v1", metrics: metricSummary() });
  await db.insert(coachingReports).values({ id: ids.coachingReport, ownerUserId: ids.ownerUser,
    playId: ids.play, takeId: ids.take, transcriptId: ids.transcript, measurementId: ids.metrics,
    status: "completed", audioReviewStatus: "completed", evidence: coachingEvidence(), report: coachingReport() });
  await db.insert(rehearsalEvents).values([
    { id: ids.rehearsalEvent, ownerUserId: ids.ownerUser,
      rehearsalSessionId: ids.rehearsalSession, sequence: 1, type: "ai_speech_finished",
      event: { type: "ai_speech_finished", sequence: 1, characterId, elementId: lineId, endedAtMs: 100 } },
    { id: ids.rehearsalActorEvent, ownerUserId: ids.ownerUser,
      rehearsalSessionId: ids.rehearsalSession, sequence: 2, type: "manual_actor_line_completed",
      event: { type: "manual_actor_line_completed", sequence: 2, elementId: lineId, endedAtMs: 840 } },
  ]);
  await db.insert(cueResponseEvidence).values({ id: ids.cueResponseEvidence, ownerUserId: ids.ownerUser,
    takeId: ids.take, rehearsalSessionId: ids.rehearsalSession, measurementVersion: "cue-response-v1",
    cueEventId: ids.rehearsalEvent, actorEventId: ids.rehearsalActorEvent,
    clockId: `provider:${ids.rehearsalSession}`, delayMs: 740, confidence: "high", score: 85 });
}

function privatePlayModel(): PlayModel {
  return {
    id: `${ids.play}:v1`,
    title: "User A private model",
    language: "en",
    characters: [{ id: characterId, name: "Private Actor", aliases: [] }],
    acts: [{ id: `${ids.play}:act:private`, ordinal: 1, title: "Act I", scenes: [{
      id: sceneId,
      ordinal: 1,
      title: "Private scene",
      characterIds: [characterId],
      elements: [{ id: lineId, ordinal: 1, kind: "dialogue", characterId,
        text: "User A private line", sourcePage: 1 }],
    }] }],
  };
}

function privateStudyArtifact(): StudyArtifact {
  return {
    id: ids.studyArtifact,
    kind: "overview",
    scopeId: null,
    claims: [{ id: `${ids.studyArtifact}:claim`, text: "User A private study claim",
      epistemicStatus: "explicit", reference: { playId: ids.play, elementIds: [lineId] } }],
  };
}

function metricSummary() {
  return {
    durationMs: 1_000,
    speechDurationMs: 600,
    silenceDurationMs: 400,
    pauses: [],
    alignmentCoverage: 1,
    clippingRatio: 0,
    technicalWarnings: [],
    wordsPerMinute: 120,
    pace: { confidence: "high" as const, score: 80, wordsPerMinute: 120, wordCount: 2 },
    loudness: { confidence: "high" as const, score: 80, rmsDb: -18, rangeDb: 6 },
    pitch: { confidence: "high" as const, score: 80, medianHz: 220, rangeHz: 80, voicedFrames: 20 },
  };
}

function coachingEvidence(): CoachingEvidence[] {
  return [{ id: ids.coachingReport, kind: "transcript_alignment", confidence: "high",
    description: "User A private coaching evidence", startMs: null, endMs: null, elementIds: [lineId] }];
}

function coachingReport(): CoachingReport {
  return {
    ratings: [
      { category: "line_accuracy", score: 80, confidence: "high", evidenceIds: [ids.coachingReport] },
      { category: "clarity", score: null, confidence: "low", evidenceIds: [] },
      { category: "pacing", score: null, confidence: "low", evidenceIds: [] },
      { category: "cue_responsiveness", score: null, confidence: "low", evidenceIds: [] },
      { category: "vocal_variation", score: null, confidence: "low", evidenceIds: [] },
    ],
    strengths: [],
    priorities: [],
    exercise: { title: "Private exercise", instructions: "Repeat the private line.",
      targetCategory: "line_accuracy", evidenceIds: [ids.coachingReport] },
    interpretationNotes: [],
  };
}

function inaccessibleCredentials(externalAccesses: string[]): RealtimeCredentialIssuer {
  return { issue: async () => {
    externalAccesses.push("realtime-credentials.issue");
    throw new Error("Cross-owner miss reached the realtime provider");
  } };
}

function inaccessibleStudyGenerator(externalAccesses: string[]): StudyGenerator {
  return {
    generateStudySection: async () => {
      externalAccesses.push("study-generator.generateStudySection");
      throw new Error("Cross-owner miss reached the study provider");
    },
    generateRoleWorkbook: async () => {
      externalAccesses.push("study-generator.generateRoleWorkbook");
      throw new Error("Cross-owner miss reached the study provider");
    },
  };
}

class TrackingStorage implements ObjectStorage {
  constructor(private readonly externalAccesses: string[],
    private readonly objects: Map<string, Uint8Array>) {}

  async putPrivate(key: string, bytes: Uint8Array): Promise<void> {
    this.externalAccesses.push(`storage.putPrivate:${key}`);
    this.objects.set(key, bytes.slice());
  }

  async putPrivateVersioned(key: string, bytes: Uint8Array) {
    this.externalAccesses.push(`storage.putPrivateVersioned:${key}`);
    this.objects.set(key, bytes.slice());
    return { versionToken: "matrix-version" };
  }

  async getPrivate(key: string): Promise<Uint8Array> {
    this.externalAccesses.push(`storage.getPrivate:${key}`);
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error("Missing matrix object");
    return bytes.slice();
  }

  async deletePrivate(key: string): Promise<void> {
    this.externalAccesses.push(`storage.deletePrivate:${key}`);
    this.objects.delete(key);
  }

  async purgePrivate(key: string): Promise<void> {
    this.externalAccesses.push(`storage.purgePrivate:${key}`);
    this.objects.delete(key);
  }

  async deletePrivateVersion(key: string): Promise<boolean> {
    this.externalAccesses.push(`storage.deletePrivateVersion:${key}`);
    return this.objects.delete(key);
  }
}

function jsonRequest(url: string, body: Record<string, unknown>): Request {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });
}
