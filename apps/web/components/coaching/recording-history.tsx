"use client";

import { useState } from "react";

export type RecordingHistoryItem = { id: string; createdAt: string; durationMs: number; state: string;
  sceneTitle: string; roleName: string; verifyDuration?: boolean };

export function RecordingHistory({ playId, initialItems }: { playId: string; initialItems: RecordingHistoryItem[] }) {
  const [items, setItems] = useState(initialItems);
  const [pendingMetadataIds, setPendingMetadataIds] = useState(
    initialItems.filter(({ verifyDuration }) => verifyDuration).map(({ id }) => id),
  );
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function remove(takeId: string): Promise<void> {
    if (!window.confirm("Remove this recording and its coaching analysis? This cannot be undone.")) return;
    setRemoving(takeId); setError("");
    try {
      const response = await fetch(`/api/plays/${encodeURIComponent(playId)}/takes/${encodeURIComponent(takeId)}/remove`,
        { method: "DELETE" });
      if (!response.ok) throw new Error("The recording could not be removed");
      setItems((current) => current.filter(({ id }) => id !== takeId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The recording could not be removed");
    } finally { setRemoving(null); }
  }

  function useMediaDuration(takeId: string, seconds: number): boolean {
    if (!Number.isFinite(seconds) || seconds <= 0) return false;
    const durationMs = Math.round(seconds * 1_000);
    setItems((current) => current.map((item) => item.id === takeId
      ? { ...item, durationMs } : item));
    void fetch(`/api/plays/${encodeURIComponent(playId)}/takes/${encodeURIComponent(takeId)}/duration`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ durationMs }),
    }).catch(() => undefined);
    return true;
  }

  const metadataItem = items.find(({ id }) => id === pendingMetadataIds[0]);
  function finishMetadata(takeId: string, seconds: number): boolean {
    if (!useMediaDuration(takeId, seconds)) return false;
    setPendingMetadataIds((current) => current[0] === takeId ? current.slice(1) : current);
    return true;
  }

  if (!items.length) return <p className="muted">No saved recordings yet.</p>;
  return <>{error ? <p role="alert">{error}</p> : null}
    {metadataItem ? <audio key={metadataItem.id} className="recording-history__metadata" preload="metadata"
      src={`/api/plays/${encodeURIComponent(playId)}/takes/${encodeURIComponent(metadataItem.id)}/audio`}
      onLoadedMetadata={(event) => {
        if (!finishMetadata(metadataItem.id, event.currentTarget.duration)) {
          // Chrome can initially report Infinity for streaming WebM files. A
          // far seek makes it scan the final cluster and emit a finite
          // durationchange, as it does in the coaching report player.
          event.currentTarget.currentTime = Number.MAX_SAFE_INTEGER;
        }
      }}
      onDurationChange={(event) => finishMetadata(metadataItem.id, event.currentTarget.duration)}
      onError={() => setPendingMetadataIds((current) => current[0] === metadataItem.id ? current.slice(1) : current)} />
      : null}
    <ol className="recording-history">{items.map((item) =>
    <li key={item.id}><div><strong>{item.sceneTitle}</strong><p>{item.roleName} · {formatDuration(item.durationMs)} ·
      {" "}{new Date(item.createdAt).toLocaleString()}</p></div><div>
      <audio className="recording-history__metadata" preload="metadata"
        src={`/api/plays/${encodeURIComponent(playId)}/takes/${encodeURIComponent(item.id)}/audio`}
        onLoadedMetadata={(event) => useMediaDuration(item.id, event.currentTarget.duration)}
        onDurationChange={(event) => useMediaDuration(item.id, event.currentTarget.duration)} />
      <a className="button-link" href={`/plays/${encodeURIComponent(playId)}/takes/${item.id}`}>Open coaching</a>
      <button type="button" disabled={removing === item.id} onClick={() => void remove(item.id)}>
        {removing === item.id ? "Removing…" : "Remove"}</button></div></li>)}</ol></>;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
