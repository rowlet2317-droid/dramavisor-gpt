"use client";

import { useEffect, useState } from "react";

export function RolePicker({ playId, characters, selectedCharacterId }: {
  playId: string;
  characters: { id: string; name: string }[];
  selectedCharacterId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => setHydrated(true), []);
  async function generate() {
    if (!selectedCharacterId) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/plays/${playId}/my-role`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ characterId: selectedCharacterId }) });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (response.ok) {
        window.location.reload();
        return;
      }
      setMessage(result.error ?? "Unable to build workbook");
    } catch {
      setMessage("Unable to reach the workbook service. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return <section className="role-picker"><h3>Select My Role</h3><div className="role-options">
    {characters.map((character) => <a className={character.id === selectedCharacterId ? "selected" : ""}
      key={character.id} href={`/plays/${playId}/my-role?characterId=${encodeURIComponent(character.id)}`}>
      {character.name}</a>)}
  </div>{selectedCharacterId ? <button type="button" onClick={generate} disabled={!hydrated || busy}>
    {busy ? "Building workbook…" : "Build or refresh workbook"}</button> : null}
    {message ? <p role="status">{message}</p> : null}</section>;
}
