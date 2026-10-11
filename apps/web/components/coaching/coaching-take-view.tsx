"use client";

import { useEffect, useState } from "react";

import type { CoachingEvidence, CoachingReport } from "@drama/domain/coaching";
import type { TakeComparison as Comparison } from "@drama/domain/take-comparison";

import { EvidencePlayer } from "./evidence-player";
import { PriorityNotes } from "./priority-notes";
import { RatingCard } from "./rating-card";
import { TakeComparison } from "./take-comparison";

type TakeReportResponse = {
  take: { id: string; state: string; durationMs: number; mediaType: string; audioDeletedAt: string | null };
  coaching: { status: string; audioReviewStatus: string; evidence: CoachingEvidence[]; report: CoachingReport | null;
    synthesisErrorCode: string | null } | null;
  comparison: { previousTakeId: string; scores: Comparison } | null;
  scriptLines: Array<{ elementId: string; text: string; startMs: number | null; endMs: number | null }>;
  audioUrl: string | null;
};

export function CoachingTakeView({ playId, takeId }: { playId: string; takeId: string }) {
  const [data, setData] = useState<TakeReportResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load(): Promise<void> {
      try {
        const response = await fetch(`/api/plays/${encodeURIComponent(playId)}/takes/${encodeURIComponent(takeId)}`,
          { cache: "no-store" });
        if (!response.ok) throw new Error("Unable to load coaching");
        const next = await response.json() as TakeReportResponse;
        if (!active) return;
        setData(next);
        setFailed(false);
        if (isCoachingPending(next.take.state, next.coaching)) timer = setTimeout(() => void load(), 2_000);
      } catch {
        if (active) setFailed(true);
      }
    }
    void load();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [playId, takeId, reloadKey]);

  async function retryCoaching(): Promise<void> {
    setRetrying(true);
    setRetryError(null);
    try {
      const response = await fetch(
        `/api/plays/${encodeURIComponent(playId)}/takes/${encodeURIComponent(takeId)}/retry-coaching`,
        { method: "POST" },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(typeof body?.error === "string" ? body.error : "Unable to retry coaching");
      }
      setData(null);
      setReloadKey((value) => value + 1);
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : "Unable to retry coaching");
    } finally {
      setRetrying(false);
    }
  }

  if (failed) return <p role="alert">The coaching report could not be loaded. Try again.</p>;
  if (!data || isCoachingPending(data.take.state, data.coaching)) return <section className="processing-card">
    <p className="eyebrow">Analysis in progress</p><h1>Your coaching is being prepared</h1>
    <p>Transcription, vocal measurements, and evidence review run before feedback appears.</p>
  </section>;
  if (data.take.state === "action_required" || !data.coaching?.report) return <section className="processing-card">
    <p className="eyebrow">Analysis needs attention</p><h1>Coaching could not be completed</h1>
    <p>{coachingFailureMessage(data.coaching?.synthesisErrorCode ?? null)}</p>
    {data.audioUrl ? <section aria-labelledby="recording-heading">
      <h2 id="recording-heading">Review your recorded take</h2>
      <audio controls preload="auto" src={data.audioUrl}>Your browser cannot play this recording.</audio>
    </section> : <p>The retained recording is unavailable, but its transcript and measurements remain.</p>}
    <button type="button" disabled={retrying} onClick={() => void retryCoaching()}>
      {retrying ? "Retrying analysis…" : "Retry analysis"}
    </button>
    {retryError ? <p role="alert">{retryError}</p> : null}
  </section>;

  const report = data.coaching.report;
  return <>
    <div className="coaching-report-actions">
      <button type="button" disabled={retrying} onClick={() => void retryCoaching()}>
        {retrying ? "Redoing analysis…" : "Redo analysis"}
      </button>
      <p>Run the coaching analysis again using this take’s existing transcript and measurements.</p>
      {retryError ? <p role="alert">{retryError}</p> : null}
    </div>
    {data.coaching.status === "completed_with_limitations" ? <p className="limitation-banner">
      {coachingLimitationMessage(data.coaching.audioReviewStatus)}
    </p> : null}
    <section className="rating-grid" aria-label="Coaching ratings">
      {report.ratings.map((rating) => <RatingCard key={rating.category} rating={rating} />)}
    </section>
    <PriorityNotes report={report} />
    <TakeComparison comparison={data.comparison?.scores ?? null} />
    <EvidencePlayer audioUrl={data.audioUrl} durationMs={data.take.durationMs}
      evidence={data.coaching.evidence} lines={data.scriptLines} />
  </>;
}

export function isCoachingPending(
  takeState: string,
  coaching: Pick<NonNullable<TakeReportResponse["coaching"]>, "status" | "report"> | null,
): boolean {
  if (["queued", "processing"].includes(takeState)) return true;
  return takeState !== "action_required" && (coaching === null || coaching.status === "processing");
}

export function coachingFailureMessage(code: string | null): string {
  if (!code) return "No failure code was recorded for this take. You can retry this same recorded take.";
  const http = /^OPENAI_COACHING_HTTP_(\d{3})$/u.exec(code);
  if (http) return `The coaching provider returned HTTP ${http[1]}. You can retry this same recorded take.`;
  if (code === "INVALID_COACHING_SYNTHESIS") {
    return "The coaching provider returned an unusable coaching response. You can retry this same recorded take.";
  }
  return `Coaching analysis failed: ${code}. You can retry this same recorded take.`;
}

export function coachingLimitationMessage(audioReviewStatus: string): string {
  return audioReviewStatus === "failed"
    ? "Audio interpretation was unavailable; this report uses transcript and measured vocal evidence."
    : "Some generated coaching interpretation was unavailable; this report preserves the verified evidence and ratings.";
}
