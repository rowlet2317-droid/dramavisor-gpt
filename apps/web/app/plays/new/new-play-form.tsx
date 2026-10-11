"use client";

import { useEffect, useState, type FormEvent } from "react";

export function NewPlayForm() {
  const [source, setSource] = useState<"file" | "text">("file");
  const [message, setMessage] = useState("");
  const [reviewHref, setReviewHref] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => setHydrated(true), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage("");
    setReviewHref(null);
    const form = new FormData(event.currentTarget);
    const request = source === "file"
      ? { body: fileBody(form) }
      : { body: JSON.stringify({ pastedText: form.get("pastedText") }),
          headers: { "content-type": "application/json" } };
    try {
      const response = await fetch("/api/plays", { method: "POST", ...request });
      const result = await response.json().catch(() => ({})) as {
        play?: { id: string; title: string }; error?: string;
      };
      setMessage(response.ok ? `${result.play?.title ?? "Your play"} is processing.` : result.error ?? "Upload failed.");
      if (response.ok && result.play) setReviewHref(`/plays/${result.play.id}/review`);
    } catch {
      setMessage("Unable to reach the upload service. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return <main className="new-play-page">
    <a className="back-link" href="/plays">← Back to your plays</a>
    <section className="new-play-card"><header><p className="eyebrow">New rehearsal project</p>
    <h1>Add a play</h1>
    <p>Upload a private PDF, DOCX, or TXT file up to 25 MiB, or paste an English-language script.</p>
    </header><div className="source-tabs" role="group" aria-label="Script source">
      <button type="button" aria-pressed={source === "file"}
        onClick={() => setSource("file")}>Upload file</button>
      <button type="button" aria-pressed={source === "text"}
        onClick={() => setSource("text")}>Paste text</button>
    </div>
    <form onSubmit={submit}>
      {source === "file" ? <label>PDF, DOCX, or TXT<input name="file" type="file" disabled={!hydrated}
        accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
        required /></label> : <label>Script text<textarea name="pastedText" rows={18} disabled={!hydrated}
          required /></label>}
      <button type="submit" disabled={!hydrated || submitting}>{submitting ? "Adding…" : "Add play"}</button>
    </form>
    {message ? <p role="status">{message}</p> : null}
    {reviewHref ? <p><a href={reviewHref}>Review parser issues</a></p> : null}</section>
  </main>;
}

function fileBody(form: FormData): FormData {
  const body = new FormData();
  const file = form.get("file");
  if (file instanceof File) body.set("file", file);
  return body;
}
