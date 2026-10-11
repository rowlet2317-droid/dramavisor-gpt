"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { ReviewCorrection } from "@drama/domain/parse-review";

type ReviewIssue = {
  id: string;
  kind: "character_name" | "dialogue_owner" | "scene_boundary" | "unreadable_text";
  message: string;
  elementIds: string[];
};

export function ReviewControls({ playId, expectedModelId, expectedModelVersion, issues, elements, characters }: {
  playId: string;
  expectedModelId: string;
  expectedModelVersion: number;
  issues: ReviewIssue[];
  elements: { id: string; text: string; kind: string; characterId?: string; sceneId: string }[];
  characters: { id: string; name: string }[];
}) {
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [message, setMessage] = useState("");
  const elementById = new Map(elements.map((element) => [element.id, element]));
  const boundaryIssues = issues.filter((issue) => issue.kind === "scene_boundary"
    && issue.elementIds.some((elementId) => elementById.has(elementId)));
  const resolvingBoundary = boundaryIssues.length > 0;

  useEffect(() => setHydrated(true), []);

  async function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    const corrections: ReviewCorrection[] = [];
    if (resolvingBoundary) {
      const selected = parseBoundarySelection(form.get("sceneBoundaryCandidate"));
      const element = selected ? elementById.get(selected.elementId) : undefined;
      if (!selected || !element) {
        setMessage("Choose a scene boundary to save.");
        setBusy(false);
        return;
      }
      corrections.push({ kind: "scene_boundary", issueId: selected.issueId, operation: "split_scene",
        sourceSceneId: element.sceneId, beforeElementId: selected.elementId,
        newSceneTitle: String(form.get("sceneBoundaryTitle") ?? "") });
    } else for (const issue of issues) {
      if (issue.kind === "unreadable_text") for (const elementId of issue.elementIds) corrections.push({
        kind: "unreadable_text", issueId: issue.id, elementId,
        text: String(form.get(`${issue.id}:${elementId}:text`) ?? ""),
      });
      if (issue.kind === "dialogue_owner") for (const elementId of issue.elementIds) corrections.push({
        kind: "dialogue_owner", issueId: issue.id, elementId,
        characterId: String(form.get(`${issue.id}:${elementId}:character`) ?? ""),
      });
      if (issue.kind === "character_name") corrections.push({
        kind: "character_name", issueId: issue.id,
        characterId: String(form.get(`${issue.id}:character`) ?? ""),
        name: String(form.get(`${issue.id}:name`) ?? ""), elementIds: issue.elementIds,
      });
    }
    const approve = !resolvingBoundary;
    try {
      const response = await fetch(`/api/plays/${playId}/review`, { method: "PATCH",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedModelId,
          expectedModelVersion, corrections, approve }) });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (response.ok) {
        window.location.assign(approve ? `/plays/${playId}/overview` : `/plays/${playId}/review`);
        return;
      }
      setMessage(result.error ?? (approve ? "Unable to approve this review" : "Unable to save this boundary"));
    } catch {
      setMessage("Unable to reach the review service. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return <form className="review-controls" onSubmit={submitReview}>
    <input type="hidden" name="expectedModelId" value={expectedModelId} />
    {resolvingBoundary ? <fieldset><legend>Choose one scene boundary</legend>
      <p>Save one split, then review the updated scene structure before continuing.</p>
      {boundaryIssues.flatMap((issue) => issue.elementIds.map((elementId) => <label key={`${issue.id}:${elementId}`}>
        <input type="radio" name="sceneBoundaryCandidate" value={JSON.stringify([issue.id, elementId])}
          disabled={!hydrated} required />
        Split before “{elementById.get(elementId)?.text ?? "Source passage unavailable"}”
      </label>))}
      <label>New scene title<input name="sceneBoundaryTitle" defaultValue="New scene" disabled={!hydrated} required /></label>
    </fieldset> : <>
    {issues.filter((issue) => issue.kind === "unreadable_text").flatMap((issue) => issue.elementIds.map((elementId) => (
      <label key={`${issue.id}:${elementId}`}>
        Correct passage <span className="stable-id">{issue.id}</span>
        <textarea name={`${issue.id}:${elementId}:text`} rows={3} defaultValue={elementById.get(elementId)?.text ?? ""}
          disabled={!hydrated} required />
      </label>
    )))}
    {issues.filter((issue) => issue.kind === "dialogue_owner").flatMap((issue) => issue.elementIds.map((elementId) => (
      <label key={`${issue.id}:${elementId}`}>
        Assign dialogue owner <span className="stable-id">{issue.id}</span>
        <select name={`${issue.id}:${elementId}:character`} defaultValue={elementById.get(elementId)?.characterId}
          disabled={!hydrated} required>
          {characters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
        </select>
      </label>
    )))}
    {issues.filter((issue) => issue.kind === "character_name").map((issue) => {
      const characterId = issue.elementIds.map((id) => elementById.get(id)?.characterId).find(Boolean) ?? "";
      return <fieldset key={issue.id}><legend>Correct character name <span className="stable-id">{issue.id}</span></legend>
        <label>Character<select name={`${issue.id}:character`} defaultValue={characterId} disabled={!hydrated} required>
          {characters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
        </select></label>
        <label>Correct name<input name={`${issue.id}:name`} defaultValue={characters.find(({ id }) => id === characterId)?.name}
          disabled={!hydrated} required /></label>
      </fieldset>;
    })}
    </>}
    <button type="submit" disabled={!hydrated || busy}>
      {busy ? (resolvingBoundary ? "Saving…" : "Approving…")
        : (resolvingBoundary ? "Save selected boundary" : "Approve corrected play")}
    </button>
    {message ? <p role="alert">{message}</p> : null}
  </form>;
}

function parseBoundarySelection(value: FormDataEntryValue | null): { issueId: string; elementId: string } | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.length === 2
      && typeof parsed[0] === "string" && typeof parsed[1] === "string"
      ? { issueId: parsed[0], elementId: parsed[1] }
      : null;
  } catch {
    return null;
  }
}
