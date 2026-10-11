import type { PlayModel } from "@drama/domain/play-model";
import type { ParseIssue } from "@drama/domain/parse-review";
import type { RoleWorkbook, StudyArtifact } from "@drama/domain/study";
import type { PracticeMode, RetentionChoice, TakeState } from "@drama/domain/practice";
import type { LineAlignmentStatus, TranscriptTimingSource } from "@drama/domain/transcript";
import type { TakeMetrics } from "@drama/domain/audio-metrics";
import type { CoachingEvidence, CoachingReport } from "@drama/domain/coaching";
import type { PersistedRehearsalEvent } from "@drama/domain/rehearsal/types";
import {
  bigint,
  check,
  index,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  accountStatus: text("account_status").$type<"active" | "deleting">().notNull().default("active"),
  ...timestamps,
}, (table) => [uniqueIndex("users_email_unique").on(table.email)]);

export const inviteTokens = pgTable("invite_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("invite_tokens_token_hash_unique").on(table.tokenHash)]);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
  index("sessions_owner_user_id_idx").on(table.ownerUserId),
]);

export const plays = pgTable("plays", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  status: text("status").notNull().default("processing"),
  ...timestamps,
}, (table) => [
  index("plays_owner_user_id_idx").on(table.ownerUserId),
  uniqueIndex("plays_id_owner_user_id_unique").on(table.id, table.ownerUserId),
]);

export const sourceFiles = pgTable("source_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  playId: uuid("play_id").notNull(),
  filename: text("filename").notNull(),
  objectKey: text("object_key"),
  sourceText: text("source_text"),
  ...timestamps,
}, (table) => [
  index("source_files_owner_user_id_idx").on(table.ownerUserId),
  index("source_files_play_id_idx").on(table.playId),
  foreignKey({
    name: "source_files_play_owner_fk",
    columns: [table.playId, table.ownerUserId],
    foreignColumns: [plays.id, plays.ownerUserId],
  }).onDelete("cascade"),
]);

export const playModels = pgTable("play_models", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  playId: uuid("play_id").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull().default("draft"),
  model: jsonb("model").$type<PlayModel>().notNull(),
  issues: jsonb("issues").$type<ParseIssue[]>().notNull().default([]),
  sourceJobDedupeKey: text("source_job_dedupe_key"),
  ...timestamps,
}, (table) => [
  uniqueIndex("play_models_play_version_unique").on(table.playId, table.version),
  uniqueIndex("play_models_id_owner_user_id_unique").on(table.id, table.ownerUserId),
  uniqueIndex("play_models_source_job_dedupe_key_unique").on(table.sourceJobDedupeKey),
  index("play_models_owner_user_id_idx").on(table.ownerUserId),
  foreignKey({
    name: "play_models_play_owner_fk",
    columns: [table.playId, table.ownerUserId],
    foreignColumns: [plays.id, plays.ownerUserId],
  }).onDelete("cascade"),
]);

export const analysisArtifacts = pgTable("analysis_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  playId: uuid("play_id").notNull(),
  kind: text("kind").notNull(),
  content: jsonb("content").$type<Record<string, unknown> | StudyArtifact | RoleWorkbook>().notNull(),
  status: text("status").notNull().default("current"),
  promptVersion: text("prompt_version"),
  modelName: text("model_name"),
  playModelVersion: integer("play_model_version"),
  generatedAt: timestamp("generated_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  index("analysis_artifacts_owner_user_id_idx").on(table.ownerUserId),
  index("analysis_artifacts_play_id_idx").on(table.playId),
  uniqueIndex("analysis_artifacts_one_current_kind_unique")
    .on(table.ownerUserId, table.playId, table.kind)
    .where(sql`${table.status} = 'current'`),
  foreignKey({
    name: "analysis_artifacts_play_owner_fk",
    columns: [table.playId, table.ownerUserId],
    foreignColumns: [plays.id, plays.ownerUserId],
  }).onDelete("cascade"),
]);

