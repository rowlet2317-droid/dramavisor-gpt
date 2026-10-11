"use client";

import { useState } from "react";

export function DeletePlayButton({ playId, title }: { playId: string; title: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function deletePlay() {
    if (!window.confirm(`Delete “${title}”? This cannot be undone.`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/plays/${playId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Unable to delete this play.");
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to delete this play.");
      setBusy(false);
    }
  }

  return <div className="play-card__delete">
    <button className="danger-button" type="button" onClick={deletePlay} disabled={busy}>
      {busy ? "Deleting…" : "Delete"}
    </button>
    {error ? <span role="alert">{error}</span> : null}
  </div>;
}
