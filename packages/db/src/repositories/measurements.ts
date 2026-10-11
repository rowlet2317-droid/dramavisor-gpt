import type { TakeMetrics } from "@drama/domain/audio-metrics";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import * as schema from "../schema";
import { lineAlignments, takeMetricLines, takeMetrics, takeTranscripts } from "../schema";

export type PublishMeasurementInput = {
  ownerUserId: string;
  takeId: string;
  transcriptId: string;
  measurementVersion: string;
  metrics: TakeMetrics;
};

export class MeasurementPublicationError extends Error {
  constructor(readonly code: "STALE_TRANSCRIPT" | "INVALID_METRIC_CHAIN") {
    super(code);
    this.name = "MeasurementPublicationError";
  }
}

export class MeasurementRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: PgDatabase<TQueryResult, typeof schema>) {}

  async publishCurrent(input: PublishMeasurementInput) {
    return this.db.transaction((transaction) => publishMeasurementCurrent(transaction, input));
  }

  async getCurrentForTake(ownerUserId: string, takeId: string, measurementVersion: string) {
    return this.db.transaction(async (transaction) => {
      const [currentTranscript] = await transaction.select({ id: takeTranscripts.id })
        .from(takeTranscripts).where(and(
          eq(takeTranscripts.ownerUserId, ownerUserId),
          eq(takeTranscripts.takeId, takeId),
          eq(takeTranscripts.status, "current"),
        )).for("update").limit(1);
      if (!currentTranscript) return null;
      const measurementConditions = and(
        eq(takeMetrics.ownerUserId, ownerUserId),
        eq(takeMetrics.takeId, takeId),
        eq(takeMetrics.transcriptId, currentTranscript.id),
        eq(takeMetrics.transcriptStatus, "current"),
        eq(takeMetrics.measurementVersion, measurementVersion),
      );
      const [measurement] = await transaction.select().from(takeMetrics).where(measurementConditions)
        .for("share").limit(1);
      if (!measurement) return null;
      const lines = await transaction.select().from(takeMetricLines).where(and(
        eq(takeMetricLines.ownerUserId, ownerUserId),
        eq(takeMetricLines.takeMetricId, measurement.id),
      )).orderBy(asc(takeMetricLines.startMs), asc(takeMetricLines.elementId));
      const [stillCurrent] = await transaction.select({ id: takeTranscripts.id }).from(takeTranscripts)
        .where(and(
          eq(takeTranscripts.id, currentTranscript.id),
          eq(takeTranscripts.ownerUserId, ownerUserId),
          eq(takeTranscripts.takeId, takeId),
          eq(takeTranscripts.status, "current"),
        )).limit(1);
      if (!stillCurrent) return null;
      return { measurement, lines };
    });
  }
}

/** Publishes inside an existing transaction when callers must fence a job completion atomically. */
export async function publishMeasurementCurrent<TQueryResult extends PgQueryResultHKT>(
  transaction: PgDatabase<TQueryResult, typeof schema>, input: PublishMeasurementInput,
) {
  const [currentTranscript] = await transaction.select({ id: takeTranscripts.id })
    .from(takeTranscripts).where(and(
      eq(takeTranscripts.id, input.transcriptId),
      eq(takeTranscripts.ownerUserId, input.ownerUserId),
      eq(takeTranscripts.takeId, input.takeId),
      eq(takeTranscripts.status, "current"),
    )).for("update").limit(1);
  if (!currentTranscript) throw new MeasurementPublicationError("STALE_TRANSCRIPT");

  const elementIds = Array.from(new Set(input.metrics.lines.map(({ elementId }) => elementId)));
  if (elementIds.length !== input.metrics.lines.length) {
    throw new MeasurementPublicationError("INVALID_METRIC_CHAIN");
  }
  if (elementIds.length > 0) {
    const validAlignments = await transaction.select({ elementId: lineAlignments.elementId })
      .from(lineAlignments).where(and(
        eq(lineAlignments.ownerUserId, input.ownerUserId),
        eq(lineAlignments.transcriptId, input.transcriptId),
        inArray(lineAlignments.elementId, elementIds),
      ));
    if (validAlignments.length !== elementIds.length) {
      throw new MeasurementPublicationError("INVALID_METRIC_CHAIN");
    }
  }

  const { lines, ...summary } = input.metrics;
  const [inserted] = await transaction.insert(takeMetrics).values({
    ownerUserId: input.ownerUserId,
    takeId: input.takeId,
    transcriptId: input.transcriptId,
    transcriptStatus: "current",
    measurementVersion: input.measurementVersion,
    metrics: summary,
  }).onConflictDoNothing({ target: [takeMetrics.ownerUserId, takeMetrics.takeId, takeMetrics.transcriptId,
    takeMetrics.measurementVersion] }).returning();

  if (!inserted) {
    const [measurement] = await transaction.select().from(takeMetrics).where(and(
      eq(takeMetrics.ownerUserId, input.ownerUserId),
      eq(takeMetrics.takeId, input.takeId),
      eq(takeMetrics.transcriptId, input.transcriptId),
      eq(takeMetrics.measurementVersion, input.measurementVersion),
    )).limit(1);
    if (!measurement) throw new MeasurementPublicationError("INVALID_METRIC_CHAIN");
    const storedLines = await transaction.select().from(takeMetricLines).where(and(
      eq(takeMetricLines.ownerUserId, input.ownerUserId),
      eq(takeMetricLines.takeMetricId, measurement.id),
    )).orderBy(asc(takeMetricLines.startMs), asc(takeMetricLines.elementId));
    return { measurement, lines: storedLines, deduplicated: true };
  }

  if (lines.length > 0) {
    await transaction.insert(takeMetricLines).values(lines.map((line) => ({
      ownerUserId: input.ownerUserId,
      takeMetricId: inserted.id,
      transcriptId: input.transcriptId,
      ...line,
    })));
  }
  const storedLines = await transaction.select().from(takeMetricLines).where(and(
    eq(takeMetricLines.ownerUserId, input.ownerUserId),
    eq(takeMetricLines.takeMetricId, inserted.id),
  )).orderBy(asc(takeMetricLines.startMs), asc(takeMetricLines.elementId));
  return { measurement: inserted, lines: storedLines, deduplicated: false };
}
