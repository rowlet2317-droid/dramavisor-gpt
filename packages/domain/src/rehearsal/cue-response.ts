export const CUE_RESPONSE_VERSION = "cue-response-v1" as const;

export type CueResponseConfidence = "high" | "medium" | "low";
export type RehearsalTimestampSource = "provider-derived" | "server-receipt";

export type CueResponseTimelineEvent = {
  id: string;
  sequence: number;
  type: "ai_speech_finished" | "actor_line_completed";
  elementId: string;
  timestamp: { atMs: number; source: RehearsalTimestampSource; clockId: string } | null;
};

export type CueResponseTimeline = {
  cueElementId: string;
  actorElementId: string;
  events: CueResponseTimelineEvent[];
};

export type CueResponseEvidence = {
  version: typeof CUE_RESPONSE_VERSION;
  cueEventId: string | null;
  actorEventId: string | null;
  clockId: string | null;
  delayMs: number | null;
  confidence: CueResponseConfidence;
  score: number | null;
};

export function measureCueResponse(timeline: CueResponseTimeline): CueResponseEvidence {
  const cues = timeline.events.filter((event) => event.type === "ai_speech_finished"
    && event.elementId === timeline.cueElementId).sort((left, right) => left.sequence - right.sequence);
  const actors = timeline.events.filter((event) => event.type === "actor_line_completed"
    && event.elementId === timeline.actorElementId).sort((left, right) => left.sequence - right.sequence);
  let cue = cues[0];
  let actor = actors[0];
  for (const candidate of actors) {
    const precedingCue = cues.filter((event) => event.sequence < candidate.sequence).at(-1);
    if (!precedingCue) continue;
    cue = precedingCue;
    actor = candidate;
    break;
  }
  const low = (): CueResponseEvidence => ({ version: CUE_RESPONSE_VERSION,
    cueEventId: cue?.id ?? null, actorEventId: actor?.id ?? null, clockId: null,
    delayMs: null, confidence: "low", score: null });
  if (!cue || !actor || actor.sequence <= cue.sequence || !cue.timestamp || !actor.timestamp) return low();
  if (cue.timestamp.source !== actor.timestamp.source || cue.timestamp.clockId !== actor.timestamp.clockId
    || !Number.isFinite(cue.timestamp.atMs) || !Number.isFinite(actor.timestamp.atMs)) return low();
  const delayMs = actor.timestamp.atMs - cue.timestamp.atMs;
  if (!Number.isInteger(delayMs) || delayMs < 0) return low();
  return { version: CUE_RESPONSE_VERSION, cueEventId: cue.id, actorEventId: actor.id,
    clockId: cue.timestamp.clockId, delayMs,
    confidence: cue.timestamp.source === "provider-derived" ? "high" : "medium",
    score: scoreCueResponseDelay(delayMs) };
}

export function scoreCueResponseDelay(delayMs: number): number {
  if (delayMs <= 500) return 100;
  if (delayMs <= 1_000) return 85;
  if (delayMs <= 1_500) return 70;
  if (delayMs <= 2_500) return 55;
  return 40;
}
