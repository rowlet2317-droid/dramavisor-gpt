"use client";

import { useEffect, useRef, useState } from "react";

import type { CoachingEvidence } from "@drama/domain/coaching";

export type EvidenceAudio = {
  currentTime: number;
  readyState: number;
  play: () => Promise<void>;
  pause: () => void;
  addEventListener: (name: "timeupdate" | "loadedmetadata", listener: () => void) => void;
  removeEventListener: (name: "timeupdate" | "loadedmetadata", listener: () => void) => void;
};

export function startEvidencePlayback(
  audio: EvidenceAudio,
  evidence: CoachingEvidence,
  highlight: (elementIds: string[]) => void,
): () => void {
  if (evidence.startMs === null || evidence.endMs === null) {
    highlight(evidence.elementIds);
    return () => highlight([]);
  }
  let active = true;
  highlight(evidence.elementIds);
  const stopAtEnd = () => {
    if (active && audio.currentTime >= evidence.endMs! / 1_000) {
      audio.pause();
      audio.removeEventListener("timeupdate", stopAtEnd);
      active = false;
    }
  };
  const begin = () => {
    if (!active) return;
    audio.removeEventListener("loadedmetadata", begin);
    audio.currentTime = evidence.startMs! / 1_000;
    audio.addEventListener("timeupdate", stopAtEnd);
    void audio.play();
  };
  if (audio.readyState === 0) audio.addEventListener("loadedmetadata", begin);
  else begin();
  return () => {
    audio.removeEventListener("loadedmetadata", begin);
    if (active) audio.removeEventListener("timeupdate", stopAtEnd);
    active = false;
    highlight([]);
  };
}

export function EvidencePlayer({ audioUrl, durationMs, evidence, lines }: {
  audioUrl: string | null;
  durationMs: number;
  evidence: CoachingEvidence[];
  lines: Array<{ elementId: string; text: string; startMs?: number | null; endMs?: number | null }>;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const [activeElementIds, setActiveElementIds] = useState<string[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const displayedDuration = resolveAudioDuration(audioDuration, durationMs);

  useEffect(() => () => stopRef.current?.(), []);

  function play(item: CoachingEvidence): void {
    const audio = audioRef.current;
    if (!audio) return;
    stopRef.current?.();
    stopRef.current = startEvidencePlayback(audio, item, setActiveElementIds);
  }

  function seek(seconds: number): void {
    const audio = audioRef.current;
    if (!audio) return;
    stopRef.current?.(); stopRef.current = null;
    audio.currentTime = seconds;
    setCurrentTime(seconds);
  }

  function togglePlayback(): void {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) audio.pause(); else void audio.play();
  }

  return <section className="evidence-player" aria-labelledby="evidence-heading">
    <h2 id="evidence-heading">Evidence replay</h2>
    {audioUrl ? <div className="evidence-audio-controls">
      <audio ref={audioRef} src={audioUrl} preload="auto"
        onLoadedMetadata={(event) => setAudioDuration(readMediaDuration(event.currentTarget.duration))}
        onDurationChange={(event) => setAudioDuration(readMediaDuration(event.currentTarget.duration))}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
      <button type="button" onClick={togglePlayback}>{playing ? "Pause recording" : "Play recording"}</button>
      <input aria-label="Recording position" type="range" min={0} max={displayedDuration} step={0.1}
        value={Math.min(currentTime, displayedDuration)} onChange={(event) => seek(Number(event.currentTarget.value))} />
      <output>{formatTime(currentTime)} / {formatTime(displayedDuration)}</output>
    </div>
      : <p>Audio was deleted. Transcript and measurement evidence remain available.</p>}
    <ul className="evidence-list">
      {evidence.map((item) => <li key={item.id}>
        <p>{formatEvidenceDescription(item)}</p>
        <span className={`confidence confidence--${item.confidence}`}>{item.confidence} confidence</span>
        {audioUrl && item.startMs !== null && item.endMs !== null
          ? <button type="button" onClick={() => play(item)}>Play evidence</button>
          : null}
      </li>)}
    </ul>
    <div className="evidence-script" aria-label="Linked script passages">
      {lines.map((line) => <div key={line.elementId}
        className={activeElementIds.includes(line.elementId) ? "evidence-script__line is-active"
          : "evidence-script__line"} data-element-id={line.elementId}>
        <p>{line.text}</p>
        {audioUrl && line.startMs !== null && line.startMs !== undefined
          && line.endMs !== null && line.endMs !== undefined
          ? <button type="button" onClick={() => play({ id: `line:${line.elementId}`,
            kind: "transcript_alignment", confidence: "high", description: line.text,
            startMs: line.startMs!, endMs: line.endMs!, elementIds: [line.elementId] })}>
            Play line
          </button> : null}
      </div>)}
    </div>
  </section>;
}

export function formatEvidenceDescription(evidence: CoachingEvidence): string {
  if (!evidence.id.startsWith("metric-")) return evidence.description;
  const separator = evidence.description.indexOf(":");
  if (separator < 0) return evidence.description;
  let metric: Record<string, unknown>;
  try {
    const parsed = JSON.parse(evidence.description.slice(separator + 1)) as unknown;
    if (typeof parsed !== "object" || parsed === null) return evidence.description;
    metric = parsed as Record<string, unknown>;
  } catch {
    return evidence.description;
  }
  if (metric.confidence === "insufficient_data") {
    return `${metricLabel(evidence.id)} could not be measured reliably for this recording.`;
  }
  if (evidence.id === "metric-pace" && typeof metric.wordsPerMinute === "number") {
    return `Measured pace: ${Math.round(metric.wordsPerMinute)} words per minute.`;
  }
  if (evidence.id === "metric-loudness" && typeof metric.rmsDb === "number") {
    return `Measured average loudness: ${metric.rmsDb.toFixed(1)} dB.`;
  }
  if (evidence.id === "metric-pitch" && typeof metric.medianHz === "number") {
    return `Measured median pitch: ${Math.round(metric.medianHz)} Hz.`;
  }
  return evidence.description;
}

function metricLabel(id: string): string {
  if (id === "metric-pace") return "Pace";
  if (id === "metric-loudness") return "Loudness";
  if (id === "metric-pitch") return "Pitch variation";
  return "This vocal measurement";
}

export function resolveAudioDuration(metadataDuration: number | null, recordedDurationMs: number): number {
  return metadataDuration !== null && Number.isFinite(metadataDuration) && metadataDuration >= 0
    ? metadataDuration
    : Math.max(0, recordedDurationMs / 1_000);
}

function readMediaDuration(duration: number): number | null {
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
