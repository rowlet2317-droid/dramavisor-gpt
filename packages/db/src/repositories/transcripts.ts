import { and, asc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import * as schema from "../schema";
import { lineAlignments, takeTranscripts, transcriptUncertaintyRegions, transcriptWords } from "../schema";

export class TranscriptRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: PgDatabase<TQueryResult, typeof schema>) {}

  async getCurrentForTake(ownerUserId: string, takeId: string) {
    const [transcript] = await this.db.select().from(takeTranscripts).where(and(
      eq(takeTranscripts.ownerUserId, ownerUserId),
      eq(takeTranscripts.takeId, takeId),
      eq(takeTranscripts.status, "current"),
    )).limit(1);
    if (!transcript) return null;
    const [words, alignments, uncertaintyRegions] = await Promise.all([
      this.db.select().from(transcriptWords).where(and(eq(transcriptWords.ownerUserId, ownerUserId),
        eq(transcriptWords.transcriptId, transcript.id))).orderBy(asc(transcriptWords.ordinal)),
      this.db.select().from(lineAlignments).where(and(eq(lineAlignments.ownerUserId, ownerUserId),
        eq(lineAlignments.transcriptId, transcript.id)))
        .orderBy(asc(lineAlignments.scriptOrdinal), asc(lineAlignments.id)),
      this.db.select().from(transcriptUncertaintyRegions).where(and(
        eq(transcriptUncertaintyRegions.ownerUserId, ownerUserId),
        eq(transcriptUncertaintyRegions.transcriptId, transcript.id),
      )).orderBy(asc(transcriptUncertaintyRegions.ordinal)),
    ]);
    return { transcript, words, alignments, uncertaintyRegions };
  }
}