export const actorNotes = pgTable("actor_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  playId: uuid("play_id").notNull(),
  characterId: text("character_id").notNull(),
  notes: jsonb("notes").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (table) => [
  uniqueIndex("actor_notes_owner_play_character_unique").on(table.ownerUserId, table.playId, table.characterId),
  foreignKey({
    name: "actor_notes_play_owner_fk",
    columns: [table.playId, table.ownerUserId],
    foreignColumns: [plays.id, plays.ownerUserId],
  }).onDelete("cascade"),
]);

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  playId: uuid("play_id"),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("queued"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  attempts: integer("attempts").notNull().default(0),
  attemptCount: integer("attempt_count").notNull().default(0),
  dedupeKey: text("dedupe_key"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  leaseToken: uuid("lease_token"),
  errorCode: text("error_code"),
  resultPlayModelVersionId: uuid("result_play_model_version_id"),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
}, (table) => [
  index("jobs_owner_user_id_idx").on(table.ownerUserId),
  index("jobs_status_available_at_idx").on(table.status, table.availableAt),
  uniqueIndex("jobs_dedupe_key_unique").on(table.dedupeKey),
  uniqueIndex("jobs_id_owner_play_kind_unique").on(table.id, table.ownerUserId, table.playId, table.kind),
  foreignKey({
    name: "jobs_play_owner_fk",
    columns: [table.playId, table.ownerUserId],
    foreignColumns: [plays.id, plays.ownerUserId],
  }).onDelete("cascade"),
]);

export const practiceSessions = pgTable("practice_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  playId: uuid("play_id").notNull(),
  playModelId: uuid("play_model_id").notNull(),
  playModelVersion: integer("play_model_version").notNull(),
  sceneId: text("scene_id").notNull(),
  roleId: text("role_id").notNull(),
  selectedInterpretation: text("selected_interpretation"),
  retentionChoice: text("retention_choice").$type<RetentionChoice>().notNull(),
  practiceMode: text("practice_mode").$type<PracticeMode>().notNull().default("complete_take"),
  ...timestamps,
}, (table) => [
  uniqueIndex("practice_sessions_id_owner_user_id_unique").on(table.id, table.ownerUserId),
  index("practice_sessions_owner_play_idx").on(table.ownerUserId, table.playId),
  foreignKey({ name: "practice_sessions_play_owner_fk",
    columns: [table.playId, table.ownerUserId], foreignColumns: [plays.id, plays.ownerUserId] }).onDelete("cascade"),
  foreignKey({ name: "practice_sessions_model_owner_fk",
    columns: [table.playModelId, table.ownerUserId], foreignColumns: [playModels.id, playModels.ownerUserId] })
    .onDelete("cascade"),
]);

export const rehearsalSessions = pgTable("rehearsal_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  playId: uuid("play_id").notNull(),
  playModelId: uuid("play_model_id").notNull(),
  playModelVersion: integer("play_model_version").notNull(),
  sceneId: text("scene_id").notNull(),
  actorRoleId: text("actor_role_id").notNull(),
  model: text("model").notNull(),
  grantExpiresAt: timestamp("grant_expires_at", { withTimezone: true }).notNull(),
  state: text("state").$type<"grant_issued" | "active" | "paused" | "disconnected" | "recovering"
    | "await_interruption_choice" | "needs_position_confirmation" | "stopped" | "completed">()
    .notNull().default("grant_issued"),
  ...timestamps,
}, (table) => [
  uniqueIndex("rehearsal_sessions_id_owner_user_id_unique").on(table.id, table.ownerUserId),
  index("rehearsal_sessions_owner_play_idx").on(table.ownerUserId, table.playId),
  foreignKey({ name: "rehearsal_sessions_play_owner_fk", columns: [table.playId, table.ownerUserId],
    foreignColumns: [plays.id, plays.ownerUserId] }).onDelete("cascade"),
  foreignKey({ name: "rehearsal_sessions_model_owner_fk", columns: [table.playModelId, table.ownerUserId],
    foreignColumns: [playModels.id, playModels.ownerUserId] }).onDelete("cascade"),
]);

