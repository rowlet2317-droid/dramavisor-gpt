import { getDatabase } from "@drama/db/client";
import { playModels, takeMetrics, takes } from "@drama/db/schema";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { notFound } from "next/navigation";

import { RecordingHistory } from "../../../../components/coaching/recording-history";
import { requirePageUser } from "../../../../lib/auth/page-session";

export default async function RecordingsPage({ params }: { params: Promise<{ playId: string }> }) {
  const user = await requirePageUser();
  const { playId } = await params;
  const db = getDatabase();
  const rows = await db.select({ take: takes, model: playModels.model }).from(takes)
    .innerJoin(playModels, and(eq(playModels.id, takes.playModelId), eq(playModels.ownerUserId, takes.ownerUserId),
      eq(playModels.version, takes.playModelVersion)))
    .where(and(eq(takes.ownerUserId, user.id), eq(takes.playId, playId), isNull(takes.audioDeletedAt)))
    .orderBy(desc(takes.createdAt));
  if (!rows.length) {
    const [owned] = await db.select({ id: playModels.id }).from(playModels)
      .where(and(eq(playModels.playId, playId), eq(playModels.ownerUserId, user.id))).limit(1);
    if (!owned) notFound();
  }
  const measurements = rows.length ? await db.select({ takeId: takeMetrics.takeId, metrics: takeMetrics.metrics })
    .from(takeMetrics).where(and(eq(takeMetrics.ownerUserId, user.id),
      eq(takeMetrics.transcriptStatus, "current"), inArray(takeMetrics.takeId, rows.map(({ take }) => take.id)))) : [];
  const measuredDurations = new Map(measurements.map(({ takeId, metrics }) => [takeId, metrics.durationMs]));
  const items = rows.map(({ take, model }) => ({ id: take.id, createdAt: take.createdAt.toISOString(),
    durationMs: take.durationMs, verifyDuration: take.mediaType === "audio/webm", state: take.state,
    sceneTitle: model.acts.flatMap(({ scenes }) => scenes).find(({ id }) => id === take.sceneId)?.title ?? "Scene",
    roleName: model.characters.find(({ id }) => id === take.roleId)?.name ?? "Role" }));
  return <><header className="study-header"><p className="eyebrow">Private performance history</p>
    <h2>Recordings &amp; coaching</h2><p>Revisit saved takes or permanently remove a recording and its analysis.</p>
  </header><section className="study-section"><RecordingHistory playId={playId} initialItems={items} /></section></>;
}