export const rehearsalEvents = pgTable("rehearsal_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  rehearsalSessionId: uuid("rehearsal_session_id").notNull(),
  sequence: integer("sequence").notNull(),
  type: text("type").notNull(),
  event: jsonb("event").$type<PersistedRehearsalEvent>().notNull(),
  receivedAtMs: bigint("received_at_ms", { mode: "number" }),
  receivedClockId: text("received_clock_id"),
  timingSource: text("timing_source").$type<"provider-derived" | "server-receipt">(),
  timingAtMs: bigint("timing_at_ms", { mode: "number" }),
  timingClockId: text("timing_clock_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("rehearsal_events_receipt_timing_check", sql`
    (${table.receivedAtMs} IS NULL AND ${table.receivedClockId} IS NULL)
    OR (${table.receivedAtMs} IS NOT NULL AND ${table.receivedAtMs} >= 0
      AND ${table.receivedClockId} IS NOT NULL AND length(btrim(${table.receivedClockId})) > 0)`),
  check("rehearsal_events_selected_timing_check", sql`
    (${table.timingSource} IS NULL AND ${table.timingAtMs} IS NULL AND ${table.timingClockId} IS NULL)
    OR (${table.timingSource} IN ('provider-derived', 'server-receipt') AND ${table.timingAtMs} IS NOT NULL
      AND ${table.timingAtMs} >= 0 AND ${table.timingClockId} IS NOT NULL
      AND length(btrim(${table.timingClockId})) > 0)`),
  uniqueIndex("rehearsal_events_id_owner_session_unique")
    .on(table.id, table.ownerUserId, table.rehearsalSessionId),
  uniqueIndex("rehearsal_events_session_sequence_unique")
    .on(table.ownerUserId, table.rehearsalSessionId, table.sequence),
  index("rehearsal_events_owner_session_idx")
    .on(table.ownerUserId, table.rehearsalSessionId, table.sequence),
  foreignKey({ name: "rehearsal_events_session_owner_fk",
    columns: [table.rehearsalSessionId, table.ownerUserId],
    foreignColumns: [rehearsalSessions.id, rehearsalSessions.ownerUserId] }).onDelete("cascade"),
]);

export const characterVoiceAssignments = pgTable("character_voice_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  rehearsalSessionId: uuid("rehearsal_session_id").notNull(),
  characterId: text("character_id").notNull(),
  voice: text("voice").notNull(),
  engine: text("engine").$type<"realtime" | "tts">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("character_voice_assignments_session_character_unique")
    .on(table.ownerUserId, table.rehearsalSessionId, table.characterId),
  index("character_voice_assignments_owner_session_idx")
    .on(table.ownerUserId, table.rehearsalSessionId),
  foreignKey({ name: "character_voice_assignments_session_owner_fk",
    columns: [table.rehearsalSessionId, table.ownerUserId],
    foreignColumns: [rehearsalSessions.id, rehearsalSessions.ownerUserId] }).onDelete("cascade"),
]);

export const takes = pgTable("takes", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  practiceSessionId: uuid("practice_session_id").notNull(),
  rehearsalSessionId: uuid("rehearsal_session_id"),
  playId: uuid("play_id").notNull(),
  playModelId: uuid("play_model_id").notNull(),
  playModelVersion: integer("play_model_version").notNull(),
  sceneId: text("scene_id").notNull(),
  roleId: text("role_id").notNull(),
  selectedInterpretation: text("selected_interpretation"),
  retentionChoice: text("retention_choice").$type<RetentionChoice>().notNull(),
  practiceMode: text("practice_mode").$type<PracticeMode>().notNull().default("complete_take"),
  durationMs: integer("duration_ms").notNull(),
  mediaType: text("media_type").$type<"audio/webm" | "audio/wav">().notNull(),
  objectKey: text("object_key").notNull(),
  audioDeletedAt: timestamp("audio_deleted_at", { withTimezone: true }),
  state: text("state").$type<TakeState>().notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("takes_id_owner_user_id_unique").on(table.id, table.ownerUserId),
  uniqueIndex("takes_id_owner_play_unique").on(table.id, table.ownerUserId, table.playId),
  uniqueIndex("takes_id_owner_rehearsal_unique")
    .on(table.id, table.ownerUserId, table.rehearsalSessionId),
  uniqueIndex("takes_object_key_unique").on(table.objectKey),
  index("takes_owner_play_state_idx").on(table.ownerUserId, table.playId, table.state),
  foreignKey({ name: "takes_session_owner_fk", columns: [table.practiceSessionId, table.ownerUserId],
    foreignColumns: [practiceSessions.id, practiceSessions.ownerUserId] }).onDelete("cascade"),
  foreignKey({ name: "takes_rehearsal_owner_fk", columns: [table.rehearsalSessionId, table.ownerUserId],
    foreignColumns: [rehearsalSessions.id, rehearsalSessions.ownerUserId] }),
  foreignKey({ name: "takes_play_owner_fk", columns: [table.playId, table.ownerUserId],
    foreignColumns: [plays.id, plays.ownerUserId] }).onDelete("cascade"),
  foreignKey({ name: "takes_model_owner_fk", columns: [table.playModelId, table.ownerUserId],
    foreignColumns: [playModels.id, playModels.ownerUserId] }).onDelete("cascade"),
]);

export const cueResponseEvidence = pgTable("cue_response_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  takeId: uuid("take_id").notNull(),
  rehearsalSessionId: uuid("rehearsal_session_id").notNull(),
  measurementVersion: text("measurement_version").notNull(),
  cueEventId: uuid("cue_event_id"),
  actorEventId: uuid("actor_event_id"),
  clockId: text("clock_id"),
  delayMs: integer("delay_ms"),
  confidence: text("confidence").$type<"high" | "medium" | "low">().notNull(),
  score: integer("score"),
  ...timestamps,
}, (table) => [
  check("cue_response_evidence_version_check", sql`length(btrim(${table.measurementVersion})) > 0`),
  check("cue_response_evidence_clock_check",
    sql`${table.clockId} IS NULL OR length(btrim(${table.clockId})) > 0`),
  check("cue_response_evidence_delay_check", sql`${table.delayMs} IS NULL OR ${table.delayMs} >= 0`),
  check("cue_response_evidence_confidence_check",
    sql`${table.confidence} IN ('high', 'medium', 'low')`),
  check("cue_response_evidence_score_check", sql`${table.score} IS NULL OR ${table.score} BETWEEN 0 AND 100`),
  check("cue_response_evidence_qualified_check", sql`
    (${table.confidence} = 'low' AND ${table.score} IS NULL)
    OR (${table.confidence} IN ('high', 'medium') AND ${table.score} IS NOT NULL
      AND ${table.delayMs} IS NOT NULL AND ${table.clockId} IS NOT NULL
      AND ${table.cueEventId} IS NOT NULL AND ${table.actorEventId} IS NOT NULL)`),
  uniqueIndex("cue_response_evidence_owner_take_version_unique")
    .on(table.ownerUserId, table.takeId, table.measurementVersion),
  index("cue_response_evidence_owner_take_idx")
    .on(table.ownerUserId, table.takeId, table.measurementVersion),
  foreignKey({ name: "cue_response_evidence_take_chain_fk",
    columns: [table.takeId, table.ownerUserId, table.rehearsalSessionId],
    foreignColumns: [takes.id, takes.ownerUserId, takes.rehearsalSessionId] }).onDelete("cascade"),
  foreignKey({ name: "cue_response_evidence_cue_event_chain_fk",
    columns: [table.cueEventId, table.ownerUserId, table.rehearsalSessionId],
    foreignColumns: [rehearsalEvents.id, rehearsalEvents.ownerUserId,
      rehearsalEvents.rehearsalSessionId] }).onDelete("cascade"),
  foreignKey({ name: "cue_response_evidence_actor_event_chain_fk",
    columns: [table.actorEventId, table.ownerUserId, table.rehearsalSessionId],
    foreignColumns: [rehearsalEvents.id, rehearsalEvents.ownerUserId,
      rehearsalEvents.rehearsalSessionId] }).onDelete("cascade"),
]);

export const takeEvents = pgTable("take_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  takeId: uuid("take_id").notNull(),
  state: text("state").$type<TakeState>().notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("take_events_owner_take_idx").on(table.ownerUserId, table.takeId, table.createdAt),
  foreignKey({ name: "take_events_take_owner_fk", columns: [table.takeId, table.ownerUserId],
    foreignColumns: [takes.id, takes.ownerUserId] }).onDelete("cascade"),
]);

export const takeTranscripts = pgTable("take_transcripts", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  takeId: uuid("take_id").notNull(),
  audioSha256: text("audio_sha256").notNull(),
  transcriberVersion: text("transcriber_version").notNull(),
  provider: text("provider").notNull(),
  modelName: text("model_name").notNull(),
  language: text("language").notNull(),
  text: text("text").notNull(),
  timingSource: text("timing_source").$type<TranscriptTimingSource>().notNull(),
  status: text("status").$type<"current" | "stale">().notNull().default("current"),
  ...timestamps,
}, (table) => [
  uniqueIndex("take_transcripts_id_owner_unique").on(table.id, table.ownerUserId),
  uniqueIndex("take_transcripts_metric_chain_unique")
    .on(table.id, table.ownerUserId, table.takeId, table.status),
  uniqueIndex("take_transcripts_dedupe_unique")
    .on(table.ownerUserId, table.takeId, table.audioSha256, table.transcriberVersion),
  uniqueIndex("take_transcripts_one_current_take_unique")
    .on(table.ownerUserId, table.takeId).where(sql`${table.status} = 'current'`),
  index("take_transcripts_owner_take_idx").on(table.ownerUserId, table.takeId),
  foreignKey({ name: "take_transcripts_take_owner_fk", columns: [table.takeId, table.ownerUserId],
    foreignColumns: [takes.id, takes.ownerUserId] }).onDelete("cascade"),
]);

export const transcriptWords = pgTable("transcript_words", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  transcriptId: uuid("transcript_id").notNull(),
  ordinal: integer("ordinal").notNull(),
  text: text("text").notNull(),
  startMs: integer("start_ms"),
  endMs: integer("end_ms"),
  confidence: real("confidence"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("transcript_words_owner_ordinal_unique").on(table.ownerUserId, table.transcriptId, table.ordinal),
  foreignKey({ name: "transcript_words_transcript_owner_fk", columns: [table.transcriptId, table.ownerUserId],
    foreignColumns: [takeTranscripts.id, takeTranscripts.ownerUserId] }).onDelete("cascade"),
]);

export const lineAlignments = pgTable("line_alignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  transcriptId: uuid("transcript_id").notNull(),
  elementId: text("element_id").notNull(),
  scriptOrdinal: integer("script_ordinal").notNull(),
  transcriptStartMs: integer("transcript_start_ms"),
  transcriptEndMs: integer("transcript_end_ms"),
  similarity: real("similarity").notNull(),
  status: text("status").$type<LineAlignmentStatus>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("line_alignments_owner_element_unique").on(table.ownerUserId, table.transcriptId, table.elementId),
  uniqueIndex("line_alignments_owner_script_ordinal_unique")
    .on(table.ownerUserId, table.transcriptId, table.scriptOrdinal),
  foreignKey({ name: "line_alignments_transcript_owner_fk", columns: [table.transcriptId, table.ownerUserId],
    foreignColumns: [takeTranscripts.id, takeTranscripts.ownerUserId] }).onDelete("cascade"),
]);

export const transcriptUncertaintyRegions = pgTable("transcript_uncertainty_regions", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  transcriptId: uuid("transcript_id").notNull(),
  ordinal: integer("ordinal").notNull(),
  elementId: text("element_id").notNull(),
  startMs: integer("start_ms"),
  endMs: integer("end_ms"),
  reason: text("reason").$type<"low_similarity" | "missing_timing">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("transcript_uncertainty_regions_owner_ordinal_unique")
    .on(table.ownerUserId, table.transcriptId, table.ordinal),
  foreignKey({ name: "transcript_uncertainty_regions_transcript_owner_fk",
    columns: [table.transcriptId, table.ownerUserId],
    foreignColumns: [takeTranscripts.id, takeTranscripts.ownerUserId] }).onDelete("cascade"),
]);

export const takeStageJobChains = pgTable("take_stage_job_chains", {
  jobId: uuid("job_id").primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull(),
  playId: uuid("play_id").notNull(),
  takeId: uuid("take_id").notNull(),
  transcriptId: uuid("transcript_id"),
  transcriptStatus: text("transcript_status").$type<"current" | "stale">(),
  stageKind: text("stage_kind").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("take_stage_job_chains_owner_take_idx").on(table.ownerUserId, table.takeId, table.stageKind),
  uniqueIndex("take_stage_job_chains_exact_transcript_stage_unique")
    .on(table.ownerUserId, table.takeId, table.transcriptId, table.stageKind)
    .where(sql`${table.transcriptId} IS NOT NULL`),
  uniqueIndex("take_stage_job_chains_exact_take_stage_unique")
    .on(table.ownerUserId, table.takeId, table.stageKind)
    .where(sql`${table.transcriptId} IS NULL`),
  foreignKey({ name: "take_stage_job_chains_job_fk",
    columns: [table.jobId, table.ownerUserId, table.playId, table.stageKind],
    foreignColumns: [jobs.id, jobs.ownerUserId, jobs.playId, jobs.kind] }).onDelete("cascade"),
  foreignKey({ name: "take_stage_job_chains_take_fk",
    columns: [table.takeId, table.ownerUserId, table.playId],
    foreignColumns: [takes.id, takes.ownerUserId, takes.playId] }).onDelete("cascade"),
  foreignKey({ name: "take_stage_job_chains_transcript_fk",
    columns: [table.transcriptId, table.ownerUserId, table.takeId, table.transcriptStatus],
    foreignColumns: [takeTranscripts.id, takeTranscripts.ownerUserId, takeTranscripts.takeId,
      takeTranscripts.status] }).onUpdate("cascade").onDelete("cascade"),
]);

export const normalizedAudioArtifacts = pgTable("normalized_audio_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  playId: uuid("play_id").notNull(),
  takeId: uuid("take_id").notNull(),
  transcriptId: uuid("transcript_id").notNull(),
  transcriptStatus: text("transcript_status").$type<"current" | "stale">().notNull().default("current"),
  canonicalObjectKey: text("canonical_object_key").notNull(),
  contentSha256: text("content_sha256").notNull(),
  storageVersionToken: text("storage_version_token").notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("normalized_audio_artifacts_one_per_transcript_unique")
    .on(table.ownerUserId, table.takeId, table.transcriptId),
  uniqueIndex("normalized_audio_artifacts_canonical_object_key_unique").on(table.canonicalObjectKey),
  index("normalized_audio_artifacts_owner_take_status_idx")
    .on(table.ownerUserId, table.takeId, table.transcriptStatus),
  foreignKey({ name: "normalized_audio_artifacts_take_chain_fk",
    columns: [table.takeId, table.ownerUserId, table.playId],
    foreignColumns: [takes.id, takes.ownerUserId, takes.playId] }).onDelete("cascade"),
  foreignKey({ name: "normalized_audio_artifacts_transcript_chain_fk",
    columns: [table.transcriptId, table.ownerUserId, table.takeId, table.transcriptStatus],
    foreignColumns: [takeTranscripts.id, takeTranscripts.ownerUserId, takeTranscripts.takeId,
      takeTranscripts.status] }).onUpdate("cascade").onDelete("cascade"),
]);

export const privateObjectCleanupTasks = pgTable("private_object_cleanup_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull(),
  playId: uuid("play_id").notNull(),
  takeId: uuid("take_id").notNull(),
  transcriptId: uuid("transcript_id").notNull(),
  transcriptStatus: text("transcript_status").$type<"current" | "stale" | "attempted">()
    .notNull().default("current"),
  sourceJobId: uuid("source_job_id").notNull(),
  sourceAttemptCount: integer("source_attempt_count").notNull(),
  sourceLeaseToken: uuid("source_lease_token").notNull(),
  objectKey: text("object_key").notNull(),
  storageVersionToken: text("storage_version_token").notNull(),
  failureCode: text("failure_code").notNull(),
  status: text("status").$type<"queued" | "completed" | "action_required">().notNull().default("queued"),
  lastErrorCode: text("last_error_code"),
  ...timestamps,
}, (table) => [
  uniqueIndex("private_object_cleanup_tasks_source_object_version_unique")
    .on(table.ownerUserId, table.sourceJobId, table.objectKey, table.storageVersionToken),
  index("private_object_cleanup_tasks_owner_take_idx").on(table.ownerUserId, table.takeId, table.createdAt),
]);

export type AccountDeletionObjectInventory = {
  objectKeys: string[];
  versionedObjects: Array<{ objectKey: string; versionToken: string }>;
};

export const accountDeletions = pgTable("account_deletions", {
  id: uuid("id").primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  objectInventory: jsonb("object_inventory").$type<AccountDeletionObjectInventory>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("account_deletions_owner_user_id_unique").on(table.ownerUserId)]);

export const accountDeletionAudits = pgTable("account_deletion_audits", {
  id: uuid("id").primaryKey().defaultRandom(),
  deletionId: uuid("deletion_id").notNull(),
  objectCount: integer("object_count").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
}, (table) => [uniqueIndex("account_deletion_audits_deletion_id_unique").on(table.deletionId)]);

export type TakeMetricSummary = Omit<TakeMetrics, "lines">;

export const takeMetrics = pgTable("take_metrics", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  takeId: uuid("take_id").notNull(),
  transcriptId: uuid("transcript_id").notNull(),
  transcriptStatus: text("transcript_status").$type<"current" | "stale">().notNull().default("current"),
  measurementVersion: text("measurement_version").notNull(),
  metrics: jsonb("metrics").$type<TakeMetricSummary>().notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("take_metrics_id_owner_transcript_unique").on(table.id, table.ownerUserId, table.transcriptId),
  uniqueIndex("take_metrics_publication_dedupe_unique")
    .on(table.ownerUserId, table.takeId, table.transcriptId, table.measurementVersion),
  index("take_metrics_owner_take_status_idx").on(table.ownerUserId, table.takeId, table.transcriptStatus),
  foreignKey({ name: "take_metrics_current_transcript_fk",
    columns: [table.transcriptId, table.ownerUserId, table.takeId, table.transcriptStatus],
    foreignColumns: [takeTranscripts.id, takeTranscripts.ownerUserId, takeTranscripts.takeId,
      takeTranscripts.status] }).onUpdate("cascade").onDelete("cascade"),
]);

export const takeMetricLines = pgTable("take_metric_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  takeMetricId: uuid("take_metric_id").notNull(),
  transcriptId: uuid("transcript_id").notNull(),
  elementId: text("element_id").notNull(),
  startMs: integer("start_ms").notNull(),
  endMs: integer("end_ms").notNull(),
  speechDurationMs: integer("speech_duration_ms").notNull(),
  silenceDurationMs: integer("silence_duration_ms").notNull(),
  rmsDb: real("rms_db").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("take_metric_lines_owner_element_unique").on(table.ownerUserId, table.takeMetricId,
    table.elementId),
  index("take_metric_lines_owner_metric_idx").on(table.ownerUserId, table.takeMetricId),
  foreignKey({ name: "take_metric_lines_metric_chain_fk",
    columns: [table.takeMetricId, table.ownerUserId, table.transcriptId],
    foreignColumns: [takeMetrics.id, takeMetrics.ownerUserId, takeMetrics.transcriptId] }).onDelete("cascade"),
  foreignKey({ name: "take_metric_lines_alignment_chain_fk",
    columns: [table.ownerUserId, table.transcriptId, table.elementId],
    foreignColumns: [lineAlignments.ownerUserId, lineAlignments.transcriptId, lineAlignments.elementId] }),
]);

export const coachingReports = pgTable("coaching_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  playId: uuid("play_id").notNull(),
  takeId: uuid("take_id").notNull(),
  transcriptId: uuid("transcript_id").notNull(),
  transcriptStatus: text("transcript_status").$type<"current" | "stale">().notNull().default("current"),
  measurementId: uuid("measurement_id").notNull(),
  status: text("status").$type<"processing" | "completed" | "completed_with_limitations"
    | "action_required">().notNull().default("processing"),
  audioReviewStatus: text("audio_review_status").$type<"pending" | "completed" | "failed">()
    .notNull().default("pending"),
  evidence: jsonb("evidence").$type<CoachingEvidence[]>().notNull().default([]),
  report: jsonb("report").$type<CoachingReport | null>(),
  synthesisErrorCode: text("synthesis_error_code"),
  ...timestamps,
}, (table) => [
  uniqueIndex("coaching_reports_owner_take_transcript_unique")
    .on(table.ownerUserId, table.takeId, table.transcriptId),
  index("coaching_reports_owner_take_status_idx").on(table.ownerUserId, table.takeId, table.status),
  foreignKey({ name: "coaching_reports_take_chain_fk",
    columns: [table.takeId, table.ownerUserId, table.playId],
    foreignColumns: [takes.id, takes.ownerUserId, takes.playId] }).onDelete("cascade"),
  foreignKey({ name: "coaching_reports_transcript_chain_fk",
    columns: [table.transcriptId, table.ownerUserId, table.takeId, table.transcriptStatus],
    foreignColumns: [takeTranscripts.id, takeTranscripts.ownerUserId, takeTranscripts.takeId,
      takeTranscripts.status] }).onUpdate("cascade").onDelete("cascade"),
  foreignKey({ name: "coaching_reports_measurement_chain_fk",
    columns: [table.measurementId, table.ownerUserId, table.transcriptId],
    foreignColumns: [takeMetrics.id, takeMetrics.ownerUserId, takeMetrics.transcriptId] }).onDelete("cascade"),
]);
